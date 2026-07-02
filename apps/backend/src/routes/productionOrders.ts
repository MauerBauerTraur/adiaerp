/**
 * M5 — Production orders (spec section 4.6).
 *
 *   GET   /api/production-orders?status=    — list (RBAC + optional status filter)
 *   POST  /api/production-orders            — create (default status: 'new')
 *   PATCH /api/production-orders/:id        — transition status: 'in_progress' or 'done'
 *
 * The `done` flip runs the atomic BOM-consume + warehouse-produce flow
 * (`finishProductionOrder`) inside ONE transaction. If a BOM component is
 * short, the whole thing rolls back and the response is 409 INSUFFICIENT_STOCK
 * (AC5.2). When the order was raised by a replenishment request, the same
 * transaction also steps the request `PRODUCING -> DONE_TO_WAREHOUSE`
 * (AC5.3).
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize, authorizeWrite } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import {
  getPrincipal,
  isSuperAdmin,
  requireLocationOperator,
} from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  parseOptionalIdParam,
  requireEnum,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  finishProductionOrder,
  PRODUCTION_ORDER_COLUMNS,
  type ProductionOrderRow,
} from '../services/productionOrder.js';
import { advance } from '../services/replenishment.js';
import { applyMovement } from '../services/stockMovement.js';
import {
  createNotificationsForRecipients,
  getUsersByRole,
} from '../services/notify.js';

export const productionOrdersRouter: Router = Router();

const STATUSES = ['new', 'in_progress', 'done', 'cancelled'] as const;

// ---------------------------------------------------------------------------
// BOM expansion helpers (used by GET /:id/bom and GET /daily-dispatch)
// ---------------------------------------------------------------------------

type BomNode = {
  component_product_id: number;
  component_name: string;
  component_type: string;
  component_unit: string;
  cost_price: number | null;
  qty: number;
  brutto: number | null;
  stage: string | null;
  children: BomNode[];
};

type DispatchLine = {
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
};

async function expandBom(
  productId: number,
  scale: number,
  depth: number,
  maxDepth = 6,
): Promise<BomNode[]> {
  if (depth >= maxDepth) return [];
  const { rows } = await query<{
    component_product_id: number;
    component_name: string;
    component_type: string;
    component_unit: string;
    component_cost_price: number | null;
    qty_per_unit: number;
    brutto: number | null;
    stage: string | null;
  }>(
    `SELECT r.component_product_id,
            p.name       AS component_name,
            p.type       AS component_type,
            p.unit       AS component_unit,
            p.cost_price AS component_cost_price,
            r.qty_per_unit::float AS qty_per_unit,
            r.brutto::float       AS brutto,
            r.stage
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
      WHERE r.product_id = $1
      ORDER BY r.stage NULLS LAST, r.id`,
    [productId],
  );
  const nodes: BomNode[] = [];
  for (const row of rows) {
    const qty = Number(row.qty_per_unit) * scale;
    const brutto = row.brutto != null ? Number(row.brutto) * scale : null;
    const costPrice = row.component_cost_price !== null ? Number(row.component_cost_price) : null;
    let children: BomNode[] = [];
    if ((row.component_type === 'semi' || row.component_type === 'finished') && depth < maxDepth - 1) {
      // Use brutto as the child scale: it represents actual gross input into the next stage.
      const childScale = brutto != null && brutto > 0 ? brutto : qty;
      children = await expandBom(Number(row.component_product_id), childScale, depth + 1, maxDepth);
    }
    nodes.push({
      component_product_id: Number(row.component_product_id),
      component_name: row.component_name,
      component_type: row.component_type,
      component_unit: row.component_unit,
      cost_price: costPrice,
      qty,
      brutto,
      stage: row.stage,
      children,
    });
  }
  return nodes;
}

function collectRaw(nodes: BomNode[], map: Map<number, DispatchLine>): void {
  for (const node of nodes) {
    if (node.component_type === 'raw') {
      const dispatchQty = node.brutto != null && node.brutto > 0 ? node.brutto : node.qty;
      const existing = map.get(node.component_product_id);
      if (existing) {
        existing.qty += dispatchQty;
      } else {
        map.set(node.component_product_id, {
          product_id: node.component_product_id,
          product_name: node.component_name,
          product_unit: node.component_unit,
          qty: dispatchQty,
        });
      }
    }
    collectRaw(node.children, map);
  }
}

// GET /api/production-orders?status=&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
productionOrdersRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${STATUSES.join(', ')}.`);
    }
    const productIdParam = parseOptionalIdParam(
      typeof req.query.product_id === 'string' ? req.query.product_id : undefined,
      'product_id',
    );

    // Optional date-range filter.
    const fromDateRaw = typeof req.query.from_date === 'string' ? req.query.from_date : undefined;
    const toDateRaw = typeof req.query.to_date === 'string' ? req.query.to_date : undefined;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (fromDateRaw !== undefined && !datePattern.test(fromDateRaw)) {
      throw AppError.validation('Query "from_date" must be a date in YYYY-MM-DD format.');
    }
    if (toDateRaw !== undefined && !datePattern.test(toDateRaw)) {
      throw AppError.validation('Query "to_date" must be a date in YYYY-MM-DD format.');
    }

    // RBAC location filter: production_manager sees only its own production
    // location; pm sees the whole chain.
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`po.status = $${params.length}`);
    }
    if (productIdParam !== undefined) {
      params.push(productIdParam);
      conditions.push(`po.product_id = $${params.length}`);
    }
    if (fromDateRaw !== undefined && toDateRaw !== undefined) {
      params.push(fromDateRaw);
      const fromIdx = params.length;
      params.push(toDateRaw);
      const toIdx = params.length;
      conditions.push(`po.created_at::date BETWEEN $${fromIdx} AND $${toIdx}`);
    } else if (fromDateRaw !== undefined) {
      params.push(fromDateRaw);
      conditions.push(`po.created_at::date >= $${params.length}`);
    } else if (toDateRaw !== undefined) {
      params.push(toDateRaw);
      conditions.push(`po.created_at::date <= $${params.length}`);
    }
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(po.location_id = $${params.length} OR po.target_location_id = $${params.length})`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product + location names for the UI.
    const qualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ProductionOrderRow & {
        product_name: string;
        location_name: string | null;
        target_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              ll.name AS location_name,
              tl.name AS target_location_name
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations ll ON ll.id = po.location_id
       LEFT JOIN locations tl ON tl.id = po.target_location_id
       ${where}
       ORDER BY po.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// GET /api/production-orders/daily-dispatch?date=YYYY-MM-DD
//   OR ?from=YYYY-MM-DD&to=YYYY-MM-DD  (date range)
// Must be before /:id to prevent Express treating "daily-dispatch" as an id.
// Returns aggregated raw-material dispatch for all non-cancelled orders
// whose deadline (or creation date) falls within the requested date range.
productionOrdersRouter.get(
  '/daily-dispatch',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
    const dateRaw = typeof req.query.date === 'string' ? req.query.date : undefined;

    let fromDate: string;
    let toDate: string;

    if (fromRaw !== undefined || toRaw !== undefined) {
      // Range mode — both from and to required when using this mode
      if (fromRaw === undefined || !datePattern.test(fromRaw)) {
        throw AppError.validation('Query "from" must be a date in YYYY-MM-DD format.');
      }
      if (toRaw === undefined || !datePattern.test(toRaw)) {
        throw AppError.validation('Query "to" must be a date in YYYY-MM-DD format.');
      }
      fromDate = fromRaw;
      toDate = toRaw;
    } else if (dateRaw !== undefined) {
      // Backward-compat single-date mode
      if (!datePattern.test(dateRaw)) {
        throw AppError.validation('Query "date" must be a date in YYYY-MM-DD format.');
      }
      fromDate = dateRaw;
      toDate = dateRaw;
    } else {
      // Default to today
      fromDate = today;
      toDate = today;
    }

    const { rows: orderRows } = await query<{
      id: number;
      product_id: number;
      qty: number;
      product_name: string;
      location_name: string;
      product_type: string;
    }>(
      `SELECT po.id, po.product_id, po.qty::float AS qty,
              p.name AS product_name, l.name AS location_name,
              p.type AS product_type
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations l ON l.id = po.location_id
        WHERE po.status NOT IN ('cancelled','done')
          AND (
            (po.deadline BETWEEN $1 AND $2)
            OR (po.deadline IS NULL AND po.created_at::date BETWEEN $1 AND $2)
          )
        ORDER BY po.id`,
      [fromDate, toDate],
    );

    const dispatchMap = new Map<number, DispatchLine>();
    for (const order of orderRows) {
      const bom = await expandBom(Number(order.product_id), Number(order.qty), 0);
      collectRaw(bom, dispatchMap);
    }
    const dispatch = [...dispatchMap.values()].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );

    // Also fetch tracked dispatch items — with location names/types for grouping and role checks.
    // po_product_type = type of the production ORDER's main product (used for page routing on frontend).
    const { rows: dispatchItems } = await query(
      `SELECT pd.*,
              tl.name  AS to_location_name,
              fl.name  AS from_location_name,
              fl.type  AS from_location_type,
              p.type   AS product_type,
              po_p.type AS po_product_type
       FROM production_dispatches pd
       JOIN production_orders po  ON po.id  = pd.production_order_id
       JOIN products p            ON p.id   = pd.product_id
       JOIN products po_p         ON po_p.id = po.product_id
       LEFT JOIN locations tl ON tl.id = pd.to_location_id
       LEFT JOIN locations fl ON fl.id = pd.from_location_id
       WHERE po.status NOT IN ('cancelled', 'done')
         AND (
           (po.deadline BETWEEN $1 AND $2)
           OR (po.deadline IS NULL AND po.created_at::date BETWEEN $1 AND $2)
         )
       ORDER BY tl.name NULLS LAST, pd.product_name, pd.id`,
      [fromDate, toDate],
    );

    res.status(200).json({
      date: fromDate === toDate ? fromDate : undefined,
      from: fromDate,
      to: toDate,
      orders: orderRows,
      dispatch,
      dispatch_items: dispatchItems,
    });
  }),
);

// GET /api/production-orders/bom-preview?product_id=X&qty=Y
// Must be before /:id. Returns recursive BOM + dispatch summary for a
// product/qty combo so the creation form can show a live material preview.
productionOrdersRouter.get(
  '/bom-preview',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const productIdRaw = typeof req.query.product_id === 'string' ? req.query.product_id : '';
    const productId = parseIdParam(productIdRaw, 'product_id');
    const qty = Number(req.query.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw AppError.validation('Query "qty" must be a positive number.');
    }

    // Verify the product exists
    const { rows: pRows } = await query<{ id: number }>(
      'SELECT id FROM products WHERE id = $1',
      [productId],
    );
    if (pRows.length === 0) throw AppError.notFound('Product not found.');

    const bom = await expandBom(productId, qty, 0);
    const dispatchMap = new Map<number, DispatchLine>();
    collectRaw(bom, dispatchMap);
    const dispatch = [...dispatchMap.values()].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );

    // Prefer the product's fixed production_location_id; fall back to most-recently-used.
    const { rows: suggestRows } = await query<{ production_location_id: number | null }>(
      `SELECT production_location_id FROM products WHERE id = $1`,
      [productId],
    );
    let suggested_location_id: number | null = suggestRows[0]?.production_location_id ?? null;
    if (suggested_location_id === null) {
      const { rows: histRows } = await query<{ location_id: number }>(
        `SELECT location_id FROM production_orders
         WHERE product_id = $1 AND status != 'cancelled'
         ORDER BY created_at DESC LIMIT 1`,
        [productId],
      );
      suggested_location_id = histRows[0]?.location_id ?? null;
    }

    res.status(200).json({ bom, dispatch, suggested_location_id });
  }),
);

// GET /api/production-orders/:id
productionOrdersRouter.get(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id, 'id');
    const qualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ProductionOrderRow & {
        product_name: string;
        product_unit: string;
        location_name: string | null;
        target_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name, p.unit AS product_unit,
              ll.name AS location_name,
              tl.name AS target_location_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations ll ON ll.id = po.location_id
         LEFT JOIN locations tl ON tl.id = po.target_location_id
        WHERE po.id = $1`,
      [orderId],
    );
    const order = rows[0];
    if (!order) throw AppError.notFound('Production order not found.');

    const subQualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows: subOrders } = await query<
      ProductionOrderRow & { product_name: string; product_unit: string; location_name: string | null }
    >(
      `SELECT ${subQualifiedCols},
              p.name AS product_name, p.unit AS product_unit,
              ll.name AS location_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations ll ON ll.id = po.location_id
        WHERE po.parent_production_order_id = $1
        ORDER BY po.id`,
      [orderId],
    );

    res.status(200).json({ order, sub_orders: subOrders });
  }),
);

// GET /api/production-orders/:id/bom
productionOrdersRouter.get(
  '/:id/bom',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id, 'id');
    const qualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ProductionOrderRow & {
        product_name: string;
        product_unit: string;
        location_name: string | null;
        target_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name, p.unit AS product_unit,
              ll.name AS location_name,
              tl.name AS target_location_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations ll ON ll.id = po.location_id
         LEFT JOIN locations tl ON tl.id = po.target_location_id
        WHERE po.id = $1`,
      [orderId],
    );
    const order = rows[0];
    if (!order) throw AppError.notFound('Production order not found.');

    const bom = await expandBom(Number(order.product_id), Number(order.qty), 0);
    const dispatchMap = new Map<number, DispatchLine>();
    collectRaw(bom, dispatchMap);
    const dispatch = [...dispatchMap.values()].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );

    const subQualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows: subOrders } = await query<
      ProductionOrderRow & { product_name: string; product_unit: string; location_name: string | null }
    >(
      `SELECT ${subQualifiedCols},
              p.name AS product_name, p.unit AS product_unit,
              ll.name AS location_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations ll ON ll.id = po.location_id
        WHERE po.parent_production_order_id = $1
        ORDER BY po.id`,
      [orderId],
    );

    res.status(200).json({ order, bom, dispatch, sub_orders: subOrders });
  }),
);

// ---------------------------------------------------------------------------
// Dispatch management routes
// Must be ordered BEFORE /:id to avoid Express treating literal "dispatches"
// as an id. The 2+ segment paths (/dispatches/…) won't conflict with /:id
// (1 segment), but explicit ordering is safest.
// ---------------------------------------------------------------------------

// GET /api/production-orders/:id/dispatches
// Returns tracked dispatch items for a specific order.
productionOrdersRouter.get(
  '/:id/dispatches',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id, 'id');
    const { rows } = await query(
      `SELECT * FROM production_dispatches
       WHERE production_order_id = $1
          OR production_order_id IN (
            SELECT id FROM production_orders WHERE parent_production_order_id = $1
          )
       ORDER BY production_order_id, product_name, id`,
      [orderId],
    );
    res.status(200).json(rows);
  }),
);

// PATCH /api/production-orders/dispatches/:dispatch_id/dispatch
// Stock moves FROM source AT dispatch time (not receive time).
productionOrdersRouter.patch(
  '/dispatches/:dispatch_id/dispatch',
  authenticate,
  authorize('pm', 'raw_warehouse_manager', 'production_manager'),
  asyncHandler(async (req, res) => {
    const dispatchId = parseIdParam(req.params.dispatch_id, 'dispatch_id');
    const principal = getPrincipal(req);
    const { rows } = await query<{
      id: number; production_order_id: number; product_id: number;
      qty_needed: string; from_location_id: number | null; to_location_id: number | null;
    }>(
      `UPDATE production_dispatches
       SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [dispatchId, principal.userId],
    );
    if (!rows[0]) {
      throw AppError.validation("Yozuv topilmadi yoki allaqachon 'berildi' deb belgilangan.");
    }
    const dispatch = rows[0];
    let movementId: number | null = null;
    const fromLoc = dispatch.from_location_id;
    const toLoc = dispatch.to_location_id;
    if (fromLoc !== null && toLoc !== null && fromLoc !== toLoc) {
      const result = await applyMovement({
        productId: Number(dispatch.product_id),
        fromLocationId: Number(fromLoc),
        toLocationId: Number(toLoc),
        qty: Number(dispatch.qty_needed),
        reason: 'transfer',
        actorUserId: principal.userId,
        productionOrderId: Number(dispatch.production_order_id),
        allowNegative: true,
      });
      movementId = result.movementId;
      await query(
        `UPDATE production_dispatches SET movement_id = $2 WHERE id = $1`,
        [dispatch.id, movementId],
      );
    }
    res.status(200).json({ ...dispatch, movement_id: movementId });
  }),
);

// PATCH /api/production-orders/dispatches/:dispatch_id/receive
// production_manager receives raw/semi inputs; central_warehouse_manager receives finished goods.
productionOrdersRouter.patch(
  '/dispatches/:dispatch_id/receive',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const dispatchId = parseIdParam(req.params.dispatch_id, 'dispatch_id');
    const principal = getPrincipal(req);

    const { rows: dRows } = await query<{
      id: number;
      production_order_id: number;
      product_id: number;
      qty_needed: number;
      status: string;
      from_location_id: number | null;
      to_location_id: number | null;
      movement_id: number | null;
    }>(
      `SELECT id, production_order_id, product_id, qty_needed::float AS qty_needed,
              status, from_location_id, to_location_id, movement_id
       FROM production_dispatches WHERE id = $1`,
      [dispatchId],
    );
    const dispatch = dRows[0];
    if (!dispatch) throw AppError.notFound('Dispatch record not found.');
    if (dispatch.status !== 'dispatched') {
      throw AppError.validation("Faqat 'berildi' holatidagi yozuvni qabul qilish mumkin.");
    }

    // Apply the transfer movement here (production → warehouse). movement_id
    // is null for normal output dispatches; non-null only for legacy records
    // that had their movement applied at dispatch time.
    let movementId: number | null = dispatch.movement_id;
    if (movementId === null) {
      const fromLoc = dispatch.from_location_id;
      const toLoc = dispatch.to_location_id;
      if (fromLoc !== null && toLoc !== null && fromLoc !== toLoc) {
        const result = await applyMovement({
          productId: Number(dispatch.product_id),
          fromLocationId: Number(fromLoc),
          toLocationId: Number(toLoc),
          qty: Number(dispatch.qty_needed),
          reason: 'transfer',
          actorUserId: principal.userId,
          productionOrderId: Number(dispatch.production_order_id),
          allowNegative: true,
        });
        movementId = result.movementId;
      }
    }

    const { rows } = await query(
      `UPDATE production_dispatches
       SET status = 'received', received_at = NOW(), received_by = $2, movement_id = $3
       WHERE id = $1
       RETURNING *`,
      [dispatchId, principal.userId, movementId],
    );
    res.status(200).json(rows[0]);
  }),
);

// PATCH /api/production-orders/dispatches/batch-dispatch
// Warehouse bulk-marks pending dispatches as "berildi"; production_manager for finished goods.
// Body: { ids: number[] }  → dispatch those specific items
// OR query: ?date=YYYY-MM-DD  → dispatch all pending for that date
productionOrdersRouter.patch(
  '/dispatches/batch-dispatch',
  authenticate,
  authorize('pm', 'raw_warehouse_manager', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const bodyIds: unknown = req.body?.ids;

    type DispatchRow = {
      id: number; production_order_id: number; product_id: number;
      qty_needed: number; from_location_id: number | null; to_location_id: number | null;
    };
    let rows: DispatchRow[];
    if (Array.isArray(bodyIds) && bodyIds.length > 0) {
      // ID-based: dispatch exactly the given items (must be pending)
      const ids = bodyIds.map(Number).filter(Number.isFinite);
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      ({ rows } = await query<DispatchRow>(
        `UPDATE production_dispatches
         SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $1
         WHERE id IN (${placeholders}) AND status = 'pending'
         RETURNING id, production_order_id, product_id,
                   qty_needed::float AS qty_needed, from_location_id, to_location_id`,
        [principal.userId, ...ids],
      ));
    } else {
      // Date-based fallback: dispatch all pending for the date
      const dateParam =
        typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
          ? req.query.date
          : new Date().toISOString().slice(0, 10);
      ({ rows } = await query<DispatchRow>(
        `UPDATE production_dispatches pd
         SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $2
         FROM production_orders po
         WHERE pd.production_order_id = po.id
           AND pd.status = 'pending'
           AND po.status NOT IN ('cancelled', 'done')
           AND (po.deadline = $1 OR (po.deadline IS NULL AND po.created_at::date = $1))
         RETURNING pd.id, pd.production_order_id, pd.product_id,
                   pd.qty_needed::float AS qty_needed, pd.from_location_id, pd.to_location_id`,
        [dateParam, principal.userId],
      ));
    }
    // Apply stock movement for each dispatched item.
    for (const d of rows) {
      const fromLoc = d.from_location_id;
      const toLoc = d.to_location_id;
      if (fromLoc !== null && toLoc !== null && fromLoc !== toLoc) {
        try {
          const result = await applyMovement({
            productId: Number(d.product_id),
            fromLocationId: Number(fromLoc),
            toLocationId: Number(toLoc),
            qty: Number(d.qty_needed),
            reason: 'transfer',
            actorUserId: principal.userId,
            productionOrderId: Number(d.production_order_id),
            allowNegative: true,
          });
          await query(
            `UPDATE production_dispatches SET movement_id = $2 WHERE id = $1`,
            [d.id, result.movementId],
          );
        } catch {
          // Log but don't abort the batch; status is already 'dispatched'
        }
      }
    }
    res.status(200).json({ dispatched: rows.length });
  }),
);

// PATCH /api/production-orders/dispatches/batch-receive
// production_manager receives raw/semi inputs; central_warehouse_manager receives finished goods.
// Body: { ids: number[] }  → receive those specific items
// OR query: ?date=YYYY-MM-DD  → receive all dispatched for that date
productionOrdersRouter.patch(
  '/dispatches/batch-receive',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const bodyIds: unknown = req.body?.ids;

    type ReceiveRow = {
      id: number; production_order_id: number; product_id: number;
      qty_needed: number; from_location_id: number | null;
      to_location_id: number | null; movement_id: number | null;
    };
    let itemRows: ReceiveRow[];

    if (Array.isArray(bodyIds) && bodyIds.length > 0) {
      const ids = bodyIds.map(Number).filter(Number.isFinite);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      ({ rows: itemRows } = await query<ReceiveRow>(
        `SELECT id, production_order_id, product_id, qty_needed::float AS qty_needed,
                from_location_id, to_location_id, movement_id
           FROM production_dispatches
          WHERE id IN (${placeholders}) AND status = 'dispatched'`,
        ids,
      ));
    } else {
      const dateParam =
        typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
          ? req.query.date
          : new Date().toISOString().slice(0, 10);
      ({ rows: itemRows } = await query<ReceiveRow>(
        `SELECT pd.id, pd.production_order_id, pd.product_id,
                pd.qty_needed::float AS qty_needed,
                pd.from_location_id, pd.to_location_id, pd.movement_id
           FROM production_dispatches pd
           JOIN production_orders po ON po.id = pd.production_order_id
          WHERE pd.status = 'dispatched'
            AND po.status NOT IN ('cancelled', 'done')
            AND (po.deadline = $1 OR (po.deadline IS NULL AND po.created_at::date = $1))`,
        [dateParam],
      ));
    }

    let received = 0;
    for (const dispatch of itemRows) {
      // Only apply movement if not already applied at dispatch time.
      let movementId: number | null = dispatch.movement_id;
      if (movementId === null) {
        const fromLoc = dispatch.from_location_id;
        const toLoc = dispatch.to_location_id;
        if (fromLoc !== null && toLoc !== null && fromLoc !== toLoc) {
          const result = await applyMovement({
            productId: Number(dispatch.product_id),
            fromLocationId: Number(fromLoc),
            toLocationId: Number(toLoc),
            qty: Number(dispatch.qty_needed),
            reason: 'transfer',
            actorUserId: principal.userId,
            productionOrderId: Number(dispatch.production_order_id),
            allowNegative: true,
          });
          movementId = result.movementId;
        }
      }
      await query(
        `UPDATE production_dispatches
         SET status = 'received', received_at = NOW(), received_by = $2, movement_id = $3
         WHERE id = $1`,
        [dispatch.id, principal.userId, movementId],
      );
      received++;
    }
    res.status(200).json({ received });
  }),
);

// POST /api/production-orders/backfill-dispatches?date=YYYY-MM-DD
// Creates dispatch records from BOM for all orders of a given date.
// Step 1 (raw): raw-material dispatches for orders with NO dispatch records yet.
// Step 2 (output): output dispatch (sex → target) for semi/finished orders missing that record.
productionOrdersRouter.post(
  '/backfill-dispatches',
  authenticate,
  authorize('pm', 'raw_warehouse_manager', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const dateParam =
      typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : new Date().toISOString().slice(0, 10);

    // ── Step 1: raw-material dispatches for orders with no dispatch records at all ──
    const { rows: orderRows } = await query<{
      id: number;
      product_id: number;
      qty: number;
      location_id: number;
      target_location_id: number | null;
    }>(
      `SELECT po.id, po.product_id, po.qty::float AS qty, po.location_id, po.target_location_id
       FROM production_orders po
       WHERE po.status NOT IN ('cancelled','done')
         AND (po.deadline = $1 OR (po.deadline IS NULL AND po.created_at::date = $1))
         AND NOT EXISTS (
           SELECT 1 FROM production_dispatches pd WHERE pd.production_order_id = po.id
         )`,
      [dateParam],
    );

    const { rows: rawWhRows } = await query<{ id: number }>(
      `SELECT id FROM locations WHERE type = 'raw_warehouse' LIMIT 1`,
      [],
    );
    const rawWarehouseId = rawWhRows[0]?.id ?? null;

    let created = 0;
    for (const order of orderRows) {
      try {
        const bom = await expandBom(Number(order.product_id), Number(order.qty), 0);
        const rawMap = new Map<number, DispatchLine>();
        collectRaw(bom, rawMap);
        for (const line of rawMap.values()) {
          await query(
            `INSERT INTO production_dispatches
               (production_order_id, product_id, product_name, product_unit,
                qty_needed, from_location_id, to_location_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [order.id, line.product_id, line.product_name, line.product_unit,
             line.qty, rawWarehouseId, order.location_id],
          );
          created++;
        }
      } catch {
        // Skip orders where BOM expansion fails
      }
    }

    // ── Step 2: output dispatch for semi/finished orders missing it ──
    // This runs regardless of whether raw-material dispatches exist for the order,
    // so it works even after Step 1 has already run on a previous call.
    const { rows: centralWhRows } = await query<{ id: number }>(
      `SELECT id FROM locations WHERE type = 'central_warehouse' LIMIT 1`,
      [],
    );
    const centralWarehouseId = centralWhRows[0]?.id ?? null;

    const { rows: outputOrders } = await query<{
      id: number;
      product_id: number;
      qty: number;
      location_id: number;
      target_location_id: number | null;
      product_name: string;
      product_unit: string;
      product_type: string;
    }>(
      `SELECT po.id, po.product_id, po.qty::float AS qty, po.location_id, po.target_location_id,
              p.name AS product_name, p.unit AS product_unit, p.type AS product_type
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       WHERE po.status NOT IN ('cancelled','done')
         AND p.type IN ('semi','finished')
         AND (po.deadline = $1 OR (po.deadline IS NULL AND po.created_at::date = $1))
         AND NOT EXISTS (
           SELECT 1 FROM production_dispatches pd
           WHERE pd.production_order_id = po.id
             AND pd.product_id = po.product_id
         )`,
      [dateParam],
    );

    for (const order of outputOrders) {
      // For finished products default to central warehouse; semi can go to target or null.
      const toLocId =
        order.target_location_id ??
        (order.product_type === 'finished' ? centralWarehouseId : null);
      await query(
        `INSERT INTO production_dispatches
           (production_order_id, product_id, product_name, product_unit,
            qty_needed, from_location_id, to_location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, order.product_id, order.product_name, order.product_unit,
         order.qty, order.location_id, toLocId],
      );
      created++;
    }

    res.status(200).json({ orders: orderRows.length + outputOrders.length, dispatch_records_created: created, date: dateParam });
  }),
);

// POST /api/production-orders/backfill-finished-dispatches
// Creates missing "tayyor mahsulot" dispatch records for final orders that have target_location_id set
// but don't yet have a dispatch record for the finished product itself.
productionOrdersRouter.post(
  '/backfill-finished-dispatches',
  authenticate,
  authorize('pm'),
  asyncHandler(async (_req, res) => {
    const { rows: orderRows } = await query<{
      id: number;
      product_id: number;
      qty: number;
      location_id: number;
      target_location_id: number;
    }>(
      `SELECT po.id, po.product_id, po.qty::float AS qty, po.location_id, po.target_location_id
       FROM production_orders po
       WHERE po.status NOT IN ('cancelled', 'done')
         AND po.target_location_id IS NOT NULL
         AND (po.stage_role = 'final' OR po.stage_role IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM production_dispatches pd
            WHERE pd.production_order_id = po.id
              AND pd.product_id = po.product_id
         )`,
    );

    let created = 0;
    for (const order of orderRows) {
      try {
        const { rows: pRows } = await query<{ name: string; unit: string }>(
          `SELECT name, unit FROM products WHERE id = $1`, [order.product_id],
        );
        const p = pRows[0];
        if (p) {
          await query(
            `INSERT INTO production_dispatches
               (production_order_id, product_id, product_name, product_unit,
                qty_needed, from_location_id, to_location_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [order.id, order.product_id, p.name, p.unit, order.qty,
             order.location_id, order.target_location_id],
          );
          created++;
        }
      } catch {
        // Skip on error
      }
    }

    res.status(200).json({ orders: orderRows.length, dispatch_records_created: created });
  }),
);

// POST /api/production-orders/:id/dispatches/dispatch-all
// Bulk mark all pending dispatches for ONE order as "berildi".
productionOrdersRouter.post(
  '/:id/dispatches/dispatch-all',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id, 'id');
    const principal = getPrincipal(req);
    const { rows } = await query(
      `UPDATE production_dispatches
       SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $2
       WHERE production_order_id = $1 AND status = 'pending'
       RETURNING *`,
      [orderId, principal.userId],
    );
    res.status(200).json({ dispatched: rows.length });
  }),
);

// POST /api/production-orders
//
// PM (chain-wide super-admin) may now create production orders; no location
// ownership check is applied since PM sees the full chain. Location-scoped
// roles (production_manager, central_warehouse_manager) retain their checks.
productionOrdersRouter.post(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const locationId = requireId(body, 'location_id');
    const targetLocationId = optionalId(body, 'target_location_id') ?? null;
    const deadlineRaw = optionalString(body, 'deadline') ?? null;
    if (deadlineRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) {
      throw AppError.validation('Field "deadline" must be an ISO date (YYYY-MM-DD).');
    }
    const note = optionalString(body, 'note') ?? null;

    // PM is chain-wide — no location ownership check.
    // Location-scoped roles verify ownership of the relevant location.
    if (!isSuperAdmin(principal)) {
      if (principal.role === 'production_manager') {
        await requireLocationOperator(principal, locationId);
      } else {
        // central_warehouse_manager — anchor on target_location_id if set
        const anchor = targetLocationId ?? locationId;
        await requireLocationOperator(principal, anchor);
      }
    }

    const inserted = await withTransaction(async (tx) => {
      const { rows } = await tx.query<ProductionOrderRow>(
        `INSERT INTO production_orders
           (product_id, qty, location_id, target_location_id, deadline, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
        [productId, qty, locationId, targetLocationId, deadlineRaw, note, principal.userId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.internal('Production order insert returned no row.');
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'production_order.create',
        entity: 'production_orders',
        entityId: row.id,
        payload: { product_id: productId, qty, location_id: locationId },
      });
      // M9 — production_order_created notification (spec §7). Notify every
      // active production_manager so the production location is informed
      // immediately, plus all `pm` users (super-admin visibility). The
      // notification participates in the SAME transaction as the insert.
      const productionManagers = await getUsersByRole(tx, 'production_manager');
      const pms = await getUsersByRole(tx, 'pm');
      const recipients = [...productionManagers, ...pms];
      if (recipients.length > 0) {
        const { rows: ctx } = await tx.query<{ product_name: string; product_unit: string }>(
          `SELECT name AS product_name, unit AS product_unit
             FROM products WHERE id = $1`,
          [productId],
        );
        const productName = ctx[0]?.product_name ?? `#${productId}`;
        const productUnit = ctx[0]?.product_unit ?? '';
        await createNotificationsForRecipients(tx, recipients, {
          type: 'production_order_created',
          title: `Yangi zayafka #${row.id}`,
          body:
            `Zayafka #${row.id}: ${qty} ${productUnit} ${productName} — ` +
            `ishlab chiqarish kerak.`,
          payload: {
            production_order_id: row.id,
            product_id: productId,
            qty,
            location_id: locationId,
          },
          // F3.3 / ADR-0011 — Boshladim flips status `new -> in_progress`;
          // the dispatcher enforces production_manager scope before the
          // domain service runs.
          inlineCallback: {
            buttons: [
              [
                { text: '▶️ Boshladim', data: `start:prod:${row.id}` },
                { text: "📋 Ko'rish", data: `view:prod:${row.id}` },
              ],
            ],
          },
        });
      }
      return row;
    });

    // Auto-create dispatch records for raw materials DIRECTLY consumed by this
    // order (not recursing into semi-finished — each sub-order gets its own
    // dispatch records pointing to its own production location).
    const { rows: rawWhRows } = await query<{ id: number }>(
      `SELECT id FROM locations WHERE type = 'raw_warehouse' LIMIT 1`,
      [],
    );
    const rawWarehouseId = rawWhRows[0]?.id ?? null;

    async function createDispatchRecords(
      orderId: number,
      bomNodes: BomNode[],
      toLocationId: number,
    ): Promise<void> {
      const directRawMap = new Map<number, DispatchLine>();
      for (const node of bomNodes) {
        if (node.component_type === 'raw') {
          const dispatchQty = node.brutto != null && node.brutto > 0 ? node.brutto : node.qty;
          const existing = directRawMap.get(node.component_product_id);
          if (existing) {
            existing.qty += dispatchQty;
          } else {
            directRawMap.set(node.component_product_id, {
              product_id: node.component_product_id,
              product_name: node.component_name,
              product_unit: node.component_unit,
              qty: dispatchQty,
            });
          }
        } else if (node.component_type === 'semi' || node.component_type === 'finished') {
          // Cross-location transfer only: semi-finished dispatched only when it
          // arrives FROM a different location. Same-location components are
          // produced in-house by the same workshop — no dispatch record needed.
          const { rows: semiLocRows } = await query<{ production_location_id: number | null }>(
            `SELECT production_location_id FROM products WHERE id = $1`,
            [node.component_product_id],
          );
          const fromLocId = semiLocRows[0]?.production_location_id ?? null;
          if (fromLocId !== null && fromLocId !== toLocationId) {
            await query(
              `INSERT INTO production_dispatches
                 (production_order_id, product_id, product_name, product_unit,
                  qty_needed, from_location_id, to_location_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [orderId, node.component_product_id, node.component_name, node.component_unit,
               node.qty, fromLocId, toLocationId],
            );
          }
        }
      }
      for (const line of directRawMap.values()) {
        await query(
          `INSERT INTO production_dispatches
             (production_order_id, product_id, product_name, product_unit,
              qty_needed, from_location_id, to_location_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, line.product_id, line.product_name, line.product_unit,
           line.qty, rawWarehouseId, toLocationId],
        );
      }
    }

    try {
      const mainBomForDispatch = await expandBom(productId, qty, 0);
      await createDispatchRecords(inserted.id, mainBomForDispatch, locationId);

      // Finished-product tracking dispatch: production location → target (storage) location.
      // Created even when from==to so the "Tayyor mahsulot" tab always has data to display.
      if (targetLocationId !== null) {
        const { rows: pRows } = await query<{ name: string; unit: string }>(
          `SELECT name, unit FROM products WHERE id = $1`,
          [productId],
        );
        const p = pRows[0];
        if (p) {
          await query(
            `INSERT INTO production_dispatches
               (production_order_id, product_id, product_name, product_unit,
                qty_needed, from_location_id, to_location_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [inserted.id, productId, p.name, p.unit, qty, locationId, targetLocationId],
          );
        }
      }
    } catch {
      // Dispatch record creation failure does not fail the main order
    }

    // Auto-create sub-orders (recursively) for semi-finished components.
    const subOrders: ProductionOrderRow[] = [];
    const stockNotes: { product_id: number; product_name: string; available: number; needed: number }[] = [];

    // Global zagatovka location fallback (used when product has no production_location_id).
    let defaultSubLocationId: number = locationId;
    try {
      const { rows: zagLocRows } = await query<{ id: number }>(
        `SELECT id FROM locations WHERE stage_role = 'zagatovka' LIMIT 1`,
        [],
      );
      if (zagLocRows[0]?.id) defaultSubLocationId = zagLocRows[0].id;
    } catch {
      // stage_role column not yet available — use fallback
    }

    // Recursively creates sub-orders for each semi-finished BOM node.
    // Uses the component product's production_location_id if set; otherwise
    // falls back to defaultSubLocationId (global zagatovka sex).
    async function createSubOrdersFromBom(
      bomNodes: BomNode[],
      parentOrderId: number,
      depth: number,
    ): Promise<void> {
      if (depth >= 5) return;
      for (const node of bomNodes) {
        if (node.component_type !== 'semi' && node.component_type !== 'finished') continue;

        // Resolve this component's designated production location.
        const { rows: prodLocRows } = await query<{ production_location_id: number | null }>(
          `SELECT production_location_id FROM products WHERE id = $1`,
          [node.component_product_id],
        );
        const subLocationId = prodLocRows[0]?.production_location_id ?? defaultSubLocationId;

        // Check stock of this component at its target production location.
        const { rows: stockRows } = await query<{ qty: string }>(
          `SELECT COALESCE(qty, 0)::text AS qty FROM stock
           WHERE location_id = $1 AND product_id = $2`,
          [subLocationId, node.component_product_id],
        );
        // Clamp to zero: negative stock (data anomaly) must not inflate sub-order qty.
        const available = Math.max(0, Number(stockRows[0]?.qty ?? 0));
        // Use brutto: the gross input amount the parent stage requires.
        const neededQty = node.brutto != null && node.brutto > 0 ? node.brutto : node.qty;

        if (available >= neededQty) {
          stockNotes.push({
            product_id: node.component_product_id,
            product_name: node.component_name,
            available,
            needed: neededQty,
          });
          continue;
        }

        const subQty = neededQty - available;
        const subOrder = await withTransaction(async (tx) => {
          const { rows } = await tx.query<ProductionOrderRow>(
            `INSERT INTO production_orders
               (product_id, qty, location_id, target_location_id, note,
                stage_role, parent_production_order_id, created_by)
             VALUES ($1, $2, $3, $4, $5, 'zagatovka', $6, $7)
             RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
            [
              node.component_product_id,
              subQty,
              subLocationId,
              null,
              `Avtomat: #${parentOrderId} uchun (${node.component_name})`,
              parentOrderId,
              principal.userId,
            ],
          );
          const subRow = rows[0];
          if (subRow === undefined) throw AppError.internal('Sub-order insert returned no row.');
          await writeAudit(tx, {
            actorUserId: principal.userId,
            action: 'production_order.create',
            entity: 'production_orders',
            entityId: subRow.id,
            payload: {
              product_id: node.component_product_id,
              qty: subQty,
              location_id: subLocationId,
              parent_production_order_id: parentOrderId,
              auto: true,
            },
          });
          // Send notification for this sub-order just like the main order.
          const subManagers = await getUsersByRole(tx, 'production_manager');
          const subPms = await getUsersByRole(tx, 'pm');
          const subRecipients = [...subManagers, ...subPms];
          if (subRecipients.length > 0) {
            await createNotificationsForRecipients(tx, subRecipients, {
              type: 'production_order_created',
              title: `Yangi zayafka #${subRow.id}`,
              body:
                `Zayafka #${subRow.id}: ${subQty} ${node.component_unit} ` +
                `${node.component_name} — ishlab chiqarish kerak.`,
              payload: {
                production_order_id: subRow.id,
                product_id: node.component_product_id,
                qty: subQty,
                location_id: subLocationId,
                parent_production_order_id: parentOrderId,
              },
              inlineCallback: {
                buttons: [
                  [
                    { text: '▶️ Boshladim', data: `start:prod:${subRow.id}` },
                    { text: "📋 Ko'rish", data: `view:prod:${subRow.id}` },
                  ],
                ],
              },
            });
          }
          return subRow;
        });
        subOrders.push(subOrder);

        // Re-expand BOM for the sub-order at the actual deficit qty.
        const subBom = await expandBom(node.component_product_id, subQty, 0);

        // Create dispatch records for this sub-order's DIRECT raw materials,
        // pointing to the sub-order's production location.
        try {
          await createDispatchRecords(subOrder.id, subBom, subLocationId);
        } catch {
          // Dispatch record failure doesn't abort sub-order creation
        }

        // Recursively create sub-orders for nested semi-finished children.
        await createSubOrdersFromBom(subBom, subOrder.id, depth + 1);
      }
    }

    try {
      const mainBom = await expandBom(productId, qty, 0);
      await createSubOrdersFromBom(mainBom, inserted.id, 0);
    } catch {
      // Sub-order creation failure does not fail the main order
    }

    res.status(201).json({ production_order: inserted, sub_orders: subOrders, stock_notes: stockNotes });
  }),
);

// PATCH /api/production-orders/:id
// PM (chain-wide) may transition any order. Location-scoped roles
// (production_manager) must own the order's production location.
productionOrdersRouter.patch(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const nextStatus = requireEnum(body, 'status', ['in_progress', 'done', 'cancelled'] as const);

    const { rows: scopeRows } = await query<{ location_id: number }>(
      'SELECT location_id FROM production_orders WHERE id = $1',
      [orderId],
    );
    const existing = scopeRows[0];
    if (existing === undefined) {
      throw AppError.notFound('Production order not found.');
    }
    // PM is chain-wide — no location ownership check.
    if (!isSuperAdmin(principal)) {
      await requireLocationOperator(principal, Number(existing.location_id));
    }

    if (nextStatus === 'done') {
      // AC5.3 — the whole "tayyor" flow + the replenishment advance commit
      // together. `advance(id, actor, tx)` re-uses the outer tx so the
      // request hop is part of the same atomic unit as the BOM consumption.
      const result = await withTransaction(async (tx) => {
        const updated = await finishProductionOrder(orderId, principal.userId, tx);
        if (updated.replenishment_id !== null) {
          await advance(updated.replenishment_id, principal.userId, tx);
        }
        return updated;
      });

      // Auto-dispatch: mark the finished-product output dispatch as 'dispatched'
      // WITHOUT applying a stock movement. The production_output movement above
      // already put the product at the production location. The stock transfer
      // to the target warehouse happens when central_warehouse_manager clicks
      // "Qabul qilindi" (dispatch receive), which applies movement_id = null path.
      const { rows: finishedDispatches } = await query<{ id: number }>(
        `SELECT id FROM production_dispatches
          WHERE production_order_id = $1
            AND product_id = $2
            AND status = 'pending'`,
        [orderId, result.product_id],
      );
      for (const d of finishedDispatches) {
        try {
          await query(
            `UPDATE production_dispatches
             SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $2, movement_id = NULL
             WHERE id = $1`,
            [d.id, principal.userId],
          );
        } catch {
          // Don't abort the order completion if finished-dispatch update fails
        }
      }

      res.status(200).json({ production_order: result });
      return;
    }

    if (nextStatus === 'cancelled') {
      // ADR-0001 §11 — a production order can be cancelled only from `new`
      // or `in_progress`. `done` already applied the stock movements so its
      // cancellation is forbidden (-> 409 INVALID_TRANSITION). The linked
      // replenishment request is NOT auto-cancelled — pm handles it.
      const { rows } = await query<ProductionOrderRow>(
        `UPDATE production_orders SET status = 'cancelled'
         WHERE id = $1 AND status IN ('new','in_progress')
         RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
        [orderId],
      );
      const updated = rows[0];
      if (updated === undefined) {
        const exists = await query<{ status: string }>(
          'SELECT status FROM production_orders WHERE id = $1',
          [orderId],
        );
        if (exists.rows.length === 0) {
          throw AppError.notFound('Production order not found.');
        }
        throw new AppError(
          'INVALID_TRANSITION',
          `Cannot cancel a production order in status "${exists.rows[0]?.status}".`,
        );
      }
      await writeAudit(poolRunner, {
        actorUserId: principal.userId,
        action: 'production_order.cancelled',
        entity: 'production_orders',
        entityId: orderId,
        payload: { from: 'new|in_progress', linked_replenishment_id: updated.replenishment_id },
      });
      res.status(200).json({ production_order: updated });
      return;
    }

    // `in_progress` — plain forward flip from `new`.
    const { rows } = await query<ProductionOrderRow>(
      `UPDATE production_orders SET status = $2
       WHERE id = $1 AND status IN ('new','in_progress')
       RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      [orderId, nextStatus],
    );
    const updated = rows[0];
    if (updated === undefined) {
      // Either the order does not exist or its status disallows the change.
      const exists = await query<{ status: string }>(
        'SELECT status FROM production_orders WHERE id = $1',
        [orderId],
      );
      if (exists.rows.length === 0) {
        throw AppError.notFound('Production order not found.');
      }
      throw AppError.validation(
        `Cannot transition from "${exists.rows[0]?.status}" to "${nextStatus}".`,
      );
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: `production_order.${nextStatus}`,
      entity: 'production_orders',
      entityId: orderId,
      payload: { from: 'new|in_progress', to: nextStatus },
    });

    // AC5.3 — when an order tied to a replenishment moves to in_progress,
    // step the request CREATE_PRODUCTION_ORDER -> PRODUCING.
    if (nextStatus === 'in_progress' && updated.replenishment_id !== null) {
      await advance(updated.replenishment_id, principal.userId);
    }

    res.status(200).json({ production_order: updated });
  }),
);

// PUT /api/production-orders/:id
// Edit qty / deadline / note — only when status is 'new'.
productionOrdersRouter.put(
  '/:id',
  authenticate,
  authorizeWrite('production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const { rows: scopeRows } = await query<{
      location_id: number;
      target_location_id: number | null;
      status: string;
    }>(
      'SELECT location_id, target_location_id, status FROM production_orders WHERE id = $1',
      [orderId],
    );
    const existing = scopeRows[0];
    if (existing === undefined) {
      throw AppError.notFound('Production order not found.');
    }
    if (existing.status !== 'new') {
      throw AppError.validation("Faqat 'yangi' holatdagi zayavkani tahrirlash mumkin.");
    }

    if (principal.role === 'production_manager') {
      await requireLocationOperator(principal, Number(existing.location_id));
    } else {
      const anchor = existing.target_location_id ?? existing.location_id;
      await requireLocationOperator(principal, Number(anchor));
    }

    let qty: number | undefined;
    if ('qty' in body) {
      qty = requirePositiveNumber(body, 'qty');
    }
    let deadlineRaw: string | null | undefined;
    if ('deadline' in body) {
      deadlineRaw = optionalString(body, 'deadline') ?? null;
      if (deadlineRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) {
        throw AppError.validation('Field "deadline" must be an ISO date (YYYY-MM-DD).');
      }
    }
    let note: string | null | undefined;
    if ('note' in body) {
      note = optionalString(body, 'note') ?? null;
    }

    const updates: string[] = [];
    const params: (number | string | null)[] = [];

    if (qty !== undefined) {
      params.push(qty);
      updates.push(`qty = $${params.length}`);
    }
    if (deadlineRaw !== undefined) {
      params.push(deadlineRaw);
      updates.push(`deadline = $${params.length}`);
    }
    if (note !== undefined) {
      params.push(note);
      updates.push(`note = $${params.length}`);
    }

    if (updates.length === 0) {
      throw AppError.validation('Tahrirlash uchun maydon yuborilmadi.');
    }

    params.push(orderId);
    const { rows } = await query<ProductionOrderRow>(
      `UPDATE production_orders SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      params,
    );

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'production_order.update',
      entity: 'production_orders',
      entityId: orderId,
      payload: { qty, deadline: deadlineRaw, note },
    });

    res.status(200).json({ production_order: rows[0] });
  }),
);

// DELETE /api/production-orders/:id
// Remove an order — only allowed when status is 'new' or 'cancelled'.
productionOrdersRouter.delete(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');

    const { rows: scopeRows } = await query<{
      location_id: number;
      target_location_id: number | null;
      status: string;
    }>(
      'SELECT location_id, target_location_id, status FROM production_orders WHERE id = $1',
      [orderId],
    );
    const existing = scopeRows[0];
    if (existing === undefined) {
      throw AppError.notFound('Production order not found.');
    }
    if (existing.status !== 'new' && existing.status !== 'cancelled') {
      throw AppError.validation(
        "Faqat 'yangi' yoki 'bekor qilingan' zayavkalarni o'chirish mumkin.",
      );
    }

    if (!isSuperAdmin(principal)) {
      if (principal.role === 'production_manager') {
        await requireLocationOperator(principal, Number(existing.location_id));
      } else {
        const anchor = existing.target_location_id ?? existing.location_id;
        await requireLocationOperator(principal, Number(anchor));
      }
    }

    await query('DELETE FROM production_orders WHERE id = $1', [orderId]);

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'production_order.delete',
      entity: 'production_orders',
      entityId: orderId,
      payload: { status: existing.status },
    });

    res.status(204).send();
  }),
);
