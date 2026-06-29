/**
 * M5 — Production order service (spec section 2.5, invariant 5).
 *
 * The "tayyor" (done) flow turns one production order into stock changes,
 * all inside ONE atomic transaction (`withTransaction`):
 *   - for every BOM line: consume `qty_per_unit * order.qty` of the component
 *     out of the production location (`production_input` movement);
 *   - produce `order.qty` of the output product into the target location
 *     (`production_output` movement) — typically the central warehouse;
 *   - flip the order to `done` and stamp `done_at`.
 * If ANY component is short, the whole transaction rolls back — nothing
 * changes (AC5.2). `applyMovement` is reused so each movement keeps its own
 * guarded decrement, ledger row and audit row (invariant 1).
 *
 * The status path is `new -> in_progress -> done` (plus `cancelled`); only a
 * forward step is allowed (`finishProductionOrder` handles `-> done`).
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { applyMovement } from './stockMovement.js';
import { readBaseBom, readFinalBom } from './bom.js';
import {
  createNotificationsForRecipients,
  getLocationManager,
  getUsersByRole,
} from './notify.js';

export type ProductionOrderRow = {
  id: number;
  product_id: number;
  qty: number;
  location_id: number;
  target_location_id: number | null;
  deadline: string | null;
  status: string;
  replenishment_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  done_at: Date | null;
  /** ADR-0016 — 'final' (finished cake) | 'zagatovka' (base/70%% sub-order). */
  stage_role: string;
  /** ADR-0016 — final order a zagatovka sub-order was raised for (else null). */
  parent_production_order_id: number | null;
};

export const PRODUCTION_ORDER_COLUMNS = `id, product_id, qty, location_id,
  target_location_id, deadline, status, replenishment_id, note, created_by,
  created_at, updated_at, done_at, stage_role, parent_production_order_id`;

/**
 * Run the atomic "done" flow for a production order WITHIN an existing
 * transaction. The caller (route handler or state machine) owns the
 * transaction so the order flip and the replenishment advance can commit
 * together. Throws `INSUFFICIENT_STOCK` (409) when a BOM component is short
 * — the surrounding transaction then rolls back (AC5.1, AC5.2, invariant 5).
 *
 * @returns the movement ids produced (consumption lines + the output line).
 */
export async function consumeBomAndProduce(
  tx: TxClient,
  order: ProductionOrderRow,
  actorUserId: number | null,
): Promise<{ inputMovementIds: number[]; outputMovementId: number }> {
  const orderQty = Number(order.qty);

  // If no explicit target, the output stays in the production location itself
  // (typical for zagatovka sub-orders that produce a semi-finished component
  // which the parent order will later consume from the same sex).
  const outputLocationId = order.target_location_id ?? order.location_id;

  // BOM lines for the produced product.
  //
  // ADR-0016 / R3 — which lines we consume depends on the order's stage_role:
  //   * 'zagatovka' — a base/70%% sub-order: consume the BASE (hamir) lines and
  //                   output the semi zagatovka into sex_storage.
  //   * 'final'     — the finished cake: consume the DECORATION lines (krem +
  //                   bezak + the semi zagatovka component) and output the
  //                   finished cake into the central warehouse.
  // A legacy flat recipe (all-base, no decoration) makes `readFinalBom` return
  // every line, so the pre-ADR-0016 single-pass flow is unchanged.
  const bom =
    order.stage_role === 'zagatovka'
      ? await readBaseBom(tx, order.product_id)
      : await readFinalBom(tx, order.product_id);
  if (bom.length === 0) {
    throw AppError.validation(
      `Product ${order.product_id} has no recipe (BOM) for stage_role=` +
        `${order.stage_role}; cannot run the production flow.`,
    );
  }

  // Consume every component out of the production location. `applyMovement`'s
  // guarded decrement raises INSUFFICIENT_STOCK if a component is short — the
  // transaction then rolls back, so partial consumption is impossible.
  const inputMovementIds: number[] = [];
  for (const line of bom) {
    const needed = Number(line.qty_per_unit) * orderQty;
    const { movementId } = await applyMovement(
      {
        productId: line.component_product_id,
        fromLocationId: order.location_id,
        toLocationId: null,
        qty: needed,
        reason: 'production_input',
        actorUserId,
        productionOrderId: order.id,
      },
      tx,
    );
    inputMovementIds.push(movementId);
  }

  // Produce the output into the target location (or the production location
  // itself when no explicit target is set — see outputLocationId above).
  const { movementId: outputMovementId } = await applyMovement(
    {
      productId: order.product_id,
      fromLocationId: null,
      toLocationId: outputLocationId,
      qty: orderQty,
      reason: 'production_output',
      actorUserId,
      productionOrderId: order.id,
    },
    tx,
  );

  return { inputMovementIds, outputMovementId };
}

/**
 * Transition a production order to `done`, running the atomic BOM flow.
 * Opens its own transaction unless one is supplied. The order must currently
 * be `new` or `in_progress`.
 */
export async function finishProductionOrder(
  orderId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<ProductionOrderRow> {
  const run = async (client: TxClient): Promise<ProductionOrderRow> => {
    // Lock the order row so two concurrent "done" calls serialize (no double
    // BOM consumption).
    const { rows } = await client.query<ProductionOrderRow>(
      `SELECT ${PRODUCTION_ORDER_COLUMNS} FROM production_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (order === undefined) {
      throw AppError.notFound('Production order not found.');
    }
    if (order.status === 'done') {
      // Idempotent: already done — return as-is, do not consume BOM again.
      return order;
    }
    if (order.status !== 'new' && order.status !== 'in_progress') {
      throw AppError.validation(
        `Cannot finish a production order in status "${order.status}".`,
      );
    }

    await consumeBomAndProduce(client, order, actorUserId);

    const { rows: updated } = await client.query<ProductionOrderRow>(
      `UPDATE production_orders SET status = 'done', done_at = now()
       WHERE id = $1
       RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      [orderId],
    );
    const result = updated[0];
    if (result === undefined) {
      throw AppError.internal('Production order done update returned no row.');
    }

    await writeAudit(client, {
      actorUserId,
      action: 'production_order.done',
      entity: 'production_orders',
      entityId: orderId,
      payload: { product_id: order.product_id, qty: Number(order.qty) },
    });

    // M9 — production_order_done notification (spec §7). The output landed
    // in `target_location_id` (the central warehouse). Notify that
    // warehouse's manager plus every `pm` user. Same transaction — if the
    // BOM consume + ledger write rolls back, no orphan notification is
    // left in `notifications`.
    if (order.target_location_id !== null) {
      const recipients: number[] = [];
      const cwManager = await getLocationManager(client, order.target_location_id);
      if (cwManager !== null) recipients.push(cwManager);
      // Every active `central_warehouse_manager` (in case multiple warehouses
      // exist) — and every `pm` for chain-wide visibility.
      const cwRoleHolders = await getUsersByRole(client, 'central_warehouse_manager');
      for (const id of cwRoleHolders) if (!recipients.includes(id)) recipients.push(id);
      const pms = await getUsersByRole(client, 'pm');
      for (const id of pms) if (!recipients.includes(id)) recipients.push(id);

      if (recipients.length > 0) {
        const { rows: ctx } = await client.query<{
          product_name: string;
          product_unit: string;
        }>(
          `SELECT name AS product_name, unit AS product_unit
             FROM products WHERE id = $1`,
          [order.product_id],
        );
        const productName = ctx[0]?.product_name ?? `#${order.product_id}`;
        const productUnit = ctx[0]?.product_unit ?? '';
        await createNotificationsForRecipients(client, recipients, {
          type: 'production_order_done',
          title: `Zayafka tayyor #${orderId}`,
          body:
            `Zayafka #${orderId} tayyor: ${Number(order.qty)} ${productUnit} ` +
            `${productName} markaziy skladga keldi.`,
          payload: {
            production_order_id: orderId,
            product_id: order.product_id,
            qty: Number(order.qty),
            target_location_id: order.target_location_id,
          },
        });
      }
    }

    return result;
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}
