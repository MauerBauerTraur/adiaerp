/**
 * M4 — Replenishment endpoints (spec section 4.5).
 *
 *   GET  /api/replenishment?status=        — list (RBAC + status filter)
 *   GET  /api/replenishment/:id            — one request + its transitions tarixi
 *   POST /api/replenishment                — manual create (qo'lda request)
 *   POST /api/replenishment/:id/advance    — step the state machine once
 *   POST /api/replenishment/:id/cancel     — -> CANCELLED
 *
 * The business logic lives in `services/replenishment.ts` — these handlers
 * are thin and only do validation, RBAC and shape adaptation.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize, authorizeWrite } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin, requireLocationOperator } from '../lib/principal.js';
import {
  asObject,
  optionalString,
  parseIdParam,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  acceptShipment,
  advance,
  cancelRequest,
  cancelRequestByFulfiller,
  createRequest,
  rejectShipment,
  REPLENISHMENT_COLUMNS,
  returnShipment,
  type ReplenishmentRow,
  type ReplenishmentStatus,
} from '../services/replenishment.js';

export const replenishmentRouter: Router = Router();

const ALL_STATUSES: readonly ReplenishmentStatus[] = [
  'NEW',
  'CHECK_STORE_SUPPLIER',
  'SHIP_TO_REQUESTER',
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
  'CLOSED',
  'CANCELLED',
];

// GET /api/replenishment?status=
replenishmentRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(ALL_STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${ALL_STATUSES.join(', ')}.`);
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`r.status = $${params.length}`);
    }
    // RBAC: location-scoped roles see only requests that touch their location.
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(r.requester_location_id = $${params.length} OR r.target_location_id = $${params.length})`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product + requester/target location names so the UI can render
    // the row without a second round trip (spec §4 list embedding rule).
    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              pl.name AS production_location_name
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = po.location_id
       ${where}
       ORDER BY r.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// GET /api/replenishment/:id  — embeds the transitions history.
replenishmentRouter.get(
  '/:id',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Embed product + requester/target location names (parity with the list
    // endpoint — frontend detail page renders the same fields).
    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              pl.name AS production_location_name
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = po.location_id
       WHERE r.id = $1`,
      [id],
    );
    const request = rows[0];
    if (request === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }

    // RBAC: only pm/ai_assistant see arbitrary requests; others must be tied
    // to it via requester_location_id, target_location_id, or the location
    // of any linked production_order/purchase_order — the spec §6 "W(bog'liq)"
    // semantics (a production_manager working on the linked PO must be able
    // to read the request).
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      const own = principal.locationId;
      if (own === null || !(await requestTouchesLocation(request, own))) {
        throw AppError.forbidden('You may only view requests that touch your location.');
      }
    }

    // Embed actor_name (JOIN users) so the UI can render "who" without an
    // extra fetch — system/cron rows show actor_name = null.
    const { rows: transitions } = await query<{
      id: number;
      from_status: string | null;
      to_status: string;
      reason: string | null;
      actor_user_id: number | null;
      actor_name: string | null;
      actor_username: string | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.from_status, t.to_status, t.reason, t.actor_user_id,
              u.name AS actor_name, u.username AS actor_username, t.created_at
       FROM replenishment_transitions t
       LEFT JOIN users u ON u.id = t.actor_user_id
       WHERE t.replenishment_id = $1 ORDER BY t.id`,
      [id],
    );
    res.status(200).json({ request, transitions });
  }),
);

// POST /api/replenishment
//
// Owner-approved 2026-05-28: PM is read-and-recommend; only the central
// warehouse manager raises manual requests (the auto-scan worker raises
// the rest with actor=null). PM hits 403 here — no super-admin bypass.
replenishmentRouter.post(
  '/',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const requesterLocationId = requireId(body, 'requester_location_id');
    const qtyNeeded = requirePositiveNumber(body, 'qty_needed');
    const note = optionalString(body, 'note') ?? null;

    const row = await createRequest({
      productId,
      requesterLocationId,
      qtyNeeded,
      actorUserId: principal.userId,
      note,
    });
    res.status(201).json({ request: row });
  }),
);

// POST /api/replenishment/:id/advance
//
// Owner-approved 2026-05-28: only an operator may step the state machine.
// PM is 403 (no bypass) — the action happens at the operator's hop, not
// the chain. The "request touches my location" check still applies and
// is enforced for every non-PM principal below.
replenishmentRouter.post(
  '/:id/advance',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Spec §6 W(bog'liq) — a scoped manager must be linked to the request
    // (requester/target, or indirectly via a linked production / purchase
    // order). authorizeWrite already filtered out PM and unallowed roles;
    // the remaining principals are all scoped operators.
    const { rows } = await query<{
      requester_location_id: number;
      target_location_id: number | null;
      production_order_id: number | null;
      purchase_order_id: number | null;
    }>(
      `SELECT requester_location_id, target_location_id,
              production_order_id, purchase_order_id
       FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    // Any of the operator's assigned locations may justify the action —
    // M:N (ADR-0012).
    const allowed = await principalTouchesRequest(r, principal.locationIds);
    if (!allowed) {
      throw AppError.forbidden('You may only advance requests that touch your location.');
    }

    const result = await advance(id, principal.userId);
    res.status(200).json({
      advanced: result.advanced,
      status: result.request.status,
      reason: result.reason,
      request: result.request,
    });
  }),
);

// POST /api/replenishment/:id/cancel
//
// Owner-approved 2026-05-28: cancellation belongs to the requesting link
// in the chain — the manager of `requester_location_id`. PM may NOT
// cancel (read-and-recommend). The set of allowed roles is the set of
// roles that can manage a `location` that may itself raise a request:
// raw warehouse, production, supply, central warehouse, store.
replenishmentRouter.post(
  '/:id/cancel',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Load the requester to enforce "only the originating bo'g'in
    // manager may cancel". 404 vs 403 split: an unknown id is 404; a
    // real id outside the operator's scope is 403.
    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'manual cancel';

    const updated = await cancelRequest(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// 0024 — Recipient-side closure: accept / reject / return
// ---------------------------------------------------------------------------
// Authorisation model:
//   * accept / reject / return — the requester location's operator confirms
//     what they received.   guard: `requireLocationOperator(principal,
//                                   request.requester_location_id)`.
//   * cancel-by-fulfiller    — the target location's operator (sklad/sex)
//     bekor qiladi.   guard: `requireLocationOperator(principal,
//                            request.target_location_id)`.
//
// 404 vs 403 split: unknown id -> 404; real id outside scope -> 403.

// POST /api/replenishment/:id/accept
//   body: { qty_accepted: number, note?: string }
replenishmentRouter.post(
  '/:id/accept',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const qtyAcceptedRaw = body.qty_accepted;
    if (
      typeof qtyAcceptedRaw !== 'number' ||
      !Number.isFinite(qtyAcceptedRaw) ||
      qtyAcceptedRaw < 0
    ) {
      throw AppError.validation('Field "qty_accepted" must be a number >= 0.');
    }
    const note = optionalString(body, 'note') ?? null;

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await acceptShipment({
      requestId: id,
      qtyAccepted: qtyAcceptedRaw,
      note,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/reject
//   body: { reason: string }
replenishmentRouter.post(
  '/:id/reject',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const reason = optionalString(body, 'reason');
    if (reason === undefined) {
      throw AppError.validation('Field "reason" is required for reject.');
    }

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await rejectShipment({
      requestId: id,
      reason,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/return
//   body: { qty_returned: number, reason: string }
replenishmentRouter.post(
  '/:id/return',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const qtyReturned = requirePositiveNumber(body, 'qty_returned');
    const reason = optionalString(body, 'reason');
    if (reason === undefined) {
      throw AppError.validation('Field "reason" is required for return.');
    }

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await returnShipment({
      requestId: id,
      qtyReturned,
      reason,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/cancel-by-fulfiller
//   body: { reason?: string }
replenishmentRouter.post(
  '/:id/cancel-by-fulfiller',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'cancelled by fulfiller';

    const { rows } = await query<{
      target_location_id: number | null;
      requester_location_id: number;
    }>(
      `SELECT target_location_id, requester_location_id
         FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    // The fulfiller is the target side. If target is not yet resolved
    // (status=NEW), fall back to any production_order / purchase_order
    // location via principalTouchesRequest — the warehouse keeper who
    // owns the chain is the natural cancel actor.
    if (existing.target_location_id !== null) {
      await requireLocationOperator(principal, Number(existing.target_location_id));
    } else {
      // NEW state — no target yet. Permit raw_warehouse / central_warehouse /
      // supply managers whose assigned location is the eventual fulfiller
      // (resolved by the topology walk). Cheap heuristic: the chain manager
      // for the requester. We DENY if the operator does not touch the chain
      // at all.
      const allowed = await principalTouchesRequest(
        {
          requester_location_id: existing.requester_location_id,
          target_location_id: existing.target_location_id,
        },
        principal.locationIds,
      );
      if (!allowed) {
        throw AppError.forbidden(
          'You may only cancel-by-fulfiller requests that touch your location.',
        );
      }
    }

    const updated = await cancelRequestByFulfiller(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

/**
 * Spec §6 "W(bog'liq)" — a scoped role touches a request when its location
 * matches the requester, the target, OR the location_id of a linked
 * production_order / target_location_id of a linked purchase_order. The two
 * extra checks fire only when the request has been linked (lazy join).
 */
async function requestTouchesLocation(
  request: {
    requester_location_id: number;
    target_location_id: number | null;
    production_order_id?: number | null;
    purchase_order_id?: number | null;
  },
  ownLocationId: number,
): Promise<boolean> {
  if (
    ownLocationId === request.requester_location_id ||
    ownLocationId === request.target_location_id
  ) {
    return true;
  }
  if (request.production_order_id != null) {
    const { rows } = await query<{ location_id: number }>(
      'SELECT location_id FROM production_orders WHERE id = $1',
      [request.production_order_id],
    );
    if (rows[0]?.location_id === ownLocationId) {
      return true;
    }
  }
  if (request.purchase_order_id != null) {
    const { rows } = await query<{ target_location_id: number }>(
      'SELECT target_location_id FROM purchase_orders WHERE id = $1',
      [request.purchase_order_id],
    );
    if (rows[0]?.target_location_id === ownLocationId) {
      return true;
    }
  }
  return false;
}

/** M:N variant — any of `ownLocationIds` touching is enough (ADR-0012). */
async function principalTouchesRequest(
  request: {
    requester_location_id: number;
    target_location_id: number | null;
    production_order_id?: number | null;
    purchase_order_id?: number | null;
  },
  ownLocationIds: readonly number[],
): Promise<boolean> {
  for (const id of ownLocationIds) {
    if (await requestTouchesLocation(request, id)) {
      return true;
    }
  }
  return false;
}
