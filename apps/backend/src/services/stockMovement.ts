/**
 * M3 — atomic stock movement service (ADR-0003, invariants 1 & 3).
 *
 * `applyMovement` performs ONE stock movement as ONE atomic transaction:
 *   - source `stock.qty` decreases (guarded — never goes negative);
 *   - destination `stock.qty` increases (upsert);
 *   - one `stock_movements` ledger row is appended;
 *   - one `audit_log` row is written.
 * All four succeed together or the whole transaction rolls back.
 *
 * Endpoint shapes (spec section 4.4):
 *   - from set, to unset      -> issue   (chiqim)
 *   - from unset, to set      -> receipt (kirim)
 *   - both set                -> transfer
 *
 * The guarded decrement `UPDATE ... WHERE qty >= :qty` is the primary defence
 * against a negative balance; the DB `CHECK (qty >= 0)` is the last line of
 * defence (ADR-0003 section 3). A `SELECT`-then-`UPDATE` read-modify-write is
 * NEVER used — it would allow overselling under concurrency.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';

/** A movement reason — mirrors the `movement_reason` DB enum. */
export const MOVEMENT_REASONS = [
  'sale',
  'production_input',
  'production_output',
  'transfer',
  'purchase',
  'adjust',
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

export type MovementInput = {
  readonly productId: number;
  readonly fromLocationId: number | null;
  readonly toLocationId: number | null;
  readonly qty: number;
  readonly reason: MovementReason;
  readonly note?: string | null;
  /** The acting user id, or `null` for system/cron movements. */
  readonly actorUserId: number | null;
  /** Optional originating-document links (replenishment / orders). */
  readonly replenishmentId?: number | null;
  readonly productionOrderId?: number | null;
  readonly purchaseOrderId?: number | null;
  /**
   * When true, the source decrement is not guarded — stock may go negative.
   * Use only for production-dispatch receives where the physical transfer
   * already happened and the warehouse owes the difference.
   */
  readonly allowNegative?: boolean;
};

export type MovementResult = {
  readonly movementId: number;
};

/**
 * Decrement a source `stock` row by `qty`, guarded so it can never go
 * negative. Throws `INSUFFICIENT_STOCK` (409) when the row is missing or
 * holds less than `qty` — leaving stock unchanged (AC3.2).
 */
async function guardedDecrement(
  tx: TxClient,
  locationId: number,
  productId: number,
  qty: number,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE stock SET qty = qty - $1
     WHERE location_id = $2 AND product_id = $3 AND qty >= $1`,
    [qty, locationId, productId],
  );
  if (rowCount === 0) {
    // Either no stock row exists or qty < requested — both are insufficient.
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `Insufficient stock at location ${locationId} for product ${productId}.`,
    );
  }
}

/**
 * Decrement a source `stock` row by `qty` without a guard — stock may go
 * negative. Used only for production-dispatch receives where the physical
 * handoff already occurred. Upserts a negative row if none exists.
 */
async function forceDecrement(
  tx: TxClient,
  locationId: number,
  productId: number,
  qty: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO stock (location_id, product_id, qty)
     VALUES ($1, $2, 0 - $3::numeric)
     ON CONFLICT (location_id, product_id)
     DO UPDATE SET qty = stock.qty - $3::numeric`,
    [locationId, productId, qty],
  );
}

/** Increment (upsert) a destination `stock` row by `qty`. */
async function increment(
  tx: TxClient,
  locationId: number,
  productId: number,
  qty: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO stock (location_id, product_id, qty)
     VALUES ($1, $2, $3)
     ON CONFLICT (location_id, product_id)
     DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
    [locationId, productId, qty],
  );
}

/**
 * Apply one stock movement atomically. Accepts an optional existing
 * transaction (`tx`) so callers like the production "done" flow can include
 * several movements in a single transaction; when omitted, it opens its own.
 */
export async function applyMovement(
  input: MovementInput,
  tx?: TxClient,
): Promise<MovementResult> {
  validateInput(input);

  const run = async (client: TxClient): Promise<MovementResult> => {
    if (input.fromLocationId !== null) {
      if (input.allowNegative) {
        await forceDecrement(client, input.fromLocationId, input.productId, input.qty);
      } else {
        await guardedDecrement(client, input.fromLocationId, input.productId, input.qty);
      }
    }
    if (input.toLocationId !== null) {
      await increment(client, input.toLocationId, input.productId, input.qty);
    }

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO stock_movements
         (product_id, from_location_id, to_location_id, qty, reason,
          replenishment_id, production_order_id, purchase_order_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.productId,
        input.fromLocationId,
        input.toLocationId,
        input.qty,
        input.reason,
        input.replenishmentId ?? null,
        input.productionOrderId ?? null,
        input.purchaseOrderId ?? null,
        input.note ?? null,
        input.actorUserId,
      ],
    );
    const movement = rows[0];
    if (movement === undefined) {
      throw AppError.internal('Stock movement insert returned no row.');
    }

    await writeAudit(client, {
      actorUserId: input.actorUserId,
      action: 'stock_movement.create',
      entity: 'stock_movements',
      entityId: movement.id,
      payload: {
        product_id: input.productId,
        from_location_id: input.fromLocationId,
        to_location_id: input.toLocationId,
        qty: input.qty,
        reason: input.reason,
      },
    });

    return { movementId: movement.id };
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}

/** Validate movement shape before any SQL runs (spec section 4.4 rules). */
function validateInput(input: MovementInput): void {
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw AppError.validation('Movement "qty" must be greater than zero.');
  }
  if (input.fromLocationId === null && input.toLocationId === null) {
    throw AppError.validation('A movement needs a from_location_id or a to_location_id.');
  }
  if (
    input.fromLocationId !== null &&
    input.toLocationId !== null &&
    input.fromLocationId === input.toLocationId
  ) {
    throw AppError.validation('from_location_id and to_location_id must differ.');
  }
}
