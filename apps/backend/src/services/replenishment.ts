/**
 * M4 — Replenishment engine + state machine (spec section 2.4 and 3, ADR-0001).
 *
 * This file is the YADRO of the self-correcting bakery ERP. It implements the
 * 10-state machine that drives one `replenishment_request` from `NEW` (the
 * scan worker spotted `stock.qty <= min_level`) to `CLOSED` (the requester
 * was topped up to `max_level`).
 *
 * Invariants enforced here:
 *   - SM-1 every transition is appended to `replenishment_transitions`;
 *   - SM-2 only a transition in `ALLOWED_TRANSITIONS` is accepted —
 *           anything else raises `INVALID_TRANSITION` (409);
 *   - SM-3 `advance()` flips status + creates the linked document + applies
 *           the movement + writes audit in ONE `withTransaction`;
 *   - SM-4 the wait states (`CREATE_PURCHASE_ORDER`, `PRODUCING`) return a
 *           no-op `{ advanced: false }` when their guard is not yet met;
 *   - SM-5 `advance()` is a no-op on terminal (`CLOSED`/`CANCELLED`) states;
 *   - SM-6 idempotent — re-calling `advance()` on the same row twice never
 *           skips a state and never double-applies a movement (FOR UPDATE
 *           lock + status check inside the same transaction).
 *   - Invariant 2 — one open request per (product, requester_location) is
 *           enforced by the partial UNIQUE index on the table; this service
 *           additionally returns OPEN_REQUEST_EXISTS (409) on `createRequest`.
 */
import { query, withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { applyMovement } from './stockMovement.js';
import { readFinalBom } from './bom.js';
import {
  createNotification,
  createNotificationsForRecipients,
  getLocationManager,
} from './notify.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ReplenishmentStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER'
  | 'CHECK_PRODUCTION_INPUT'
  | 'CREATE_PURCHASE_ORDER'
  | 'CREATE_PRODUCTION_ORDER'
  | 'PRODUCING'
  | 'DONE_TO_WAREHOUSE'
  | 'CLOSED'
  | 'CANCELLED';

export const TERMINAL_STATUSES: readonly ReplenishmentStatus[] = ['CLOSED', 'CANCELLED'];

/**
 * For skip-state chaining (SM-7) — the set of forward transitions that should
 * be retried inside the SAME `advance()` call after a successful step. If the
 * next state's guard happens to be satisfied (e.g. the linked production order
 * is already `done` when we move to `PRODUCING`), the engine chains forward
 * in one transaction rather than waiting for the cron's next pass.
 */
const CHAINABLE_AFTER: Readonly<Record<ReplenishmentStatus, boolean>> = {
  NEW: false,
  CHECK_STORE_SUPPLIER: false,
  SHIP_TO_REQUESTER: false,
  CHECK_PRODUCTION_INPUT: false,
  CREATE_PURCHASE_ORDER: false,
  CREATE_PRODUCTION_ORDER: true, // -> PRODUCING -> DONE_TO_WAREHOUSE
  PRODUCING: true, // -> DONE_TO_WAREHOUSE
  DONE_TO_WAREHOUSE: false,
  CLOSED: false,
  CANCELLED: false,
};

/**
 * The set of closure reasons a CLOSED / CANCELLED request may carry.
 * Migration 0024 adds the `closure_reason` column; the values mirror the
 * CHECK constraint there. NULL is allowed (legacy rows + in-flight rows).
 */
export type ReplenishmentClosureReason =
  | 'accepted_full'
  | 'accepted_partial'
  | 'rejected'
  | 'returned'
  | 'cancelled_by_requester'
  | 'cancelled_by_fulfiller';

export type ReplenishmentRow = {
  id: number;
  product_id: number;
  requester_location_id: number;
  target_location_id: number | null;
  qty_needed: number;
  status: ReplenishmentStatus;
  production_order_id: number | null;
  purchase_order_id: number | null;
  shipment_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  assigned_to_user_id: number | null;
  /** 0024 — qty actually accepted by the recipient (NULL until accept/reject). */
  qty_accepted: number | null;
  /** 0024 — qty counter-shipped back after accept/return (NULL when none). */
  qty_returned: number | null;
  /** 0024 — recipient free-form note attached at accept time. */
  accept_note: string | null;
  /** 0024 — recipient free-form reason attached at reject/return time. */
  reject_reason: string | null;
  /** 0024 — HOW the request reached terminal. NULL while open. */
  closure_reason: ReplenishmentClosureReason | null;
};

export const REPLENISHMENT_COLUMNS = `id, product_id, requester_location_id,
  target_location_id, qty_needed, status, production_order_id, purchase_order_id,
  shipment_movement_id, note, created_by, created_at, updated_at, closed_at,
  assigned_to_user_id, qty_accepted, qty_returned, accept_note, reject_reason,
  closure_reason`;

/**
 * Possible outcomes of one `advance()` call. `advanced=false` means a wait
 * state's guard is not yet met (SM-4) — not an error.
 */
export type AdvanceResult = {
  readonly advanced: boolean;
  readonly request: ReplenishmentRow;
  readonly reason: string;
};

// -----------------------------------------------------------------------------
// Transition table — SM-2
// -----------------------------------------------------------------------------
// The set of every `from -> to` step the engine may take. CANCELLED is an
// orthogonal terminal: `cancel()` flips any open status to CANCELLED.
const ALLOWED_TRANSITIONS: Readonly<Record<ReplenishmentStatus, readonly ReplenishmentStatus[]>> = {
  NEW: ['CHECK_STORE_SUPPLIER', 'CANCELLED'],
  CHECK_STORE_SUPPLIER: ['SHIP_TO_REQUESTER', 'CHECK_PRODUCTION_INPUT', 'CANCELLED'],
  CHECK_PRODUCTION_INPUT: ['CREATE_PRODUCTION_ORDER', 'CREATE_PURCHASE_ORDER', 'CANCELLED'],
  // Phase-2 (F2.3): self-loop is allowed because a multi-shortage BOM creates
  // POs one at a time — after PO1 is received we re-enter CHECK_PRODUCTION_INPUT
  // and if PO2 is still needed we stay in CREATE_PURCHASE_ORDER with the new PO
  // linked. The M:N `replenishment_purchase_orders` table retains every PO.
  CREATE_PURCHASE_ORDER: ['CREATE_PURCHASE_ORDER', 'CREATE_PRODUCTION_ORDER', 'CANCELLED'],
  CREATE_PRODUCTION_ORDER: ['PRODUCING', 'CANCELLED'],
  PRODUCING: ['DONE_TO_WAREHOUSE', 'CANCELLED'],
  DONE_TO_WAREHOUSE: ['SHIP_TO_REQUESTER', 'CANCELLED'],
  SHIP_TO_REQUESTER: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/** Returns true when `to` is reachable from `from` in one step. */
export function canTransition(from: ReplenishmentStatus, to: ReplenishmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// -----------------------------------------------------------------------------
// Create / Cancel
// -----------------------------------------------------------------------------

/**
 * Create a new replenishment request. The partial UNIQUE index on
 * `(product_id, requester_location_id) WHERE status NOT IN ('CLOSED','CANCELLED')`
 * is the DB-level guard against duplicates (invariant 2); we surface a
 * friendly `OPEN_REQUEST_EXISTS` (409) when it fires.
 */
export async function createRequest(opts: {
  productId: number;
  requesterLocationId: number;
  qtyNeeded: number;
  actorUserId: number | null;
  note?: string | null;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyNeeded) || opts.qtyNeeded <= 0) {
    throw AppError.validation('qty_needed must be a number greater than zero.');
  }

  try {
    return await withTransaction(async (tx) => {
      const { rows } = await tx.query<ReplenishmentRow>(
        `INSERT INTO replenishment_requests
           (product_id, requester_location_id, qty_needed, status, note, created_by)
         VALUES ($1, $2, $3, 'NEW', $4, $5)
         RETURNING ${REPLENISHMENT_COLUMNS}`,
        [
          opts.productId,
          opts.requesterLocationId,
          opts.qtyNeeded,
          opts.note ?? null,
          opts.actorUserId,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.internal('Replenishment insert returned no row.');
      }
      await recordTransition(tx, row.id, null, 'NEW', 'created', opts.actorUserId);
      await writeAudit(tx, {
        actorUserId: opts.actorUserId,
        action: 'replenishment.create',
        entity: 'replenishment_requests',
        entityId: row.id,
        payload: {
          product_id: opts.productId,
          requester_location_id: opts.requesterLocationId,
          qty_needed: opts.qtyNeeded,
        },
      });
      // M9 — replenishment_created notification (spec §7). The requester
      // location manager is the primary owner of the request; the target
      // location is not yet resolved here (NEW state — `advanceNew` fills
      // `target_location_id`), so the target manager nudge is sent at the
      // first transition (CHECK_STORE_SUPPLIER). The optional `actorUserId`
      // is also notified when it is NOT the location manager (a `pm` raising
      // a manual request gets visibility on it).
      await notifyReplenishmentCreated(tx, row, opts.actorUserId);
      return row;
    });
  } catch (err) {
    // 23505 is the PostgreSQL unique-violation SQLSTATE — only our partial
    // index can fire here. Surface the spec-defined OPEN_REQUEST_EXISTS code.
    if (isUniqueViolation(err)) {
      throw new AppError(
        'OPEN_REQUEST_EXISTS',
        'An open replenishment request already exists for this (product, location).',
      );
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
  );
}

/**
 * Flip any non-terminal request to CANCELLED. Idempotent on already-cancelled.
 *
 * 0024 — `closureReason` defaults to `'cancelled_by_requester'`. The
 * fulfiller-side cancel (sklad/sex bekor qiladi) uses
 * `cancelRequestByFulfiller`, which sets `'cancelled_by_fulfiller'`.
 * The argument is open (typed as the union) so an internal/system actor
 * can substitute another reason without a second helper.
 */
export async function cancelRequest(
  requestId: number,
  actorUserId: number | null,
  reason: string,
  closureReason: ReplenishmentClosureReason = 'cancelled_by_requester',
): Promise<ReplenishmentRow> {
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, requestId);
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      return order;
    }
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET status = 'CANCELLED',
             closed_at = now(),
             closure_reason = $2
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [requestId, closureReason],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment cancel returned no row.');
    }
    await recordTransition(tx, requestId, order.status, 'CANCELLED', reason, actorUserId);
    await writeAudit(tx, {
      actorUserId,
      action: 'replenishment.cancel',
      entity: 'replenishment_requests',
      entityId: requestId,
      payload: { from: order.status, reason, closure_reason: closureReason },
    });
    return updated;
  });
}

/**
 * 0024 — `cancel-by-fulfiller`: the sklad/sex tom oqimi (target side)
 * bekor qiladi to'gri so'rovni — only while the shipment has NOT yet
 * happened (status is still pre-ship). The wait-states + the pre-ship
 * states are accepted; SHIP_TO_REQUESTER is REFUSED (use accept/reject
 * after the shipment instead). This is an INVARIANT_VIOLATION (409).
 */
export async function cancelRequestByFulfiller(
  requestId: number,
  actorUserId: number | null,
  reason: string,
): Promise<ReplenishmentRow> {
  const allowedPreShipStates: readonly ReplenishmentStatus[] = [
    'NEW',
    'CHECK_STORE_SUPPLIER',
    'CHECK_PRODUCTION_INPUT',
    'CREATE_PURCHASE_ORDER',
    'CREATE_PRODUCTION_ORDER',
    'PRODUCING',
    'DONE_TO_WAREHOUSE',
  ];
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, requestId);
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      return order;
    }
    if (!allowedPreShipStates.includes(order.status)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot cancel-by-fulfiller in status ${order.status} — use reject or return after the shipment.`,
      );
    }
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET status = 'CANCELLED',
             closed_at = now(),
             closure_reason = 'cancelled_by_fulfiller'
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [requestId],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment cancel returned no row.');
    }
    await recordTransition(tx, requestId, order.status, 'CANCELLED', reason, actorUserId);
    await writeAudit(tx, {
      actorUserId,
      action: 'replenishment.cancel_by_fulfiller',
      entity: 'replenishment_requests',
      entityId: requestId,
      payload: { from: order.status, reason },
    });
    return updated;
  });
}

// -----------------------------------------------------------------------------
// 0024 — accept / reject / return (recipient-side closure recording)
// -----------------------------------------------------------------------------

/**
 * Stock invariant — Variant 2 (chosen 2026-05-28):
 *   * `SHIP_TO_REQUESTER -> CLOSED` already moved the full `shipQty` from
 *     `target_location_id` to `requester_location_id` (see
 *     `advanceShipToRequester`).
 *   * accept_full      => no counter-movement (recipient kept everything).
 *   * accept_partial   => counter-move `(qty_needed - qty_accepted)` from
 *                         requester back to target, reason='transfer'.
 *   * reject           => counter-move the full `shipment` qty back.
 *   * return (post-accept) => counter-move `qty_returned` back.
 *
 * Each helper is atomic — the closure_reason flip + the counter-movement
 * + the audit + the transition entry run inside ONE withTransaction.
 *
 * Idempotency: a second call on a request that already has `closure_reason`
 * set returns the row unchanged, so a double-tap from the UI cannot create
 * two counter-movements.
 */

/**
 * Accept the shipment (fully or partially).
 *
 * `qtyAccepted` is bounded by the request's `qty_needed` (or its
 * `shipment` qty when the request was partially shipped — Phase 2). When
 * `qtyAccepted === qty_needed` the closure_reason is `accepted_full`;
 * any value strictly less is `accepted_partial`, and the difference is
 * counter-shipped back to the target_location_id (so the ledger stays
 * net-zero against the original ship).
 */
export async function acceptShipment(opts: {
  requestId: number;
  qtyAccepted: number;
  note?: string | null;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyAccepted) || opts.qtyAccepted < 0) {
    throw AppError.validation('qty_accepted must be a number >= 0.');
  }
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.closure_reason !== null) {
      // Already finalised — second tap is a no-op (idempotent).
      return order;
    }
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot accept a shipment for a request in status ${order.status} — wait for SHIP_TO_REQUESTER to land.`,
      );
    }
    const qtyNeeded = Number(order.qty_needed);
    if (opts.qtyAccepted > qtyNeeded) {
      throw AppError.validation(
        `qty_accepted (${opts.qtyAccepted}) cannot exceed qty_needed (${qtyNeeded}).`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot accept — request has no target_location_id.');
    }
    const remainder = qtyNeeded - opts.qtyAccepted;
    const closureReason: ReplenishmentClosureReason =
      remainder === 0 ? 'accepted_full' : 'accepted_partial';

    let qtyReturned: number | null = null;
    if (remainder > 0) {
      // Counter-ship the unaccepted remainder back to the target. The
      // requester's stock was credited by the SHIP step, so this UPDATE
      // succeeds as long as the recipient still holds at least the
      // remainder — which they do unless they have sold it before
      // confirming acceptance (an edge case the operator can resolve via
      // a manual stock adjustment).
      await applyMovement(
        {
          productId: order.product_id,
          fromLocationId: order.requester_location_id,
          toLocationId: order.target_location_id,
          qty: remainder,
          reason: 'transfer',
          actorUserId: opts.actorUserId,
          replenishmentId: order.id,
          note: 'partial accept — remainder returned',
        },
        tx,
      );
      qtyReturned = remainder;
    }

    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = $2,
             qty_returned   = $3,
             accept_note    = $4,
             closure_reason = $5
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, opts.qtyAccepted, qtyReturned, opts.note ?? null, closureReason],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment accept returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `accept:${closureReason} qty=${opts.qtyAccepted}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        closure_reason: closureReason,
        qty_accepted: opts.qtyAccepted,
        qty_returned: qtyReturned,
      },
    });
    return updated;
  });
}

/**
 * Reject the entire shipment — the recipient refuses it. Counter-ships
 * the full shipped qty back to the target_location_id and stamps
 * `closure_reason='rejected'` + `reject_reason`. Requires the request
 * to be in CLOSED state (i.e. the SHIP step has already run) and not
 * already finalised.
 */
export async function rejectShipment(opts: {
  requestId: number;
  reason: string;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  const reasonClean = opts.reason.trim();
  if (reasonClean === '') {
    throw AppError.validation('reject reason must be a non-empty string.');
  }
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.closure_reason !== null) {
      return order;
    }
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot reject a shipment for a request in status ${order.status} — wait for SHIP_TO_REQUESTER to land.`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot reject — request has no target_location_id.');
    }
    const qtyNeeded = Number(order.qty_needed);
    await applyMovement(
      {
        productId: order.product_id,
        fromLocationId: order.requester_location_id,
        toLocationId: order.target_location_id,
        qty: qtyNeeded,
        reason: 'transfer',
        actorUserId: opts.actorUserId,
        replenishmentId: order.id,
        note: `reject: ${reasonClean}`,
      },
      tx,
    );
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = 0,
             qty_returned   = $2,
             reject_reason  = $3,
             closure_reason = 'rejected'
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, qtyNeeded, reasonClean],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment reject returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `reject:${reasonClean}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.reject',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: { closure_reason: 'rejected', reason: reasonClean, qty_returned: qtyNeeded },
    });
    return updated;
  });
}

/**
 * Return-after-accept: the recipient accepted the shipment earlier and
 * now wants to send `qtyReturned` back (e.g. a spoiled box). The request
 * must have been accepted (closure_reason in {accepted_full,
 * accepted_partial}) — a fresh request goes via accept/reject instead.
 *
 * The post-accept return is additive: `qty_accepted` shrinks by
 * `qtyReturned`, `qty_returned` grows. The closure_reason flips to
 * `'returned'` only when the cumulative qty_accepted reaches zero;
 * otherwise it stays at `accepted_partial` (a partial return on top of
 * a partial accept).
 */
export async function returnShipment(opts: {
  requestId: number;
  qtyReturned: number;
  reason: string;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyReturned) || opts.qtyReturned <= 0) {
    throw AppError.validation('qty_returned must be a number greater than zero.');
  }
  const reasonClean = opts.reason.trim();
  if (reasonClean === '') {
    throw AppError.validation('return reason must be a non-empty string.');
  }
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot return a shipment for a request in status ${order.status}.`,
      );
    }
    if (
      order.closure_reason !== 'accepted_full' &&
      order.closure_reason !== 'accepted_partial'
    ) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot return — request was not accepted (closure_reason=${order.closure_reason}).`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot return — request has no target_location_id.');
    }
    const currentAccepted = Number(order.qty_accepted ?? 0);
    if (opts.qtyReturned > currentAccepted) {
      throw AppError.validation(
        `qty_returned (${opts.qtyReturned}) cannot exceed currently-accepted qty (${currentAccepted}).`,
      );
    }
    await applyMovement(
      {
        productId: order.product_id,
        fromLocationId: order.requester_location_id,
        toLocationId: order.target_location_id,
        qty: opts.qtyReturned,
        reason: 'transfer',
        actorUserId: opts.actorUserId,
        replenishmentId: order.id,
        note: `return: ${reasonClean}`,
      },
      tx,
    );
    const newAccepted = currentAccepted - opts.qtyReturned;
    const previousReturned = Number(order.qty_returned ?? 0);
    const totalReturned = previousReturned + opts.qtyReturned;
    const newClosure: ReplenishmentClosureReason =
      newAccepted === 0 ? 'returned' : 'accepted_partial';

    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = $2,
             qty_returned   = $3,
             reject_reason  = COALESCE(reject_reason, $4),
             closure_reason = $5
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, newAccepted, totalReturned, reasonClean, newClosure],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment return returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `return:${reasonClean} qty=${opts.qtyReturned}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.return',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        closure_reason: newClosure,
        qty_returned: opts.qtyReturned,
        cumulative_qty_returned: totalReturned,
        remaining_qty_accepted: newAccepted,
      },
    });
    return updated;
  });
}

// -----------------------------------------------------------------------------
// advance() — the heart of the state machine (SM-2..SM-6)
// -----------------------------------------------------------------------------

/**
 * Advance one replenishment request by one step.
 *
 * The whole step (lock, guard check, document creation, stock movement,
 * status flip, transition row, audit row) runs inside ONE `withTransaction`,
 * which keeps the request consistent under concurrent calls (cron worker +
 * a user button) — `SELECT ... FOR UPDATE` serializes them (SM-6).
 *
 * Returns `{ advanced: false }` for:
 *   - terminal states (SM-5), and
 *   - wait states whose external guard has not yet fired (SM-4).
 *
 * Pass `tx` when an outer transaction is open (e.g. `finishProductionOrder`
 * commits the order flip and the request advance together — AC5.3, AC6.3);
 * the inner step then re-uses the outer tx instead of opening a nested one.
 *
 * Skip-state chaining (SM-7): when a single hop leaves the request in a
 * state whose next guard is also satisfied (e.g. `CREATE_PRODUCTION_ORDER`
 * after a `new -> done` jump on the production order), the engine chains
 * forward inside the same transaction. Each chained hop appends its own
 * `replenishment_transitions` row.
 */
export async function advance(
  requestId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<AdvanceResult> {
  const run = async (client: TxClient): Promise<AdvanceResult> => {
    const initial = await lockRequest(client, requestId);

    // SM-5: terminal states never advance.
    if (TERMINAL_STATUSES.includes(initial.status)) {
      return { advanced: false, request: initial, reason: 'terminal' };
    }

    let result = await advanceOne(client, initial, actorUserId);

    // SM-7 — chain forward inside the SAME transaction while the new state
    // is chain-eligible and the next guard is satisfied. The loop is bounded
    // by the forward state graph (CREATE_PRODUCTION_ORDER -> PRODUCING ->
    // DONE_TO_WAREHOUSE) so it terminates quickly; the safety counter is a
    // belt-and-braces against an unexpected cycle.
    let safety = 5;
    while (
      result.advanced &&
      !TERMINAL_STATUSES.includes(result.request.status) &&
      CHAINABLE_AFTER[result.request.status] &&
      safety > 0
    ) {
      safety -= 1;
      const next = await advanceOne(client, result.request, actorUserId);
      if (!next.advanced) {
        break;
      }
      result = next;
    }
    return result;
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}

/** Dispatch one step against the current status. */
async function advanceOne(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  switch (request.status) {
    case 'NEW':
      return advanceNew(tx, request, actorUserId);
    case 'CHECK_STORE_SUPPLIER':
      return advanceCheckStoreSupplier(tx, request, actorUserId);
    case 'SHIP_TO_REQUESTER':
      return advanceShipToRequester(tx, request, actorUserId);
    case 'CHECK_PRODUCTION_INPUT':
      return advanceCheckProductionInput(tx, request, actorUserId);
    case 'CREATE_PURCHASE_ORDER':
      return advanceWaitingForPurchase(tx, request, actorUserId);
    case 'CREATE_PRODUCTION_ORDER':
      return advanceCreateProductionOrder(tx, request, actorUserId);
    case 'PRODUCING':
      return advanceWaitingForProduction(tx, request, actorUserId);
    case 'DONE_TO_WAREHOUSE':
      return advanceDoneToWarehouse(tx, request, actorUserId);
    default:
      return { advanced: false, request, reason: 'unknown' };
  }
}

// -----------------------------------------------------------------------------
// Per-state advance handlers
// -----------------------------------------------------------------------------

/**
 * NEW -> CHECK_STORE_SUPPLIER. Guard: the chain rooted at the requester
 * contains a `type='central_warehouse'` location — that one becomes the
 * `target_location_id` (ADR-0001 §9). `parent_id` is NOT used directly:
 * with multi-hop chains (store -> supply -> central) the immediate parent
 * may not be the warehouse, but the SHIP_TO_REQUESTER step always pulls
 * from the central warehouse.
 */
async function advanceNew(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  const topology = await resolveTopology(tx, request.requester_location_id);
  if (topology.centralWarehouseLocationId === null) {
    return { advanced: false, request, reason: 'no central_warehouse in chain' };
  }
  const next = await transitionStatus(
    tx,
    request,
    'CHECK_STORE_SUPPLIER',
    'central warehouse resolved',
    actorUserId,
    { targetLocationId: topology.centralWarehouseLocationId },
  );
  // C1 (Sprint 3 audit) — spec §7 says `replenishment_created` is delivered
  // to BOTH the requester manager (already done at createRequest time, when
  // the target was not yet known) AND the target location manager. The
  // target is filled in by `advanceNew`, so this is the one place where the
  // target manager can be addressed. Dedupe key keeps re-runs idempotent.
  await notifyReplenishmentTargetSet(tx, next, actorUserId);
  return { advanced: true, request: next, reason: 'central warehouse resolved' };
}

/**
 * CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER (enough at target) OR
 *                        CHECK_PRODUCTION_INPUT (not enough).
 * Guard reads `target.stock.qty >= qty_needed` (spec section 3.3).
 */
async function advanceCheckStoreSupplier(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.target_location_id === null) {
    return { advanced: false, request, reason: 'target_location_id is null' };
  }
  const qtyNeeded = Number(request.qty_needed);
  const targetQty = await readStockQty(tx, request.target_location_id, request.product_id);
  if (targetQty >= qtyNeeded) {
    const next = await transitionStatus(
      tx,
      request,
      'SHIP_TO_REQUESTER',
      `target has ${targetQty} >= needed ${qtyNeeded}`,
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'enough at target' };
  }
  const next = await transitionStatus(
    tx,
    request,
    'CHECK_PRODUCTION_INPUT',
    `target has ${targetQty} < needed ${qtyNeeded}`,
    actorUserId,
  );
  return { advanced: true, request: next, reason: 'not enough at target' };
}

/**
 * CHECK_PRODUCTION_INPUT -> CREATE_PRODUCTION_ORDER (BOM raw is sufficient)
 *                        OR CREATE_PURCHASE_ORDER (a raw is short).
 *
 * The "production location" and "raw warehouse" are resolved from the
 * seeded topology: production = first ancestor of the requester whose
 * `type='production'`; raw warehouse = parent of that production location.
 * If they cannot be resolved the request is held (returns `advanced:false`).
 */
async function advanceCheckProductionInput(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  const topology = await resolveTopology(tx, request.requester_location_id);
  if (topology.productionLocationId === null) {
    return { advanced: false, request, reason: 'no production location in chain' };
  }
  if (topology.rawWarehouseLocationId === null) {
    return { advanced: false, request, reason: 'no raw warehouse in chain' };
  }

  // What does the BOM call for, given this request's qty?
  //
  // ADR-0016 / R3 — read ONLY the FINAL (decoration) lines for a finished
  // product whose recipe has been split into base/decoration. The base
  // (hamir) is produced separately as a zagatovka sub-order and arrives in
  // sex_storage as the `semi` component (consumed via the check-first loop
  // below). Reading base here too would transfer the hamir components twice.
  // A legacy flat recipe (all-base, no decoration) returns every line, so the
  // old single-pass behaviour is unchanged.
  const bom = await readFinalBom(tx, request.product_id);
  if (bom.length === 0) {
    // No recipe -> we cannot produce, so the only path is purchase the
    // finished product itself. Spec section 3 assumes recipes exist; we
    // hold the request rather than guess.
    return { advanced: false, request, reason: 'product has no BOM' };
  }
  const qtyNeeded = Number(request.qty_needed);

  // ADR-0015 / sub-task #4 — "sex storage check-first":
  // For every BOM component, BEFORE we hit the raw warehouse we first
  // look in the production sex's own sex_storage (the buffer of half-
  // finished goods that lives next to the sex floor). Whatever sits
  // there is consumed first; only the SHORTFALL is sourced from the
  // raw warehouse. This matches how bakers actually work — krem / hamr
  // produced earlier and parked in the sex skladi is used before fresh
  // raw is touched.
  //
  // Per-line accounting (sex_storage take + raw_warehouse need):
  //   sexTake = min(sexHave, need)          -- always >= 0
  //   rawNeed = need - sexTake              -- 0 if sex covered it all
  // The shortage list is now built from `rawNeed > rawHave`.
  type PerLine = {
    componentId: number;
    need: number;
    sexTake: number;
    rawNeed: number;
    rawHave: number;
  };
  const perLine: PerLine[] = [];
  for (const line of bom) {
    const need = Number(line.qty_per_unit) * qtyNeeded;
    const sexHave =
      topology.sexStorageLocationId !== null
        ? await readStockQty(tx, topology.sexStorageLocationId, line.component_product_id)
        : 0;
    const sexTake = Math.min(sexHave, need);
    const rawNeed = need - sexTake;
    const rawHave =
      rawNeed > 0
        ? await readStockQty(tx, topology.rawWarehouseLocationId, line.component_product_id)
        : 0;
    perLine.push({
      componentId: line.component_product_id,
      need,
      sexTake,
      rawNeed,
      rawHave,
    });
  }
  const shortages = perLine
    .filter((l) => l.rawNeed > l.rawHave)
    .map((l) => ({ componentId: l.componentId, need: l.rawNeed, have: l.rawHave }));

  if (shortages.length === 0) {
    // ADR-0001 §7 — every BOM component is transferred INTO the production
    // location BEFORE the production order is created. Without this step
    // the later `finishProductionOrder` flow would find an empty production
    // location and fail with INSUFFICIENT_STOCK. All transfers + PO insert
    // run inside the SAME transaction; one transfer failure rolls every
    // earlier transfer back.
    // ADR-0015 — when the sex_storage covered some / all of the need, we
    // first move FROM sex_storage TO production (reason='transfer'),
    // then move the remainder FROM raw_warehouse TO production.
    // ADR-0001 §9 — production output always lands in the central warehouse,
    // which is the request's `target_location_id` (filled at NEW).
    const targetLocationId =
      request.target_location_id ?? topology.centralWarehouseLocationId;
    for (const line of perLine) {
      if (line.sexTake > 0 && topology.sexStorageLocationId !== null) {
        await applyMovement(
          {
            productId: line.componentId,
            fromLocationId: topology.sexStorageLocationId,
            toLocationId: topology.productionLocationId,
            qty: line.sexTake,
            reason: 'transfer',
            actorUserId,
            replenishmentId: request.id,
            note: 'sex_storage first',
          },
          tx,
        );
      }
      if (line.rawNeed > 0) {
        await applyMovement(
          {
            productId: line.componentId,
            fromLocationId: topology.rawWarehouseLocationId,
            toLocationId: topology.productionLocationId,
            qty: line.rawNeed,
            reason: 'transfer',
            actorUserId,
            replenishmentId: request.id,
          },
          tx,
        );
      }
    }
    const productionOrderId = await createProductionOrderRow(tx, {
      productId: request.product_id,
      qty: qtyNeeded,
      locationId: topology.productionLocationId,
      targetLocationId,
      replenishmentId: request.id,
      actorUserId,
    });
    const reasonText =
      request.status === 'CREATE_PURCHASE_ORDER'
        ? 'create_purchase -> recheck production input -> raw sufficient'
        : 'raw inputs sufficient';
    const next = await transitionStatus(
      tx,
      request,
      'CREATE_PRODUCTION_ORDER',
      reasonText,
      actorUserId,
      { productionOrderId },
    );
    return { advanced: true, request: next, reason: 'raw sufficient -> production order' };
  }

  // One or more raws short. Create ONE purchase order for the FIRST shortage
  // (spec section 3.3 — purchase order created for missing component). When
  // multiple components are short, repeated `advance()` calls after each
  // purchase_received will create the next one if still short.
  // F2.3 (Phase-2) — the M:N `replenishment_purchase_orders` table is the
  // permanent home for every PO ever attached to this request, so the
  // earlier "unlink the previous PO before creating the next" step is no
  // longer necessary: `createPurchaseOrderRow` appends to the M:N table,
  // `transitionStatus` overwrites the deprecated single-FK column with the
  // latest PO id, and the full history stays queryable via the join table.
  const firstShortage = shortages[0];
  if (firstShortage === undefined) {
    throw AppError.internal('shortages array unexpectedly empty.');
  }
  const purchaseOrderId = await createPurchaseOrderRow(tx, {
    productId: firstShortage.componentId,
    qty: firstShortage.need - firstShortage.have, // purchase exactly the shortfall
    targetLocationId: topology.rawWarehouseLocationId,
    replenishmentId: request.id,
    actorUserId,
  });
  const next = await transitionStatus(
    tx,
    request,
    'CREATE_PURCHASE_ORDER',
    `raw component ${firstShortage.componentId} short`,
    actorUserId,
    { purchaseOrderId },
  );
  return { advanced: true, request: next, reason: 'raw short -> purchase order' };
}

/**
 * CREATE_PURCHASE_ORDER is a WAIT state (SM-4). It advances to
 * CREATE_PRODUCTION_ORDER only when the linked purchase order is `received`.
 * If still pending, returns `{ advanced: false }` — no error.
 */
async function advanceWaitingForPurchase(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.purchase_order_id === null) {
    return { advanced: false, request, reason: 'no linked purchase order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM purchase_orders WHERE id = $1',
    [request.purchase_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus !== 'received') {
    return { advanced: false, request, reason: `purchase order still ${poStatus ?? 'missing'}` };
  }
  // Raw is now in the warehouse — re-run the production-input check, which
  // will (usually) now succeed and create the production order. The next
  // transition logged is CREATE_PURCHASE_ORDER -> CREATE_PRODUCTION_ORDER
  // (or back to CREATE_PURCHASE_ORDER if another component is still short).
  // The reason text in the transition row will already be carried by the
  // inner `transitionStatus` call; this comment merely flags the from-state.
  return advanceCheckProductionInput(tx, request, actorUserId);
}

/**
 * CREATE_PRODUCTION_ORDER -> PRODUCING when the linked production order has
 * been flipped to `in_progress` (the production manager started it).
 */
async function advanceCreateProductionOrder(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.production_order_id === null) {
    return { advanced: false, request, reason: 'no linked production order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM production_orders WHERE id = $1',
    [request.production_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus === 'in_progress' || poStatus === 'done') {
    const next = await transitionStatus(
      tx,
      request,
      'PRODUCING',
      `production order is ${poStatus}`,
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'production started' };
  }
  return { advanced: false, request, reason: `production order is ${poStatus ?? 'missing'}` };
}

/**
 * PRODUCING is a WAIT state. Advances to DONE_TO_WAREHOUSE only when the
 * linked production order is `done` — by that point the production_order
 * service already moved BOM out and finished goods INTO the target location.
 */
async function advanceWaitingForProduction(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.production_order_id === null) {
    return { advanced: false, request, reason: 'no linked production order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM production_orders WHERE id = $1',
    [request.production_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus === 'done') {
    const next = await transitionStatus(
      tx,
      request,
      'DONE_TO_WAREHOUSE',
      'production complete',
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'production done' };
  }
  return { advanced: false, request, reason: `production order is ${poStatus ?? 'missing'}` };
}

/** DONE_TO_WAREHOUSE -> SHIP_TO_REQUESTER (the goods are now at target). */
async function advanceDoneToWarehouse(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  const next = await transitionStatus(
    tx,
    request,
    'SHIP_TO_REQUESTER',
    'output landed in warehouse',
    actorUserId,
  );
  return { advanced: true, request: next, reason: 'ready to ship' };
}

/**
 * SHIP_TO_REQUESTER -> CLOSED. Atomic transfer of
 * `min(qty_needed, target.qty)` from `target_location_id` to
 * `requester_location_id`. The request is then closed.
 */
async function advanceShipToRequester(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.target_location_id === null) {
    return { advanced: false, request, reason: 'no target location' };
  }
  const qtyNeeded = Number(request.qty_needed);
  const targetQty = await readStockQty(tx, request.target_location_id, request.product_id);
  if (targetQty <= 0) {
    return { advanced: false, request, reason: 'target has no stock to ship' };
  }
  const shipQty = Math.min(qtyNeeded, targetQty);

  const { movementId } = await applyMovement(
    {
      productId: request.product_id,
      fromLocationId: request.target_location_id,
      toLocationId: request.requester_location_id,
      qty: shipQty,
      reason: 'transfer',
      actorUserId,
      replenishmentId: request.id,
    },
    tx,
  );

  const { rows } = await tx.query<ReplenishmentRow>(
    `UPDATE replenishment_requests
     SET status = 'CLOSED', shipment_movement_id = $2, closed_at = now()
     WHERE id = $1
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    [request.id, movementId],
  );
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Replenishment close returned no row.');
  }
  await recordTransition(
    tx,
    request.id,
    'SHIP_TO_REQUESTER',
    'CLOSED',
    `shipped ${shipQty}`,
    actorUserId,
  );
  await writeAudit(tx, {
    actorUserId,
    action: 'replenishment.closed',
    entity: 'replenishment_requests',
    entityId: request.id,
    payload: { shipped_qty: shipQty, movement_id: movementId },
  });
  // M9 — shipment_created notification (spec §7). The shipment IS the
  // CLOSED transition, so this is the moment the requester location's
  // manager needs to know "your goods have left the warehouse". Best-effort
  // — a notification failure must not block the transfer.
  await notifyShipmentCreated(tx, request, shipQty, movementId);
  return { advanced: true, request: updated, reason: 'shipped' };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** SELECT ... FOR UPDATE on the request — serializes concurrent advances. */
async function lockRequest(tx: TxClient, requestId: number): Promise<ReplenishmentRow> {
  const { rows } = await tx.query<ReplenishmentRow>(
    `SELECT ${REPLENISHMENT_COLUMNS} FROM replenishment_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('Replenishment request not found.');
  }
  return row;
}

async function readStockQty(
  tx: TxClient,
  locationId: number,
  productId: number,
): Promise<number> {
  const { rows } = await tx.query<{ qty: number }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  const raw = rows[0]?.qty;
  return raw === undefined ? 0 : Number(raw);
}

/**
 * Apply a status flip + optional linked-document updates + the audit/transition
 * pair, then re-read the row. SM-2 is enforced here: the target status MUST
 * be reachable from the current one — else INVALID_TRANSITION.
 */
async function transitionStatus(
  tx: TxClient,
  request: ReplenishmentRow,
  to: ReplenishmentStatus,
  reason: string,
  actorUserId: number | null,
  links: {
    targetLocationId?: number;
    productionOrderId?: number;
    purchaseOrderId?: number;
  } = {},
): Promise<ReplenishmentRow> {
  if (!canTransition(request.status, to)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot transition replenishment ${request.id} from ${request.status} to ${to}.`,
    );
  }
  // SM-2 — DB-level guard. The expected-status `WHERE` clause makes the row
  // refuse the flip if another transaction has already moved it. Combined
  // with `lockRequest`'s `FOR UPDATE` this is belt-and-braces against
  // concurrent advances; without the application lock it is the sole guard.
  const sets: string[] = ['status = $3'];
  const params: (string | number | null)[] = [request.id, request.status, to];
  if (links.targetLocationId !== undefined) {
    params.push(links.targetLocationId);
    sets.push(`target_location_id = $${params.length}`);
  }
  if (links.productionOrderId !== undefined) {
    params.push(links.productionOrderId);
    sets.push(`production_order_id = $${params.length}`);
  }
  if (links.purchaseOrderId !== undefined) {
    params.push(links.purchaseOrderId);
    sets.push(`purchase_order_id = $${params.length}`);
  }
  const { rows, rowCount } = await tx.query<ReplenishmentRow>(
    `UPDATE replenishment_requests SET ${sets.join(', ')}
     WHERE id = $1 AND status = $2
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    params,
  );
  if (rowCount === 0) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Replenishment ${request.id} is no longer in ${request.status}; concurrent change blocked the transition.`,
    );
  }
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Replenishment status update returned no row.');
  }
  await recordTransition(tx, request.id, request.status, to, reason, actorUserId);
  return updated;
}

/** Append one row to `replenishment_transitions` (SM-1). */
async function recordTransition(
  tx: TxClient,
  replenishmentId: number,
  from: ReplenishmentStatus | null,
  to: ReplenishmentStatus,
  reason: string,
  actorUserId: number | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO replenishment_transitions
       (replenishment_id, from_status, to_status, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [replenishmentId, from, to, reason, actorUserId],
  );
}

/**
 * Resolve the chain topology starting at `requesterLocationId` by walking
 * `parent_id` until we hit either a `production` location (and then its
 * parent — the raw warehouse) or run out of parents. Pure SQL recursion via
 * a CTE so it is a single round trip.
 */
async function resolveTopology(
  tx: TxClient,
  requesterLocationId: number,
): Promise<{
  productionLocationId: number | null;
  rawWarehouseLocationId: number | null;
  centralWarehouseLocationId: number | null;
  /**
   * ADR-0015 — the sex_storage row that buffers half-finished goods and
   * ready-batch output between the production sex and the central
   * warehouse. Per migration 0022, every sex_storage's `parent_id`
   * points to the production sex floor that owns it; this field is
   * therefore the CHILD of `productionLocationId`. NULL when the chain
   * has no sex_storage (legacy chains still use raw_warehouse directly).
   */
  sexStorageLocationId: number | null;
}> {
  const { rows } = await tx.query<{ id: number; type: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, type, parent_id, 0 AS depth FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.type, l.parent_id, c.depth + 1
       FROM locations l JOIN chain c ON l.id = c.parent_id
     )
     SELECT id, type, depth FROM chain ORDER BY depth`,
    [requesterLocationId],
  );

  let productionLocationId: number | null = null;
  let rawWarehouseLocationId: number | null = null;
  let centralWarehouseLocationId: number | null = null;
  for (const row of rows) {
    if (centralWarehouseLocationId === null && row.type === 'central_warehouse') {
      centralWarehouseLocationId = row.id;
    }
    if (productionLocationId === null && row.type === 'production') {
      productionLocationId = row.id;
    }
    if (rawWarehouseLocationId === null && row.type === 'raw_warehouse') {
      rawWarehouseLocationId = row.id;
    }
  }

  // ADR-0015 — find the sex_storage CHILD of the production location. The
  // chain walk above goes UPWARD (requester -> raw_warehouse) and never
  // reaches the sex_storage (which is a sibling/child, not an ancestor).
  // We do a single targeted lookup. If the production sex has more than
  // one sex_storage child (rare but allowed by schema), we pick the
  // lowest id deterministically — the operator can rotate to a specific
  // buffer via the manual create endpoint.
  let sexStorageLocationId: number | null = null;
  if (productionLocationId !== null) {
    const { rows: sexRows } = await tx.query<{ id: number }>(
      `SELECT id FROM locations
        WHERE parent_id = $1 AND type = 'sex_storage'::location_type
        ORDER BY id LIMIT 1`,
      [productionLocationId],
    );
    if (sexRows[0] !== undefined) {
      sexStorageLocationId = Number(sexRows[0].id);
    }
  }

  return {
    productionLocationId,
    rawWarehouseLocationId,
    centralWarehouseLocationId,
    sexStorageLocationId,
  };
}

/** Create a `production_orders` row linked back to the request. */
async function createProductionOrderRow(
  tx: TxClient,
  opts: {
    productId: number;
    qty: number;
    locationId: number;
    targetLocationId: number | null;
    replenishmentId: number;
    actorUserId: number | null;
  },
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status, replenishment_id, created_by)
     VALUES ($1, $2, $3, $4, 'new', $5, $6)
     RETURNING id`,
    [
      opts.productId,
      opts.qty,
      opts.locationId,
      opts.targetLocationId,
      opts.replenishmentId,
      opts.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw AppError.internal('Production order insert returned no row.');
  }
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'production_order.create',
    entity: 'production_orders',
    entityId: id,
    payload: { product_id: opts.productId, qty: opts.qty, replenishment_id: opts.replenishmentId },
  });
  return id;
}

/**
 * Create a `purchase_orders` row in `draft` status linked back to the
 * request. Phase-2 (F2.3) — every PO is ALSO mirrored into the
 * `replenishment_purchase_orders` M:N join table. The legacy
 * `replenishment_requests.purchase_order_id` column keeps tracking the
 * latest PO during the transition (it is deprecated and dropped in
 * Phase-3); the M:N row is the permanent record so a request with several
 * shortages (and therefore several POs) keeps its full history.
 *
 * `ON CONFLICT DO NOTHING` on the M:N insert is a belt-and-braces against
 * the unusual case where this helper is called twice with the same PO id
 * within a single transaction — the PK guards the table either way.
 */
async function createPurchaseOrderRow(
  tx: TxClient,
  opts: {
    productId: number;
    qty: number;
    targetLocationId: number;
    replenishmentId: number;
    actorUserId: number | null;
  },
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status, replenishment_id, created_by)
     VALUES ($1, $2, $3, 'draft', $4, $5)
     RETURNING id`,
    [
      opts.productId,
      opts.qty,
      opts.targetLocationId,
      opts.replenishmentId,
      opts.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw AppError.internal('Purchase order insert returned no row.');
  }
  // F2.3 — dual-write to the M:N join table. The legacy column
  // (`replenishment_requests.purchase_order_id`) is updated by the caller
  // (transitionStatus links.purchaseOrderId); we keep the historical link
  // here so even after the deprecated column is removed (Phase-3) the
  // full PO list per request is reachable.
  await tx.query(
    `INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [opts.replenishmentId, id],
  );
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'purchase_order.create',
    entity: 'purchase_orders',
    entityId: id,
    payload: { product_id: opts.productId, qty: opts.qty, replenishment_id: opts.replenishmentId },
  });
  return id;
}

// -----------------------------------------------------------------------------
// Scan worker
// -----------------------------------------------------------------------------

/** One row produced by the below-min scan. */
export type BelowMinRow = {
  location_id: number;
  product_id: number;
  qty: number;
  min_level: number;
  max_level: number;
};

/** All `(location, product)` rows where `qty <= min_level` and `max > 0`. */
export async function scanBelowMin(): Promise<BelowMinRow[]> {
  const { rows } = await query<{
    location_id: number;
    product_id: number;
    qty: number;
    min_level: number;
    max_level: number;
  }>(
    `SELECT location_id, product_id, qty, min_level, max_level
     FROM stock
     WHERE qty <= min_level AND max_level > 0`,
  );
  return rows.map((r) => ({
    location_id: r.location_id,
    product_id: r.product_id,
    qty: Number(r.qty),
    min_level: Number(r.min_level),
    max_level: Number(r.max_level),
  }));
}

/**
 * Run one cycle of the engine:
 *   1. scan for `qty <= min_level` rows;
 *   2. for each row, ensure an open request exists (create if missing); the
 *      partial UNIQUE index plus the OPEN_REQUEST_EXISTS catch makes this
 *      idempotent — a duplicate scan never creates a duplicate request;
 *   3. step every NON-terminal open request forward once (`advance`).
 *
 * Returns a summary suitable for logging.
 */
export async function runEngineCycle(opts: { actorUserId?: number | null } = {}): Promise<{
  scanned: number;
  created: number;
  advanced: number;
}> {
  const actor = opts.actorUserId ?? null;
  const below = await scanBelowMin();
  let created = 0;
  for (const row of below) {
    // M9 — stock_below_min notification (spec §7). Fired for EVERY scan row,
    // not just rows that created a request: a long-running open request is
    // still a "below min" signal the location manager needs to see. The 24h
    // dedupe (`createNotification`'s `dedupeKey`) keeps the noise down.
    try {
      await withTransaction((tx) =>
        notifyStockBelowMin(tx, {
          productId: row.product_id,
          locationId: row.location_id,
          qty: row.qty,
          minLevel: row.min_level,
        }),
      );
    } catch (err) {
      // Notification failures must never block engine work — log and move on.
      console.error(
        '[replenishment-engine] stock_below_min notify failed:',
        (err as Error).message,
      );
    }

    const qtyNeeded = row.max_level - row.qty;
    if (qtyNeeded <= 0) {
      continue;
    }
    try {
      await createRequest({
        productId: row.product_id,
        requesterLocationId: row.location_id,
        qtyNeeded,
        actorUserId: actor,
      });
      created += 1;
    } catch (err) {
      if (err instanceof AppError && err.code === 'OPEN_REQUEST_EXISTS') {
        // Expected — the previous scan already raised a request for this row.
        continue;
      }
      throw err;
    }
  }

  // Step every non-terminal request once. A failure on one row must not stop
  // the whole cycle — the cron pass runs every five minutes, so an isolated
  // error stays visible in the log but the rest of the queue keeps moving.
  const { rows: open } = await query<{ id: number }>(
    `SELECT id FROM replenishment_requests
     WHERE status NOT IN ('CLOSED','CANCELLED')`,
  );
  let advanced = 0;
  for (const r of open) {
    try {
      const result = await advance(r.id, actor);
      if (result.advanced) {
        advanced += 1;
      }
    } catch (err) {
      console.error(
        `[replenishment-engine] advance(${r.id}) failed:`,
        (err as Error).message,
      );
    }
  }
  return { scanned: below.length, created, advanced };
}


// -----------------------------------------------------------------------------
// M9 — Notification helpers (spec §7)
// -----------------------------------------------------------------------------

/**
 * Fetch the product name + unit + the location name for one (product, location)
 * pair. Used by every notification message in this file.
 */
async function fetchProductAndLocation(
  tx: TxClient,
  productId: number,
  locationId: number,
): Promise<{
  productName: string;
  productUnit: string;
  locationName: string;
}> {
  const { rows } = await tx.query<{
    product_name: string;
    product_unit: string;
    location_name: string;
  }>(
    `SELECT p.name AS product_name, p.unit AS product_unit, l.name AS location_name
       FROM products p, locations l
      WHERE p.id = $1 AND l.id = $2`,
    [productId, locationId],
  );
  const row = rows[0];
  if (row === undefined) {
    return { productName: `#${productId}`, productUnit: '', locationName: `#${locationId}` };
  }
  return {
    productName: row.product_name,
    productUnit: row.product_unit,
    locationName: row.location_name,
  };
}

/**
 * Send a `stock_below_min` notification — once per (product, location) per
 * 24h (the dedupe key). The location manager is the recipient; if no
 * manager is set on the location the notification is skipped.
 */
async function notifyStockBelowMin(
  tx: TxClient,
  opts: {
    productId: number;
    locationId: number;
    qty: number;
    minLevel: number;
  },
): Promise<void> {
  const managerId = await getLocationManager(tx, opts.locationId);
  if (managerId === null) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    opts.productId,
    opts.locationId,
  );
  await createNotification(tx, {
    recipientUserId: managerId,
    type: 'stock_below_min',
    title: 'Ostatka min dan tushdi',
    body:
      `${productName} (${locationName}) — ${opts.qty} ${productUnit}, ` +
      `min: ${opts.minLevel} ${productUnit}.`,
    payload: {
      product_id: opts.productId,
      location_id: opts.locationId,
      qty: opts.qty,
      min_level: opts.minLevel,
    },
    // One Telegram per (product, location) per 24h (spec §2.9). The dedupe
    // key includes 'stock_below_min' so it never collides with another type.
    dedupeKey: `stock_below_min:${opts.productId}:${opts.locationId}`,
    dedupeWindowMinutes: 24 * 60,
  });
}

/**
 * Send a `replenishment_created` notification to the requester's manager
 * (and to the actor when the actor is not the manager). The target manager
 * is notified by the SHIP_TO_REQUESTER hop, since the target is unknown
 * at NEW time.
 */
async function notifyReplenishmentCreated(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  const recipients: number[] = [];
  if (requesterManagerId !== null) recipients.push(requesterManagerId);
  if (actorUserId !== null && !recipients.includes(actorUserId)) {
    recipients.push(actorUserId);
  }
  if (recipients.length === 0) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotificationsForRecipients(tx, recipients, {
    type: 'replenishment_created',
    title: `Yangi to'ldirish so'rovi #${request.id}`,
    body:
      `So'rov #${request.id}: ${productName} ${request.qty_needed} ${productUnit} ` +
      `— ${locationName} uchun.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty_needed: request.qty_needed,
      requester_location_id: request.requester_location_id,
    },
    // F3.3 / ADR-0011 — "Tezda bajarish" advances the request one hop,
    // "Ko'rish" sends a follow-up detail message. The dispatcher enforces
    // RBAC (pm or target-loc manager) at press time, so the buttons are
    // safe to attach for every recipient.
    inlineCallback: {
      buttons: [
        [
          { text: "🔄 Tezda bajarish", data: `fast:req:${request.id}` },
          { text: "📋 Ko'rish", data: `view:req:${request.id}` },
        ],
      ],
    },
  });
}

/**
 * C1 (Sprint 3 audit) — `replenishment_created` for the TARGET location
 * manager, fired right after `advanceNew` resolves the target. Spec §7
 * mandates that both managers see the request:
 *   - requester manager is notified at `createRequest` (target unknown);
 *   - target manager is notified here (the first hop that fills it).
 *
 * Dedupe key (`replenishment_created:target:<id>`) makes a re-advance of
 * the same row a no-op. The actor receives only the requester-side nudge.
 */
async function notifyReplenishmentTargetSet(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  if (request.target_location_id === null) return;
  const targetManagerId = await getLocationManager(tx, request.target_location_id);
  if (targetManagerId === null) return;
  // Spec §7 says "requester AND target manager"; if they happen to be the
  // same person (small chain), the dedupeKey on the requester-side nudge
  // already covers them — but here we suppress regardless to avoid two
  // pings landing on one person.
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  if (requesterManagerId === targetManagerId) return;
  const { productName, productUnit, locationName: requesterName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotification(tx, {
    recipientUserId: targetManagerId,
    type: 'replenishment_created',
    title: `Yangi to'ldirish so'rovi #${request.id}`,
    body:
      `Sizning omborga so'rov #${request.id}: ${productName} ${request.qty_needed} ${productUnit} ` +
      `— ${requesterName} uchun jo'natiladi.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty_needed: request.qty_needed,
      target_location_id: request.target_location_id,
      requester_location_id: request.requester_location_id,
      role: 'target',
      actor_user_id: actorUserId,
    },
    dedupeKey: `replenishment_created:target:${request.id}`,
    dedupeWindowMinutes: 24 * 60,
    // F3.3 — same inline buttons as the requester-side nudge: the target
    // manager is exactly the person allowed to fast-advance the request.
    inlineCallback: {
      buttons: [
        [
          { text: "🔄 Tezda bajarish", data: `fast:req:${request.id}` },
          { text: "📋 Ko'rish", data: `view:req:${request.id}` },
        ],
      ],
    },
  });
}

/**
 * Send a `shipment_created` notification to the requester's manager (the
 * goods have left the central warehouse). Best-effort.
 */
async function notifyShipmentCreated(
  tx: TxClient,
  request: ReplenishmentRow,
  shippedQty: number,
  movementId: number,
): Promise<void> {
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  if (requesterManagerId === null) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotification(tx, {
    recipientUserId: requesterManagerId,
    type: 'shipment_created',
    title: `Jo'natma yo'lda #${request.id}`,
    body:
      `Jo'natma: ${productName} ${shippedQty} ${productUnit} ` +
      `— ${locationName} uchun yo'lga chiqdi.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty: shippedQty,
      movement_id: movementId,
    },
  });
}
