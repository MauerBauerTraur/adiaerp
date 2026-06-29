/**
 * M6 — Purchase orders (spec section 4.7).
 *
 *   GET  /api/purchase-orders?status=        — list (RBAC + status filter)
 *   POST /api/purchase-orders                — create (draft)
 *   POST /api/purchase-orders/:id/approve    — { step: 'manager' | 'keeper' }
 *   POST /api/purchase-orders/:id/receive    — approved -> received (raw stock +)
 *   POST /api/purchase-orders/:id/reject     — draft -> rejected
 *
 * Approval rules (D5, OS-5):
 *   - 'manager' step: `pm` or `supply_manager` only;
 *   - 'keeper'  step: `pm` or `raw_warehouse_manager` only;
 *   - 'receive': `pm` or `raw_warehouse_manager`.
 * Both `*_approved_by` columns must be set before the row becomes `approved`
 * (AC6.1, AC6.2 — also enforced by the DB CHECK).
 *
 * On `received`, the linked replenishment request (if any) is advanced in
 * the SAME transaction (AC6.3, the request moves CREATE_PURCHASE_ORDER ->
 * CREATE_PRODUCTION_ORDER once raw is on hand).
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
  requireEnum,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  approvePurchaseOrder,
  createAdminPurchaseOrder,
  receivePurchaseOrder,
  PURCHASE_ORDER_COLUMNS,
  type ApprovalStep,
  type PurchaseOrderRow,
} from '../services/purchaseOrder.js';
import { advance } from '../services/replenishment.js';
import {
  createNotificationsForRecipients,
  getLocationManager,
  getUsersByRole,
} from '../services/notify.js';

export const purchaseOrdersRouter: Router = Router();

const STATUSES = ['draft', 'approved', 'received', 'cancelled', 'rejected'] as const;

// GET /api/purchase-orders?status=
purchaseOrdersRouter.get(
  '/',
  authenticate,
  authorize('pm', 'supply_manager', 'raw_warehouse_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${STATUSES.join(', ')}.`);
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`po.status = $${params.length}`);
    }
    // I5 — RBAC location scoping (spec §6):
    //   - `pm`, `ai_assistant`, `central_warehouse_manager` — see all;
    //   - `raw_warehouse_manager` — only POs targeting their raw warehouse;
    //   - `supply_manager` — only POs they created (no target match is
    //     reliable; the supply manager raises the request and stays linked
    //     via `created_by`).
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== 'central_warehouse_manager'
    ) {
      if (principal.role === 'raw_warehouse_manager') {
        if (principal.locationId === null) {
          res.status(200).json([]);
          return;
        }
        params.push(principal.locationId);
        conditions.push(`po.target_location_id = $${params.length}`);
      } else if (principal.role === 'supply_manager') {
        params.push(principal.userId);
        conditions.push(`po.created_by = $${params.length}`);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product / target_location / approver / supplier names for the UI.
    const qualifiedCols = PURCHASE_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      PurchaseOrderRow & {
        product_name: string;
        target_location_name: string | null;
        manager_approved_name: string | null;
        manager_approved_username: string | null;
        keeper_approved_name: string | null;
        keeper_approved_username: string | null;
        supplier_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              tl.name AS target_location_name,
              mu.name AS manager_approved_name,
              mu.username AS manager_approved_username,
              ku.name AS keeper_approved_name,
              ku.username AS keeper_approved_username,
              s.name AS supplier_name
       FROM purchase_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations tl ON tl.id = po.target_location_id
       LEFT JOIN users mu ON mu.id = po.manager_approved_by
       LEFT JOIN users ku ON ku.id = po.keeper_approved_by
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       ${where}
       ORDER BY po.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// POST /api/purchase-orders
//
// Owner-approved 2026-05-28: PM is read-and-recommend; only a supply
// manager raises a purchase request.
purchaseOrdersRouter.post(
  '/',
  authenticate,
  authorizeWrite('supply_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const supplierId = optionalId(body, 'supplier_id') ?? null;
    const targetLocationId = requireId(body, 'target_location_id');
    const note = optionalString(body, 'note') ?? null;

    // M9 — wrap the insert + audit + notification in ONE transaction so the
    // `purchase_request_created` row in `notifications` is rolled back with
    // the insert on any failure (no orphan nudges).
    const created = await withTransaction(async (tx) => {
      const { rows } = await tx.query<PurchaseOrderRow>(
        `INSERT INTO purchase_orders
           (product_id, qty, supplier_id, target_location_id, status, note, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6)
         RETURNING ${PURCHASE_ORDER_COLUMNS}`,
        [productId, qty, supplierId, targetLocationId, note, principal.userId],
      );
      const inserted = rows[0];
      if (inserted === undefined) {
        throw AppError.internal('Purchase order insert returned no row.');
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'purchase_order.create',
        entity: 'purchase_orders',
        entityId: inserted.id,
        payload: { product_id: productId, qty, target_location_id: targetLocationId },
      });

      // Recipients (spec §7): every active supply_manager and raw_warehouse_manager.
      // The target raw warehouse's manager (if assigned) is included via
      // `getLocationManager` so a single-warehouse setup with no role users
      // still notifies the right person. PMs also get visibility.
      const supplyMgrs = await getUsersByRole(tx, 'supply_manager');
      const rawMgrs = await getUsersByRole(tx, 'raw_warehouse_manager');
      const locationMgr = await getLocationManager(tx, targetLocationId);
      const pms = await getUsersByRole(tx, 'pm');
      const recipients: number[] = [];
      for (const id of [...supplyMgrs, ...rawMgrs, ...pms]) {
        if (!recipients.includes(id)) recipients.push(id);
      }
      if (locationMgr !== null && !recipients.includes(locationMgr)) {
        recipients.push(locationMgr);
      }

      if (recipients.length > 0) {
        const { rows: ctx } = await tx.query<{ product_name: string; product_unit: string }>(
          `SELECT name AS product_name, unit AS product_unit FROM products WHERE id = $1`,
          [productId],
        );
        const productName = ctx[0]?.product_name ?? `#${productId}`;
        const productUnit = ctx[0]?.product_unit ?? '';
        await createNotificationsForRecipients(tx, recipients, {
          type: 'purchase_request_created',
          title: `Yangi ta'minot so'rovi #${inserted.id}`,
          body:
            `Ta'minot: ${qty} ${productUnit} ${productName} — tasdiq kutilmoqda.`,
          payload: {
            purchase_order_id: inserted.id,
            product_id: productId,
            qty,
            target_location_id: targetLocationId,
          },
          // F3.3 / ADR-0011 — Tasdiqlash takes whichever step the presser
          // is eligible for (manager vs keeper); idempotency on the
          // approval rules out double-execution.
          inlineCallback: {
            buttons: [
              [
                { text: '✅ Tasdiqlash', data: `apprv:po:${inserted.id}` },
                { text: '❌ Rad qilish', data: `rej:po:${inserted.id}` },
              ],
              [{ text: "📋 Ko'rish", data: `view:po:${inserted.id}` }],
            ],
          },
        });
      }
      return inserted;
    });
    res.status(201).json({ purchase_order: created });
  }),
);

// POST /api/purchase-orders/admin  — EPIC 6.1 (admin → skladchi)
//
// The admin (PM) places a purchase order and routes it to the warehouse
// keeper (skladchi). This is an ADMIN action — unlike the supply-manager
// create above it is gated by `authorize('pm')`, mirroring the other admin
// endpoints (users / locations / products) that are exempt from the
// `authorizeWrite` PM-block. The two-step approval is preserved: the admin
// fills the manager step, the skladchi confirms the keeper step.
purchaseOrdersRouter.post(
  '/admin',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const supplierId = optionalId(body, 'supplier_id') ?? null;
    const targetLocationId = requireId(body, 'target_location_id');
    const note = optionalString(body, 'note') ?? null;

    // The target must be a raw warehouse — the keeper of a raw warehouse is
    // the skladchi who confirms. Validate up front for a clean 422.
    const { rows: locRows } = await query<{ type: string }>(
      `SELECT type::text AS type FROM locations WHERE id = $1`,
      [targetLocationId],
    );
    if (locRows[0] === undefined) {
      throw AppError.validation('Target location does not exist.');
    }
    if (locRows[0].type !== 'raw_warehouse') {
      throw AppError.validation(
        'An admin purchase order must target a raw warehouse (skladchi).',
      );
    }
    const { rows: prodRows } = await query<{ id: string }>(
      `SELECT id FROM products WHERE id = $1`,
      [productId],
    );
    if (prodRows[0] === undefined) {
      throw AppError.validation('Product does not exist.');
    }

    const created = await createAdminPurchaseOrder({
      productId,
      qty,
      supplierId,
      targetLocationId,
      note,
      adminUserId: principal.userId,
    });
    res.status(201).json({ purchase_order: created });
  }),
);

// POST /api/purchase-orders/:id/approve
//
// Owner-approved 2026-05-28: two-step approval (D5) stays — supply step
// + keeper step — but PM is read-and-recommend on both steps. The
// keeper step requires the raw_warehouse_manager assigned to the PO's
// target raw warehouse.
purchaseOrdersRouter.post(
  '/:id/approve',
  authenticate,
  authorizeWrite('supply_manager', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const step = requireEnum<ApprovalStep>(body, 'step', ['manager', 'keeper'] as const);

    // Role gating per step (D5) — strict, no PM bypass.
    if (step === 'manager' && principal.role !== 'supply_manager') {
      throw AppError.forbidden('Only supply_manager may take the manager approval step.');
    }
    if (step === 'keeper' && principal.role !== 'raw_warehouse_manager') {
      throw AppError.forbidden('Only raw_warehouse_manager may take the keeper approval step.');
    }

    // IDOR guard — a scoped approver may only approve a PO that targets
    // their own scope. 404 vs 403 split: an unknown id is 404; a real id
    // outside the operator's scope is 403 (FOREIGN_LOCATION, audit-logged).
    const { rows: scopeRows } = await query<{
      created_by: number | null;
      target_location_id: number;
    }>(
      'SELECT created_by, target_location_id FROM purchase_orders WHERE id = $1',
      [orderId],
    );
    const scope = scopeRows[0];
    if (scope === undefined) {
      throw AppError.notFound('Purchase order not found.');
    }
    if (step === 'manager') {
      // The supply manager step is keyed to created_by (each supply
      // manager owns their own draft requests).
      if (scope.created_by === null || Number(scope.created_by) !== principal.userId) {
        throw AppError.forbidden(
          'A supply_manager may only approve purchase orders they created themselves.',
        );
      }
    } else {
      // keeper — the target raw warehouse must be in the operator's M:N set.
      await requireLocationOperator(principal, Number(scope.target_location_id));
    }

    const updated = await approvePurchaseOrder(orderId, step, principal.userId);
    res.status(200).json({ purchase_order: updated });
  }),
);

// POST /api/purchase-orders/:id/receive
//
// Owner-approved 2026-05-28: PM is read-and-recommend; only the raw
// warehouse manager who owns the target raw warehouse may receive.
purchaseOrdersRouter.post(
  '/:id/receive',
  authenticate,
  authorizeWrite('raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');

    // The target raw warehouse must be in the operator's M:N set.
    const { rows: scopeRows } = await query<{ target_location_id: number }>(
      'SELECT target_location_id FROM purchase_orders WHERE id = $1',
      [orderId],
    );
    const scope = scopeRows[0];
    if (scope === undefined) {
      throw AppError.notFound('Purchase order not found.');
    }
    await requireLocationOperator(principal, Number(scope.target_location_id));

    // AC6.3 — the receive flow and the linked replenishment advance commit
    // together inside ONE transaction. `receivePurchaseOrder(tx)` and
    // `advance(id, actor, tx)` share the same client so both succeed or both
    // roll back.
    const received = await withTransaction(async (tx) => {
      const row = await receivePurchaseOrder(orderId, principal.userId, tx);
      if (row.replenishment_id !== null) {
        await advance(row.replenishment_id, principal.userId, tx);
      }
      return row;
    });
    res.status(200).json({ purchase_order: received });
  }),
);

// POST /api/purchase-orders/:id/reject
//
// Owner-approved 2026-05-28: PM is read-and-recommend; only a supply
// manager may reject a draft purchase request.
purchaseOrdersRouter.post(
  '/:id/reject',
  authenticate,
  authorizeWrite('supply_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');

    const { rows } = await query<PurchaseOrderRow>(
      `UPDATE purchase_orders SET status = 'rejected'
       WHERE id = $1 AND status = 'draft'
       RETURNING ${PURCHASE_ORDER_COLUMNS}`,
      [orderId],
    );
    const updated = rows[0];
    if (updated === undefined) {
      const exists = await query<{ status: string }>(
        'SELECT status FROM purchase_orders WHERE id = $1',
        [orderId],
      );
      if (exists.rows.length === 0) {
        throw AppError.notFound('Purchase order not found.');
      }
      throw AppError.validation(
        `Only a draft purchase order can be rejected (current: "${exists.rows[0]?.status}").`,
      );
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'purchase_order.rejected',
      entity: 'purchase_orders',
      entityId: orderId,
      payload: null,
    });
    res.status(200).json({ purchase_order: updated });
  }),
);
