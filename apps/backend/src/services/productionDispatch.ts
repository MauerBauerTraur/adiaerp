/**
 * production_dispatches — the stock movement of a dispatch happens EXACTLY
 * ONCE (ADR-0019 §11.1 P1/P2), whichever channel acts first:
 *
 *   - web "Berildi"        PATCH /api/production-orders/dispatches/:id/dispatch
 *                          PATCH /api/production-orders/dispatches/batch-dispatch
 *   - web "Qabul qilindi"  PATCH /api/production-orders/dispatches/:id/receive
 *                          PATCH /api/production-orders/dispatches/batch-receive
 *   - Telegram             rcv:dsp (integrations/telegram/dispatch.ts)
 *
 * The guard is `production_dispatches.movement_id`: it is set in the SAME
 * transaction as the movement, and every channel checks it under a row lock
 * (`SELECT … FOR UPDATE`), so two channels acting at the same moment
 * serialise and only the first one moves stock.
 *
 * Output dispatches (the order's own product, production -> warehouse) are
 * special: `done` already writes the output into the order's target
 * (`consumeBomAndProduce`, reason production_output). Their transfer is
 * therefore never applied before `done` (the product does not exist yet),
 * and after `done` only when the output did NOT already land at the
 * dispatch's destination; when it did, the dispatch is linked to the
 * production_output movement instead of moving it a second time.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { applyMovement } from './stockMovement.js';

type LockedDispatch = {
  id: number;
  production_order_id: number;
  product_id: number;
  qty_needed: number;
  status: string;
  from_location_id: number | null;
  to_location_id: number | null;
  movement_id: number | null;
};

async function lockDispatch(tx: TxClient, dispatchId: number): Promise<LockedDispatch | undefined> {
  const { rows } = await tx.query<LockedDispatch>(
    `SELECT id, production_order_id, product_id, qty_needed::float AS qty_needed, status,
            from_location_id, to_location_id, movement_id
       FROM production_dispatches WHERE id = $1 FOR UPDATE`,
    [dispatchId],
  );
  return rows[0];
}

/**
 * Make sure the dispatch's stock movement exists, applying it only if it has
 * not happened yet. Runs in the caller's transaction and returns the
 * movement id (null when the dispatch moves nothing: no route, same place,
 * or an output that is not made yet).
 */
export async function ensureDispatchMovement(
  tx: TxClient,
  dispatchId: number,
  actorUserId: number | null,
): Promise<number | null> {
  const d = await lockDispatch(tx, dispatchId);
  if (d === undefined) return null;
  if (d.movement_id !== null) return Number(d.movement_id); // already moved — never again
  const from = d.from_location_id === null ? null : Number(d.from_location_id);
  const to = d.to_location_id === null ? null : Number(d.to_location_id);
  if (from === null || to === null || from === to) return null;

  const { rows: orderRows } = await tx.query<{
    product_id: number; status: string; location_id: number; target_location_id: number | null;
  }>(
    `SELECT product_id, status, location_id, target_location_id
       FROM production_orders WHERE id = $1`,
    [d.production_order_id],
  );
  const order = orderRows[0];
  if (order !== undefined && Number(order.product_id) === Number(d.product_id)) {
    // Output dispatch (P2). Before `done` the product does not exist yet.
    if (order.status !== 'done') return null;
    const outputLocation = Number(order.target_location_id ?? order.location_id);
    if (outputLocation === to) {
      // `done` already put the output here — link it, do not move it again.
      const { rows: out } = await tx.query<{ id: number }>(
        `SELECT id FROM stock_movements
          WHERE production_order_id = $1 AND product_id = $2 AND reason = 'production_output'
          ORDER BY id DESC LIMIT 1`,
        [d.production_order_id, d.product_id],
      );
      const outputMovementId = out[0] === undefined ? null : Number(out[0].id);
      if (outputMovementId !== null) {
        await tx.query('UPDATE production_dispatches SET movement_id = $2 WHERE id = $1', [d.id, outputMovementId]);
      }
      return outputMovementId;
    }
  }

  const { movementId } = await applyMovement(
    {
      productId: Number(d.product_id),
      fromLocationId: from,
      toLocationId: to,
      qty: Number(d.qty_needed),
      reason: 'transfer',
      actorUserId,
      productionOrderId: Number(d.production_order_id),
      allowNegative: true,
    },
    tx,
  );
  await tx.query('UPDATE production_dispatches SET movement_id = $2 WHERE id = $1', [d.id, movementId]);
  return movementId;
}

/** Thrown when the dispatch is no longer 'dispatched' (e.g. another channel won). */
export const NOT_DISPATCHED_MESSAGE = "Faqat 'berildi' holatidagi yozuvni qabul qilish mumkin.";

/**
 * "Qabul qilindi": in ONE transaction, lock the dispatch, require status
 * 'dispatched', apply its movement if (and only if) it has not happened yet,
 * and flip it to 'received'. Returns the updated row.
 */
export async function receiveDispatch(
  dispatchId: number,
  actorUserId: number,
): Promise<Record<string, unknown>> {
  return withTransaction(async (tx) => {
    const d = await lockDispatch(tx, dispatchId);
    if (d === undefined) throw AppError.notFound('Dispatch record not found.');
    if (d.status !== 'dispatched') throw AppError.validation(NOT_DISPATCHED_MESSAGE);
    await ensureDispatchMovement(tx, dispatchId, actorUserId);
    const { rows } = await tx.query<Record<string, unknown>>(
      `UPDATE production_dispatches
          SET status = 'received', received_at = NOW(), received_by = $2
        WHERE id = $1
        RETURNING *`,
      [dispatchId, actorUserId],
    );
    return rows[0]!;
  });
}
