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
import { isKaymakProduct } from '../lib/productCategory.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import {
  getPrincipal,
  isSuperAdmin,
  requireLocationOperator,
} from '../lib/principal.js';
import {
  asObject,
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
  createNotification,
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
        product_type: string;
        location_name: string | null;
        target_location_name: string | null;
        parent_target_location_name: string | null;
        requester_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.type AS product_type,
              ll.name AS location_name,
              tl.name AS target_location_name,
              COALESCE(ptl.name, prl.name) AS parent_target_location_name,
              rl.name AS requester_location_name
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations ll ON ll.id = po.location_id
       LEFT JOIN locations tl ON tl.id = po.target_location_id
       LEFT JOIN production_orders ppo ON ppo.id = po.parent_production_order_id
       LEFT JOIN locations ptl ON ptl.id = ppo.target_location_id
       LEFT JOIN replenishment_requests rr ON rr.id = po.replenishment_id
       LEFT JOIN locations rl ON rl.id = rr.requester_location_id
       LEFT JOIN replenishment_requests prr ON prr.id = ppo.replenishment_id
       LEFT JOIN locations prl ON prl.id = prr.requester_location_id
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
      unit: string;
      location_id: number | null;
      location_name: string;
      product_type: string;
      production_cost: number | null;
      target_location_name: string | null;
      parent_production_order_id: number | null;
      parent_product_name: string | null;
      parent_unit: string | null;
      parent_qty: number | null;
      parent_production_cost: number | null;
      grandparent_production_order_id: number | null;
      grandparent_product_name: string | null;
      grandparent_unit: string | null;
      grandparent_qty: number | null;
      grandparent_production_cost: number | null;
    }>(
      `SELECT po.id, po.product_id, po.qty::float AS qty,
              p.name AS product_name, p.unit,
              po.location_id, l.name AS location_name,
              p.type AS product_type,
              p.production_cost::float AS production_cost,
              tl.name AS target_location_name,
              po.parent_production_order_id,
              pp.name AS parent_product_name,
              pp.unit AS parent_unit,
              par.qty::float AS parent_qty,
              pp.production_cost::float AS parent_production_cost,
              gpar.id AS grandparent_production_order_id,
              gpp.name AS grandparent_product_name,
              gpp.unit AS grandparent_unit,
              gpar.qty::float AS grandparent_qty,
              gpp.production_cost::float AS grandparent_production_cost
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         LEFT JOIN locations l ON l.id = po.location_id
         LEFT JOIN locations tl ON tl.id = po.target_location_id
         LEFT JOIN production_orders par ON par.id = po.parent_production_order_id
         LEFT JOIN products pp ON pp.id = par.product_id
         LEFT JOIN production_orders gpar ON gpar.id = par.parent_production_order_id
         LEFT JOIN products gpp ON gpp.id = gpar.product_id
        WHERE po.status NOT IN ('cancelled')
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
       WHERE po.status != 'cancelled'
         AND pd.status IN ('pending', 'dispatched', 'received')
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

// GET /api/production-orders/cost-summary?from=YYYY-MM-DD&to=YYYY-MM-DD&location_id=
// Must be before /:id to prevent Express treating "cost-summary" as an id.
// Returns production cost breakdown by location and product.
// Only orders with status NOT IN ('cancelled') are included.
// Requires products.production_cost to be set.
productionOrdersRouter.get(
  '/cost-summary',
  authenticate,
  authorize('pm', 'production_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
    const locationIdRaw = typeof req.query.location_id === 'string' ? req.query.location_id : undefined;

    if (fromRaw && !datePattern.test(fromRaw)) throw AppError.validation('"from" must be YYYY-MM-DD.');
    if (toRaw && !datePattern.test(toRaw)) throw AppError.validation('"to" must be YYYY-MM-DD.');

    const productIdRaw = typeof req.query.product_id === 'string' ? req.query.product_id : undefined;

    const conditions: string[] = [`po.status NOT IN ('cancelled')`];
    const params: (string | number)[] = [];

    if (fromRaw && toRaw) {
      params.push(fromRaw);
      const fromIdx = params.length;
      params.push(toRaw);
      const toIdx = params.length;
      conditions.push(
        `(po.deadline BETWEEN $${fromIdx} AND $${toIdx} OR (po.deadline IS NULL AND po.created_at::date BETWEEN $${fromIdx} AND $${toIdx}))`,
      );
    } else if (fromRaw) {
      params.push(fromRaw);
      const idx = params.length;
      conditions.push(`(po.deadline >= $${idx} OR (po.deadline IS NULL AND po.created_at::date >= $${idx}))`);
    } else if (toRaw) {
      params.push(toRaw);
      const idx = params.length;
      conditions.push(`(po.deadline <= $${idx} OR (po.deadline IS NULL AND po.created_at::date <= $${idx}))`);
    }
    if (locationIdRaw) {
      params.push(Number(locationIdRaw));
      conditions.push(`po.location_id = $${params.length}`);
    } else if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant' && principal.locationId !== null) {
      params.push(principal.locationId);
      conditions.push(`po.location_id = $${params.length}`);
    }
    if (productIdRaw) {
      params.push(Number(productIdRaw));
      conditions.push(`po.product_id = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // ── Step 1: Main aggregation (no sell_price / xomashyo in SQL) ──────────
    type BaseRow = {
      location_id: number | null;
      location_name: string | null;
      product_id: number;
      product_name: string;
      unit: string;
      product_type: string;
      total_qty: number;
      production_cost: number | null;
      total_cost: number | null;
      order_count: number;
    };
    const { rows: baseRows } = await query<BaseRow>(
      `SELECT
         po.location_id,
         l.name AS location_name,
         po.product_id,
         p.name AS product_name,
         p.unit,
         p.type AS product_type,
         SUM(po.qty)::float AS total_qty,
         p.production_cost::float AS production_cost,
         CASE WHEN p.production_cost IS NOT NULL
              THEN (SUM(po.qty) * p.production_cost)::float
              ELSE NULL END AS total_cost,
         COUNT(*)::int AS order_count
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations l ON l.id = po.location_id
       ${where}
       GROUP BY po.location_id, l.name, po.product_id, p.name, p.unit,
                p.type, p.production_cost
       ORDER BY l.name NULLS LAST, p.name`,
      params,
    );

    // ── Steps 2+3: JS name matching for sell_price and canonical recipe id ─────
    // Two products can have visually identical names but differ in Cyrillic encoding
    // (NFC vs NFD). SQL LOWER(TRIM(name)) = LOWER(TRIM(name)) fails in these cases.
    // Fix: fetch all semi/finished products once, then match in JS with normalize('NFC').
    const uniqueIds = [...new Set(baseRows.map((r) => r.product_id))];
    const priceById = new Map<number, number | null>();
    const canonMap = new Map<number, number>();
    let metaById = new Map<number, { poster_ingredient_id: number | null; poster_product_id: number | null }>();

    if (uniqueIds.length > 0) {
      const { rows: allProducts } = await query<{
        id: number;
        name: string;
        sell_price: number | null;
        has_recipe: boolean;
        has_poster_product_id: boolean;
        poster_ingredient_id: number | null;
        poster_product_id: number | null;
      }>(
        `SELECT p.id,
                p.name,
                p.sell_price::float AS sell_price,
                EXISTS(SELECT 1 FROM recipes WHERE product_id = p.id) AS has_recipe,
                (p.poster_product_id IS NOT NULL) AS has_poster_product_id,
                p.poster_ingredient_id,
                p.poster_product_id
         FROM products p
         WHERE p.type IN ('semi', 'finished', 'gp')`,
      );

      // Strip everything except Cyrillic/Latin letters and digits — handles
      // different slash/paren/space encodings that fool SQL LOWER(TRIM()) matching.
      const norm = (s: string) =>
        s.normalize('NFC').toLowerCase().replace(/[^\p{L}\d]/gu, '');

      type ProductEntry = {
        id: number; sell_price: number | null; has_recipe: boolean;
        has_poster_product_id: boolean;
        poster_ingredient_id: number | null; poster_product_id: number | null;
      };
      // Lookup by aggressive-normalised name
      const byName = new Map<string, ProductEntry[]>();
      // Lookup by poster_ingredient_id (integer — 100% reliable)
      const byIngId = new Map<number, ProductEntry[]>();

      for (const p of allProducts) {
        const key = norm(p.name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key)!.push(p);
        if (p.poster_ingredient_id != null) {
          if (!byIngId.has(p.poster_ingredient_id)) byIngId.set(p.poster_ingredient_id, []);
          byIngId.get(p.poster_ingredient_id)!.push(p);
        }
      }

      // Also need poster IDs from production order products for the ingId lookup
      const { rows: orderProductMeta } = await query<{
        id: number; poster_ingredient_id: number | null; poster_product_id: number | null;
      }>(
        `SELECT id, poster_ingredient_id, poster_product_id FROM products WHERE id = ANY($1::int[])`,
        [uniqueIds],
      );
      metaById = new Map(orderProductMeta.map(r => [Number(r.id), r]));

      for (const row of baseRows) {
        const meta = metaById.get(row.product_id);
        const candidates: ProductEntry[] = [];

        // Strategy A: aggressive name match (handles encoding/punctuation differences)
        const byNameMatch = byName.get(norm(row.product_name)) ?? [];
        byNameMatch.forEach(p => candidates.push(p));

        // Strategy B: same poster_ingredient_id (integer — most reliable)
        if (meta?.poster_ingredient_id != null) {
          const byIng = byIngId.get(meta.poster_ingredient_id) ?? [];
          byIng.forEach(p => { if (!candidates.includes(p)) candidates.push(p); });
        }
        // Strategy C: poster_product_id used as ingredient_id by partner
        if (meta?.poster_product_id != null) {
          const byIng2 = byIngId.get(meta.poster_product_id) ?? [];
          byIng2.forEach(p => { if (!candidates.includes(p)) candidates.push(p); });
        }

        // sell_price: prefer partner with poster_product_id (menu dish version)
        const withSell = candidates
          .filter((p) => p.sell_price != null && p.sell_price > 0)
          .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
        priceById.set(row.product_id, withSell[0]?.sell_price ?? null);

        // canonical_id: product with recipes; prefer poster_product_id version
        const withRecipe = candidates
          .filter((p) => p.has_recipe)
          .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
        if (withRecipe[0]) canonMap.set(row.product_id, withRecipe[0].id);
      }
    }

    // Recursive BOM cost for canonical product IDs
    const xomashyoMap = new Map<number, number>(); // canonical_id → cost_per_unit
    const allCanonical = [...new Set([...canonMap.values()])];
    if (allCanonical.length > 0) {
      const { rows: bomRows } = await query<{ root_id: number; xomashyo_cost: number }>(
        `WITH RECURSIVE bom AS (
           SELECT r.product_id AS root_id,
                  r.component_product_id AS comp_id,
                  r.qty_per_unit::float AS eff_qty,
                  1 AS depth
           FROM recipes r
           WHERE r.product_id = ANY($1::int[])
           UNION ALL
           SELECT b.root_id,
                  r.component_product_id,
                  b.eff_qty * r.qty_per_unit::float,
                  b.depth + 1
           FROM bom b
           JOIN products comp ON comp.id = b.comp_id
           JOIN recipes r ON r.product_id = b.comp_id
           WHERE b.depth < 6
             AND comp.type IN ('semi', 'finished', 'gp')
         )
         SELECT b.root_id,
                COALESCE(SUM(b.eff_qty * COALESCE(comp.cost_price::float, 0)), 0)::float
                  AS xomashyo_cost
         FROM bom b
         JOIN products comp ON comp.id = b.comp_id
         WHERE NOT EXISTS (SELECT 1 FROM recipes r2 WHERE r2.product_id = b.comp_id)
         GROUP BY b.root_id`,
        [allCanonical],
      );
      for (const r of bomRows) xomashyoMap.set(Number(r.root_id), Number(r.xomashyo_cost));
    }

    // ── Step 4: Merge and enrich ─────────────────────────────────────────────
    const enriched = baseRows.map((r) => {
      // priceById holds sell_price from any same-named product (JS name-matched)
      const sellPrice = priceById.get(r.product_id) ?? null;
      const canonId = canonMap.get(r.product_id) ?? null;
      const xomashyoCost = canonId != null ? (xomashyoMap.get(canonId) ?? null) : null;
      const totalXomashyoCost = xomashyoCost != null ? xomashyoCost * r.total_qty : null;
      const totalRevenue = sellPrice != null ? sellPrice * r.total_qty : null;
      // Foyda = Sotuv narxi − Xomashyo tan narxi − Ishlab chiqarish narxi
      // Both sell_price AND production_cost must be set to show profit.
      const profitPerUnit =
        sellPrice !== null && r.production_cost !== null
          ? sellPrice - (xomashyoCost ?? 0) - Number(r.production_cost)
          : null;
      const totalProfit = profitPerUnit !== null ? profitPerUnit * r.total_qty : null;
      return {
        ...r,
        sell_price: sellPrice,
        total_revenue: totalRevenue,
        xomashyo_cost_per_unit: xomashyoCost,
        total_xomashyo_cost: totalXomashyoCost,
        profit_per_unit: profitPerUnit,
        total_profit: totalProfit,
      };
    });

    // Group by location for convenience
    type LocationGroup = {
      location_id: number | null;
      location_name: string | null;
      total_cost: number;
      total_revenue: number;
      total_profit: number;
      total_xomashyo_cost: number;
      products: typeof enriched;
    };
    const grouped: LocationGroup[] = [];
    for (const row of enriched) {
      let grp = grouped.find((g) => g.location_id === row.location_id);
      if (!grp) {
        grp = {
          location_id: row.location_id,
          location_name: row.location_name,
          total_cost: 0,
          total_revenue: 0,
          total_profit: 0,
          total_xomashyo_cost: 0,
          products: [],
        };
        grouped.push(grp);
      }
      grp.products.push(row);
      grp.total_cost += row.total_cost ?? 0;
      grp.total_revenue += row.total_revenue ?? 0;
      grp.total_profit += row.total_profit ?? 0;
      grp.total_xomashyo_cost += row.total_xomashyo_cost ?? 0;
    }

    const grandTotal = enriched.reduce((s, r) => s + (r.total_cost ?? 0), 0);
    const grandRevenue = enriched.reduce((s, r) => s + (r.total_revenue ?? 0), 0);
    const grandProfit = enriched.reduce((s, r) => s + (r.total_profit ?? 0), 0);
    const grandXomashyo = enriched.reduce((s, r) => s + (r.total_xomashyo_cost ?? 0), 0);
    res.status(200).json({
      groups: grouped,
      grand_total: grandTotal,
      grand_revenue: grandRevenue,
      grand_profit: grandProfit,
      grand_xomashyo: grandXomashyo,
    });
  }),
);

// GET /api/production-orders/raw-materials-usage?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns aggregated raw material consumption from production_dispatches.
productionOrdersRouter.get(
  '/raw-materials-usage',
  authenticate,
  authorize('pm', 'production_manager', 'super_admin'),
  asyncHandler(async (req, res) => {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;

    if (fromRaw && !datePattern.test(fromRaw)) throw AppError.validation('"from" must be YYYY-MM-DD.');
    if (toRaw && !datePattern.test(toRaw)) throw AppError.validation('"to" must be YYYY-MM-DD.');

    // Semi-finished and Г/П products travel through production_dispatches too,
    // but they are not xomashyo — this report counts raw materials only.
    const conditions: string[] = [`p.type = 'raw'`];
    const params: string[] = [];

    if (fromRaw) {
      params.push(fromRaw);
      conditions.push(`pd.created_at::date >= $${params.length}`);
    }
    if (toRaw) {
      params.push(toRaw);
      conditions.push(`pd.created_at::date <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    type UsageRow = {
      product_id: string;
      product_name: string;
      unit: string;
      total_qty: string;
      order_count: string;
    };

    const { rows } = await query<UsageRow>(
      `SELECT
         pd.product_id::text,
         pd.product_name,
         pd.product_unit AS unit,
         SUM(pd.qty_needed)::text AS total_qty,
         COUNT(DISTINCT pd.production_order_id)::text AS order_count
       FROM production_dispatches pd
       JOIN products p ON p.id = pd.product_id
       ${where}
       GROUP BY pd.product_id, pd.product_name, pd.product_unit
       ORDER BY SUM(pd.qty_needed) DESC`,
      params,
    );

    res.status(200).json(
      rows.map((r) => ({
        product_id: Number(r.product_id),
        product_name: r.product_name,
        unit: r.unit,
        total_qty: Number(r.total_qty),
        order_count: Number(r.order_count),
      })),
    );
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

    const { rows: allocations } = await query<{
      id: number;
      store_location_id: number;
      store_location_name: string;
      qty: number;
    }>(
      `SELECT poa.id, poa.store_location_id, l.name AS store_location_name, poa.qty::float AS qty
         FROM production_order_allocations poa
         JOIN locations l ON l.id = poa.store_location_id
        WHERE poa.production_order_id = $1
        ORDER BY poa.id`,
      [orderId],
    );

    res.status(200).json({ order, sub_orders: subOrders, allocations });
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
        production_cost: number | null;
        location_name: string | null;
        target_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name, p.unit AS product_unit,
              p.production_cost::float AS production_cost,
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

    const { rows: allocations } = await query<{
      id: number;
      store_location_id: number;
      store_location_name: string;
      qty: number;
    }>(
      `SELECT poa.id, poa.store_location_id, l.name AS store_location_name, poa.qty::float AS qty
         FROM production_order_allocations poa
         JOIN locations l ON l.id = poa.store_location_id
        WHERE poa.production_order_id = $1
        ORDER BY poa.id`,
      [orderId],
    );

    res.status(200).json({ order, bom, dispatch, sub_orders: subOrders, allocations });
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

    // Fire-and-forget: send Telegram notifications to each sex manager
    if (rows.length > 0) {
      const locIds = [...new Set(
        rows.filter((r) => r.to_location_id !== null).map((r) => r.to_location_id as number),
      )];
      void (async () => {
        try {
          const allProductIds = [...new Set(rows.map((r) => r.product_id))];
          const { rows: productRows } = await query<{ id: number; name: string; unit: string }>(
            `SELECT id, name, unit FROM products WHERE id = ANY($1::bigint[])`,
            [allProductIds],
          );
          const productMap = new Map(productRows.map((p) => [Number(p.id), p]));

          await withTransaction(async (tx) => {
            for (const locId of locIds) {
              const { rows: locRows } = await tx.query<{ manager_user_id: number | null; name: string }>(
                `SELECT manager_user_id, name FROM locations WHERE id = $1`,
                [locId],
              );
              const loc = locRows[0];
              if (!loc || loc.manager_user_id === null) continue;

              const locItems = rows.filter((r) => r.to_location_id === locId);
              const lines = locItems.map((r) => {
                const p = productMap.get(Number(r.product_id));
                const qty = Number(r.qty_needed);
                const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(3).replace(/\.?0+$/, '');
                return `• ${p?.name ?? `#${r.product_id}`}: ${qtyStr} ${p?.unit ?? ''}`;
              });

              await createNotification(tx, {
                recipientUserId: Number(loc.manager_user_id),
                type: 'dispatch_sent',
                title: `\u{1F69B} Xomashyo berildi — ${loc.name}`,
                body: lines.join('\n'),
              });
            }
          });
        } catch {
          // Best-effort — don't fail the dispatch response
        }
      })();
    }
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
         AND p.type IN ('semi','finished','gp')
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
    const targetLocationId = requireId(body, 'target_location_id');
    const deadlineRaw = optionalString(body, 'deadline') ?? null;
    if (deadlineRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) {
      throw AppError.validation('Field "deadline" must be an ISO date (YYYY-MM-DD).');
    }
    const note = optionalString(body, 'note') ?? null;

    // Optional per-store allocation breakdown.
    // If provided, sum(qty) must equal the order qty; on "done" the system
    // auto-transfers each portion from target_location to the store.
    type AllocationInput = { location_id: number; qty: number };
    const rawAllocations = Array.isArray(body.allocations) ? (body.allocations as unknown[]) : null;
    const allocations: AllocationInput[] | null = rawAllocations !== null
      ? rawAllocations.map((a) => {
          const obj = asObject(a as Record<string, unknown>);
          return { location_id: requireId(obj, 'location_id'), qty: requirePositiveNumber(obj, 'qty') };
        })
      : null;
    if (allocations !== null && allocations.length > 0) {
      const totalAllocated = allocations.reduce((s, a) => s + a.qty, 0);
      if (Math.abs(totalAllocated - qty) > 0.001) {
        throw AppError.validation(
          `Taqsimlangan miqdor (${totalAllocated}) zayafka miqdoriga (${qty}) teng bo'lishi kerak.`,
        );
      }
    }

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
        const { rows: ctx } = await tx.query<{
          product_name: string;
          product_unit: string;
          location_name: string;
        }>(
          `SELECT p.name AS product_name, p.unit AS product_unit, l.name AS location_name
             FROM products p, locations l
            WHERE p.id = $1 AND l.id = $2`,
          [productId, locationId],
        );
        const productName = ctx[0]?.product_name ?? `#${productId}`;
        const productUnit = ctx[0]?.product_unit ?? '';
        const locationName = ctx[0]?.location_name ?? `#${locationId}`;
        await createNotificationsForRecipients(tx, recipients, {
          type: 'production_order_created',
          title: `🆕 Yangi zayafka #${row.id}`,
          body:
            `🏭 Sex: ${locationName}\n` +
            `🍰 ${productName} — ${qty} ${productUnit}` +
            (deadlineRaw ? `\n📅 Muddat: ${deadlineRaw}` : ''),
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

      // Insert per-store allocation rows in the same transaction.
      if (allocations !== null && allocations.length > 0) {
        for (const alloc of allocations) {
          await tx.query(
            `INSERT INTO production_order_allocations (production_order_id, store_location_id, qty)
             VALUES ($1, $2, $3)`,
            [row.id, alloc.location_id, alloc.qty],
          );
        }
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

      // Auto-dispatch all raw/semi ingredient records immediately — stock
      // moves from the source warehouse to the sex without manual "Berildi" step.
      // The finished-product dispatch (product_id = productId) is deliberately
      // excluded: it stays pending until the order is marked done, then
      // the warehouse manager clicks "Qabul qilindi" to complete the transfer.
      const { rows: autoDispRows } = await query<{
        id: number; product_id: number;
        qty_needed: number; from_location_id: number | null; to_location_id: number | null;
      }>(
        `UPDATE production_dispatches
         SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $1
         WHERE production_order_id = $2
           AND product_id != $3
           AND status = 'pending'
         RETURNING id, product_id, qty_needed::float, from_location_id, to_location_id`,
        [principal.userId, inserted.id, productId],
      );
      for (const d of autoDispRows) {
        if (d.from_location_id !== null && d.to_location_id !== null && d.from_location_id !== d.to_location_id) {
          try {
            const result = await applyMovement({
              productId: Number(d.product_id),
              fromLocationId: Number(d.from_location_id),
              toLocationId: Number(d.to_location_id),
              qty: Number(d.qty_needed),
              reason: 'transfer',
              actorUserId: principal.userId,
              productionOrderId: inserted.id,
              allowNegative: true,
            });
            await query(`UPDATE production_dispatches SET movement_id = $2 WHERE id = $1`, [d.id, result.movementId]);
          } catch {
            // best-effort — movement failure doesn't abort the order
          }
        }
      }

      // Auto-complete all semi-finished dispatches (pending or dispatched → received).
      await query(
        `UPDATE production_dispatches pd
         SET status = 'received',
             dispatched_at = COALESCE(pd.dispatched_at, NOW()),
             dispatched_by = COALESCE(pd.dispatched_by, $1),
             received_at = NOW(),
             received_by = $1
         FROM products pr
         WHERE pd.production_order_id = $2
           AND pd.product_id = pr.id
           AND pr.type = 'semi'
           AND pd.status IN ('pending', 'dispatched')`,
        [principal.userId, inserted.id],
      );
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

        // The kaymak otdel works to order. Its stock figures are unreliable
        // (they run negative across locations), and skipping the sub-order
        // leaves the kaymak maker with no task at all for an order that does
        // need kaymak. Owner decision — always raise it, full quantity.
        const alwaysOrder = isKaymakProduct(node.component_name);

        if (!alwaysOrder && available >= neededQty) {
          stockNotes.push({
            product_id: node.component_product_id,
            product_name: node.component_name,
            available,
            needed: neededQty,
          });
          continue;
        }

        // Stock never reduces a kaymak sub-order; for everything else the
        // shortfall is what has to be produced. Guard the DB's qty > 0 check.
        const subQty = alwaysOrder ? neededQty : neededQty - available;
        if (subQty <= 0) continue;
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
              title: `🆕 Sub-zayafka #${subRow.id}`,
              body:
                `🍰 ${node.component_name} — ${subQty} ${node.component_unit}\n` +
                `↳ #${parentOrderId} zayafkasi uchun`,
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

    // Determine product type: finished products stay 'new' (manual Tayyor step).
    // Raw and semi-finished products auto-complete immediately.
    const { rows: prodTypeRows } = await query<{ type: string }>(
      'SELECT type FROM products WHERE id = $1',
      [productId],
    );
    const mainProductType = prodTypeRows[0]?.type ?? 'finished';

    // Auto-complete: sub-orders (zagatovka/semi) always finish immediately so
    // the main sex has intermediate stock ready. The main order auto-completes
    // only for raw/semi products; finished products wait for a manual Tayyor.
    let finalOrder: ProductionOrderRow = inserted;
    try {
      for (const sub of [...subOrders].reverse()) {
        await withTransaction(async (tx) => {
          await finishProductionOrder(sub.id, principal.userId, tx);
        });
      }
      if (mainProductType !== 'finished') {
        await withTransaction(async (tx) => {
          await finishProductionOrder(inserted.id, principal.userId, tx);
        });
        const { rows: refreshed } = await query<ProductionOrderRow>(
          `SELECT ${PRODUCTION_ORDER_COLUMNS} FROM production_orders WHERE id = $1`,
          [inserted.id],
        );
        if (refreshed[0]) finalOrder = refreshed[0];
      }
    } catch {
      // Auto-complete failure: order exists with status='new', remains in DB
    }

    res.status(201).json({ production_order: finalOrder, sub_orders: subOrders, stock_notes: stockNotes });
  }),
);

// PATCH /api/production-orders/bulk-done
// Mark multiple orders as done in one call (used by "Barchasini tayyor qilish").
productionOrdersRouter.patch(
  '/bulk-done',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const ids = body['ids'];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw AppError.validation('Field "ids" must be a non-empty array of order IDs.');
    }
    const orderIds = ids.map((id) => {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) throw AppError.validation(`Invalid order id: ${id}`);
      return n;
    });

    const results: { id: number; status: string; error?: string }[] = [];
    for (const orderId of orderIds) {
      try {
        const { rows: scopeRows } = await query<{ location_id: number; status: string }>(
          'SELECT location_id, status FROM production_orders WHERE id = $1',
          [orderId],
        );
        const existing = scopeRows[0];
        if (!existing) { results.push({ id: orderId, status: 'error', error: 'not found' }); continue; }
        if (existing.status === 'done') { results.push({ id: orderId, status: 'done' }); continue; }
        if (!isSuperAdmin(principal)) {
          await requireLocationOperator(principal, Number(existing.location_id));
        }
        await finishProductionOrder(orderId, principal.userId);
        results.push({ id: orderId, status: 'done' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ id: orderId, status: 'error', error: msg });
      }
    }
    res.status(200).json({ results });
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
      // If store allocations are defined, auto-transfer from target_location
      // to each store inside the same transaction (no human step needed).
      const { updated: result, hasAllocations } = await withTransaction(async (tx) => {
        const updated = await finishProductionOrder(orderId, principal.userId, tx);
        if (updated.replenishment_id !== null) {
          await advance(updated.replenishment_id, principal.userId, tx);
        }

        const { rows: allocRows } = await tx.query<{
          store_location_id: number;
          qty: string;
        }>(
          `SELECT store_location_id, qty::float AS qty
             FROM production_order_allocations
            WHERE production_order_id = $1`,
          [orderId],
        );

        if (allocRows.length > 0) {
          const targetLocId = updated.target_location_id ?? updated.location_id;
          for (const alloc of allocRows) {
            await applyMovement(
              {
                productId: updated.product_id,
                fromLocationId: targetLocId,
                toLocationId: Number(alloc.store_location_id),
                qty: Number(alloc.qty),
                reason: 'transfer',
                actorUserId: principal.userId,
                productionOrderId: orderId,
              },
              tx,
            );
          }
        }

        return { updated, hasAllocations: allocRows.length > 0 };
      });

      // Auto-dispatch: update the finished-product dispatch record.
      // When store allocations exist, stock is already fully distributed —
      // mark as 'received' to bypass the CW confirmation step.
      // Otherwise use the normal 'dispatched' flow (CW manager clicks receive).
      const { rows: finishedDispatches } = await query<{ id: number }>(
        `SELECT id FROM production_dispatches
          WHERE production_order_id = $1
            AND product_id = $2
            AND status = 'pending'`,
        [orderId, result.product_id],
      );
      for (const d of finishedDispatches) {
        try {
          if (hasAllocations) {
            await query(
              `UPDATE production_dispatches
               SET status = 'received',
                   dispatched_at = NOW(), dispatched_by = $2,
                   received_at = NOW(), received_by = $2,
                   movement_id = NULL
               WHERE id = $1`,
              [d.id, principal.userId],
            );
          } else {
            await query(
              `UPDATE production_dispatches
               SET status = 'dispatched', dispatched_at = NOW(), dispatched_by = $2, movement_id = NULL
               WHERE id = $1`,
              [d.id, principal.userId],
            );
          }
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

    // PM and super_admin are chain-wide — no location ownership check.
    if (!isSuperAdmin(principal)) {
      if (principal.role === 'production_manager') {
        await requireLocationOperator(principal, Number(existing.location_id));
      } else {
        const anchor = existing.target_location_id ?? existing.location_id;
        await requireLocationOperator(principal, Number(anchor));
      }
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
    if (!isSuperAdmin(principal) && principal.role !== 'pm' && existing.status !== 'new' && existing.status !== 'cancelled') {
      throw AppError.validation(
        "Faqat 'yangi' yoki 'bekor qilingan' zayavkalarni o'chirish mumkin.",
      );
    }

    if (!isSuperAdmin(principal) && principal.role !== 'pm') {
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

// POST /api/production-orders/:id/notify
// Manually re-send Telegram notification about an order to production_manager + pm users.
productionOrdersRouter.post(
  '/:id/notify',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id, 'id');
    const sent = await withTransaction(async (tx) => {
      const { rows } = await tx.query<{
        id: number;
        product_name: string;
        product_unit: string;
        qty: number;
        location_name: string;
        deadline: string | null;
        status: string;
      }>(
        `SELECT po.id, p.name AS product_name, p.unit AS product_unit, po.qty::float AS qty,
                l.name AS location_name, po.deadline, po.status
           FROM production_orders po
           JOIN products p ON p.id = po.product_id
           JOIN locations l ON l.id = po.location_id
          WHERE po.id = $1`,
        [orderId],
      );
      const order = rows[0];
      if (order === undefined) throw AppError.notFound('Production order not found.');

      const productionManagers = await getUsersByRole(tx, 'production_manager');
      const pms = await getUsersByRole(tx, 'pm');
      const recipients = [...new Set([...productionManagers, ...pms])];

      if (recipients.length > 0) {
        await createNotificationsForRecipients(tx, recipients, {
          type: 'production_order_created',
          title: `📋 Zayafka #${order.id}`,
          body:
            `🏭 Sex: ${order.location_name}\n` +
            `🍰 ${order.product_name} — ${order.qty} ${order.product_unit}` +
            (order.deadline ? `\n📅 Muddat: ${order.deadline}` : ''),
          payload: {
            production_order_id: order.id,
            qty: order.qty,
            location_name: order.location_name,
          },
          inlineCallback: {
            buttons: [[{ text: "📋 Ko'rish", data: `view:prod:${order.id}` }]],
          },
        });
      }
      return recipients.length;
    });
    res.json({ ok: true, sent });
  }),
);

