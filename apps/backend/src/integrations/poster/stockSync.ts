/**
 * Stock sync — Poster `storage.getStorageLeftovers` -> ADIA `stock` (ADR-0002 §2).
 *
 * For every active `locations` row with `poster_storage_id` set:
 *   1. fetch the storage leftovers,
 *   2. for each leftover element (type=1 AND type=2 — both keyed by
 *      `ingredient_id` per ADR-0002 §1), resolve `products.poster_ingredient_id`,
 *   3. compare Poster `storage_ingredient_left` with ADIA `stock.qty`:
 *        - difference > 0 -> apply an `adjust` movement to align (invariant 1),
 *        - difference < 0 -> apply an `adjust` movement decreasing ADIA qty,
 *        - difference = 0 -> no-op.
 *   4. when Poster `storage_ingredient_left < 0` -> CLAMP ADIA qty to 0 and
 *      raise `negative_stock_detected` notification (invariant 3 — qty never
 *      negative; Poster bookkeeping anomalies are surfaced, not propagated).
 *
 * Idempotent — running the sync twice with no Poster movement is a no-op.
 */
import { applyMovement } from '../../services/stockMovement.js';
import { query, withTransaction } from '../../db/index.js';
import {
  createNotification,
  getLocationManager,
  getPmRecipients,
} from '../../services/notify.js';
import type { PosterClient, PosterLeftover } from './client.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
  type SyncTrigger,
} from './syncLog.js';

export type StockSyncResult = {
  readonly storagesScanned: number;
  readonly adjustments: number;
  readonly negativesClamped: number;
  readonly skippedNoProduct: number;
};

/** Read all active locations with a Poster storage id. */
async function listStorageLocations(): Promise<{ id: number; posterStorageId: number; name: string }[]> {
  const { rows } = await query<{ id: number; poster_storage_id: number; name: string }>(
    `SELECT id, poster_storage_id, name FROM locations
      WHERE poster_storage_id IS NOT NULL AND is_active = TRUE`,
  );
  return rows.map((r) => ({ id: r.id, posterStorageId: r.poster_storage_id, name: r.name }));
}

/** Resolve ADIA product_id for a Poster ingredient_id (the universal join key). */
async function resolveProductIdByIngredient(posterIngredientId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_ingredient_id = $1`,
    [posterIngredientId],
  );
  return rows[0]?.id ?? null;
}

/** Read the current ADIA qty for `(location, product)`, defaulting to 0. */
async function readQty(locationId: number, productId: number): Promise<number> {
  const { rows } = await query<{ qty: number }>(
    `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
    [locationId, productId],
  );
  return rows[0]?.qty ?? 0;
}

/**
 * Push a `negative_stock_detected` notification to PMs + the location manager.
 *
 * Debounce (C3 — Sprint 3 audit): one notification per (location, product)
 * per 24 hours. A negative-qty Poster row reappears on every 15-minute scan
 * until reconciled, and we must not spam PMs once they have seen it. The
 * dedupe key collapses both the PM and the manager nudge into the same
 * window so they all share one Telegram per 24h.
 */
async function notifyNegative(
  locationId: number,
  productId: number,
  posterQty: number,
): Promise<void> {
  try {
    await withTransaction(async (tx) => {
      const pmIds = await getPmRecipients(tx);
      const managerId = await getLocationManager(tx, locationId);
      const recipients = new Set<number>(pmIds);
      if (managerId !== null) recipients.add(managerId);
      for (const userId of recipients) {
        await createNotification(tx, {
          recipientUserId: userId,
          type: 'negative_stock_detected',
          title: 'Poster: negative stock detected',
          body: `Poster qty ${posterQty} at location ${locationId} for product ${productId}; clamped to 0.`,
          payload: { location_id: locationId, product_id: productId, poster_qty: posterQty },
          // Per-recipient scope — `createNotification` dedupes on the key
          // alone, so a single recipient-less key would let the FIRST
          // user's row suppress every other user's nudge.
          dedupeKey: `negative_stock_detected:${locationId}:${productId}:user:${userId}`,
          dedupeWindowMinutes: 24 * 60,
        });
      }
    });
  } catch (err) {
    console.error('[poster] notifyNegative swallow:', redactUrl((err as Error).message));
  }
}

/**
 * Apply one Poster leftover row to ADIA stock. Returns one of:
 *   - 'no-product' when no ADIA product matches the Poster ingredient_id;
 *   - 'noop'       when qty matches and no clamp was needed;
 *   - 'adjusted'   when one or more `adjust` movements were written;
 *   - 'clamped'    when negative Poster qty triggered a clamp + notification.
 */
async function applyLeftover(
  locationId: number,
  leftover: PosterLeftover,
): Promise<'no-product' | 'noop' | 'adjusted' | 'clamped'> {
  const posterIngredientId = Number(leftover.ingredient_id);
  if (!Number.isInteger(posterIngredientId) || posterIngredientId <= 0) return 'no-product';

  const productId = await resolveProductIdByIngredient(posterIngredientId);
  if (productId === null) return 'no-product';

  // Persist unit cost price from Poster whenever it is provided.
  // Only write > 0 values — a 0 prime_cost in Poster means "no cost data",
  // not an actual zero-cost ingredient. Writing 0 would overwrite valid historical
  // cost prices from earlier sync runs.
  if (leftover.prime_cost !== undefined) {
    const pc = Number(leftover.prime_cost);
    if (Number.isFinite(pc) && pc > 0) {
      await query(
        `UPDATE products SET cost_price = $1, updated_at = now()
         WHERE id = $2 AND cost_price IS DISTINCT FROM $1`,
        [pc, productId],
      );
    } else if (leftover.storage_ingredient_sum !== undefined && leftover.storage_ingredient_left !== undefined) {
      // Fallback: when prime_cost = 0 or missing, derive cost from sum/qty ratio.
      // storage_ingredient_sum is in so'm, storage_ingredient_left is in the ingredient unit (kg/l/pcs).
      // Only apply when current stored qty > 0 and sum > 0. Only fills NULL or 0 cost_price — never
      // overwrites a valid value that came from a previous prime_cost.
      const sum = Number(leftover.storage_ingredient_sum);
      const left = Number(leftover.storage_ingredient_left);
      if (Number.isFinite(sum) && sum > 0 && Number.isFinite(left) && left > 0) {
        const derivedCost = Math.round(sum / left);
        await query(
          `UPDATE products SET cost_price = $1, updated_at = now()
           WHERE id = $2
             AND (cost_price IS NULL OR cost_price = 0)
             AND cost_price IS DISTINCT FROM $1`,
          [derivedCost, productId],
        );
      }
    }
  }

  const posterQty = Number(leftover.storage_ingredient_left);
  if (!Number.isFinite(posterQty)) return 'noop';

  // Negative Poster qty is a bookkeeping artefact — clamp to 0 in ADIA and
  // notify, never write a negative row (invariant 3).
  if (posterQty < 0) {
    const current = await readQty(locationId, productId);
    if (current > 0) {
      await applyMovement({
        productId,
        fromLocationId: locationId,
        toLocationId: null,
        qty: current,
        reason: 'adjust',
        actorUserId: null,
        note: `Poster clamp: storage_ingredient_left=${posterQty}`,
      });
    }
    await notifyNegative(locationId, productId, posterQty);
    return 'clamped';
  }

  const current = await readQty(locationId, productId);
  const diff = posterQty - current;
  // Tolerate float noise — 0.0001 is below the schema precision.
  if (Math.abs(diff) < 0.0001) return 'noop';

  if (diff > 0) {
    // ADIA below Poster — receipt the difference.
    await applyMovement({
      productId,
      fromLocationId: null,
      toLocationId: locationId,
      qty: diff,
      reason: 'adjust',
      actorUserId: null,
      note: 'Poster leftover reconcile (+)',
    });
  } else {
    // ADIA above Poster — issue the absolute difference.
    await applyMovement({
      productId,
      fromLocationId: locationId,
      toLocationId: null,
      qty: -diff,
      reason: 'adjust',
      actorUserId: null,
      note: 'Poster leftover reconcile (-)',
    });
  }
  return 'adjusted';
}

/**
 * One run of the leftover sync over every Poster-mapped location.
 * Returns a per-run summary that the worker logs and the sync log records.
 */
export async function syncStockLeftovers(
  client: PosterClient,
  trigger: SyncTrigger = 'poll',
): Promise<StockSyncResult> {
  const runId = await startSyncRun('leftovers', trigger);
  const summary: { storagesScanned: number; adjustments: number; negativesClamped: number; skippedNoProduct: number } =
    { storagesScanned: 0, adjustments: 0, negativesClamped: 0, skippedNoProduct: 0 };
  let recordsIn = 0;
  let recordsApplied = 0;
  try {
    const locations = await listStorageLocations();
    for (const loc of locations) {
      let leftovers: PosterLeftover[];
      try {
        leftovers = await client.getStorageLeftovers(loc.posterStorageId);
      } catch (err) {
        console.error(
          `[poster] leftovers for storage_id=${loc.posterStorageId} failed:`,
          (err as Error).message,
        );
        continue;
      }
      summary.storagesScanned += 1;
      recordsIn += leftovers.length;
      for (const lo of leftovers) {
        try {
          const outcome = await applyLeftover(loc.id, lo);
          if (outcome === 'no-product') summary.skippedNoProduct += 1;
          else if (outcome === 'adjusted') {
            summary.adjustments += 1;
            recordsApplied += 1;
          } else if (outcome === 'clamped') {
            summary.negativesClamped += 1;
            recordsApplied += 1;
          }
        } catch (err) {
          console.error(
            '[poster] leftover row failed for ingredient_id=',
            lo.ingredient_id,
            (err as Error).message,
          );
        }
      }
    }
    await finishSyncRun(runId, 'ok', { recordsIn, recordsApplied });
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn, recordsApplied }, detail);
    await notifyPosterSyncFailed('leftovers', detail);
    throw err;
  }
}
