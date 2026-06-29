/**
 * Dynamic min/max recalc cron — Phase-2 F2.1 (TZ §8.3, ADR-0007 §4, spec §5.2).
 *
 * Schedule: `0 4 * * *` (every day at 04:00 UTC = 09:00 Toshkent), one hour
 * after the sales aggregate cron (03:00) so the 7-day / 30-day window is
 * fresh.
 *
 * Pseudo-code:
 *
 *   for row in stock WHERE minmax_mode = 'dynamic':
 *     loc      = locations[row.location_id]                 -- read formula inputs
 *     stats    = sales_stats_daily ORDER BY stat_date DESC LIMIT 1
 *     avg      = stats.avg_7d ?? stats.avg_30d
 *     if avg is null or avg < EPSILON:
 *         skip → import_warnings info "no sales history"
 *         stamp last_recalc_at, continue
 *     min_new  = round(avg * loc.lead_time_days * loc.safety_factor, 4)
 *     max_new  = round(min_new + avg * loc.review_days, 4)
 *     if max_new < EPSILON:
 *         skip → import_warnings warning "would zero out min/max"
 *         stamp last_recalc_at, continue
 *     UPDATE stock SET min_level, max_level, last_recalc_at = now()
 *       WHERE ... AND minmax_mode = 'dynamic'                -- race guard
 *     INSERT INTO audit_log (...)
 *
 * Each row is its own transaction. A failure on one row logs an error and
 * the cron moves on; the engine never aborts halfway.
 *
 * The `WHERE minmax_mode = 'dynamic'` guard on the UPDATE protects against
 * the race where the manager flips a row to 'manual' between our pre-read
 * and the write — without it we would overwrite a manual override.
 *
 * Manual-trigger contract: `POST /api/admin/recalc-minmax` calls
 * `runMinmaxRecalcCycle({ filter })` synchronously and waits for the
 * summary. The filter narrows the iteration to one (location, product) or
 * one location; without a filter every dynamic row is processed.
 */
import cron from 'node-cron';
import { query, withTransaction, type TxClient } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { recordImportWarning } from '../services/importWarnings.js';

/** node-cron expression — every day at 04:00 (sales aggregate at 03:00 first). */
export const MINMAX_RECALC_SCHEDULE = '0 4 * * *';

/** Floor below which a tiny `avg_daily` is treated as "no usable history". */
const EPSILON = 0.001;

let task: cron.ScheduledTask | undefined;

export const cronGuard: { running: boolean } = { running: false };

export type MinmaxRecalcSummary = {
  /** Rows considered (dynamic-mode rows matching the optional filter). */
  readonly scanned: number;
  /** Rows whose min_level / max_level were updated. */
  readonly updated: number;
  /** Rows skipped (no sales history, would-zero guard, or no-op). */
  readonly skipped: number;
  /** Rows whose transaction failed (audit + error log). */
  readonly errors: number;
};

export type MinmaxRecalcFilter = {
  readonly locationId?: number;
  readonly productId?: number;
};

export function startMinmaxRecalcWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(MINMAX_RECALC_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopMinmaxRecalcWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — overlap guard + unfiltered recalc. */
export async function runOneCycle(): Promise<void> {
  if (cronGuard.running) {
    console.log('[minmax-recalc] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const summary = await runMinmaxRecalcCycle();
    if (summary.scanned > 0) {
      console.log(
        `[minmax-recalc] scanned=${summary.scanned} updated=${summary.updated} ` +
          `skipped=${summary.skipped} errors=${summary.errors}`,
      );
    }
  } catch (err) {
    console.error('[minmax-recalc] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}

type DynamicStockRow = {
  location_id: number;
  product_id: number;
  min_level: string | number;
  max_level: string | number;
  lead_time_days: string | number;
  review_days: string | number;
  safety_factor: string | number;
};

/**
 * Recalculate every (or filtered subset of) `stock` row whose
 * `minmax_mode='dynamic'`. Exported for the admin endpoint and tests.
 *
 * @param filter optional `{ locationId, productId }` narrowing.
 * @param actorUserId optional acting user id for the audit log (manual
 *        trigger via `POST /api/admin/recalc-minmax` passes it; the cron
 *        passes `null` for the system actor).
 */
export async function runMinmaxRecalcCycle(
  filter: MinmaxRecalcFilter = {},
  actorUserId: number | null = null,
): Promise<MinmaxRecalcSummary> {
  // Build the iteration query — one round trip lists every dynamic row +
  // the location-level formula inputs the per-row tx needs.
  const conditions: string[] = ["s.minmax_mode = 'dynamic'"];
  const params: (string | number)[] = [];
  if (filter.locationId !== undefined) {
    params.push(filter.locationId);
    conditions.push(`s.location_id = $${params.length}`);
  }
  if (filter.productId !== undefined) {
    params.push(filter.productId);
    conditions.push(`s.product_id = $${params.length}`);
  }
  const { rows: rowsAll } = await query<DynamicStockRow>(
    `SELECT s.location_id, s.product_id, s.min_level, s.max_level,
            l.lead_time_days, l.review_days, l.safety_factor
       FROM stock s
       JOIN locations l ON l.id = s.location_id
      WHERE ${conditions.join(' AND ')}`,
    params,
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rowsAll) {
    try {
      const result = await recalcOneRow(row, actorUserId);
      if (result === 'updated') updated += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `[minmax-recalc] row (loc=${row.location_id}, prod=${row.product_id}) failed:`,
        (err as Error).message,
      );
    }
  }
  return { scanned: rowsAll.length, updated, skipped, errors };
}

type RowOutcome = 'updated' | 'skipped';

/**
 * Per-row transaction. Reads the latest `sales_stats_daily` row, applies
 * the formula, updates `stock` (with the `minmax_mode='dynamic'` race
 * guard), and writes the audit row. Skip paths also stamp `last_recalc_at`
 * so the dashboard can show "recently considered" without ambiguity.
 */
async function recalcOneRow(
  row: DynamicStockRow,
  actorUserId: number | null,
): Promise<RowOutcome> {
  return withTransaction(async (tx) => {
    const leadTime = Number(row.lead_time_days);
    const review = Number(row.review_days);
    const safety = Number(row.safety_factor);
    const oldMin = Number(row.min_level);
    const oldMax = Number(row.max_level);

    // Latest aggregated sales row for this (location, product).
    const statsResult = await tx.query<{ avg_7d: string | null; avg_30d: string | null }>(
      `SELECT avg_7d, avg_30d FROM sales_stats_daily
        WHERE location_id = $1 AND product_id = $2
        ORDER BY stat_date DESC LIMIT 1`,
      [row.location_id, row.product_id],
    );
    const stats = statsResult.rows[0];
    const avg7 = stats?.avg_7d === null || stats?.avg_7d === undefined ? null : Number(stats.avg_7d);
    const avg30 = stats?.avg_30d === null || stats?.avg_30d === undefined ? null : Number(stats.avg_30d);

    // avg_7d ustun (ADR-0007 §3); fallback avg_30d. Both null → no history.
    let avgDaily: number | null;
    let source: 'avg_7d' | 'avg_30d' | null;
    if (avg7 !== null && avg7 >= EPSILON) {
      avgDaily = avg7;
      source = 'avg_7d';
    } else if (avg30 !== null && avg30 >= EPSILON) {
      avgDaily = avg30;
      source = 'avg_30d';
    } else {
      avgDaily = null;
      source = null;
    }

    if (avgDaily === null) {
      // No usable sales history — skip the row, log an info warning, stamp
      // the recalc timestamp so the dashboard can show "considered".
      await tx.query(
        `UPDATE stock SET last_recalc_at = now()
          WHERE location_id = $1 AND product_id = $2 AND minmax_mode = 'dynamic'`,
        [row.location_id, row.product_id],
      );
      await recordImportWarning(
        {
          source: 'minmax.recalc',
          entity: `stock:${row.location_id}:${row.product_id}`,
          severity: 'info',
          message: 'No sales history — dynamic min/max skipped',
          payload: {
            location_id: row.location_id,
            product_id: row.product_id,
            avg_7d: avg7,
            avg_30d: avg30,
          },
        },
        tx,
      );
      return 'skipped';
    }

    const minNew = round4(avgDaily * leadTime * safety);
    const maxNew = round4(minNew + avgDaily * review);

    if (maxNew < EPSILON) {
      // Zero-output guard — preserve existing min/max, log a warning so PM
      // can investigate (a product whose sales dropped to nearly zero
      // should not have its min/max wiped without a human in the loop).
      await tx.query(
        `UPDATE stock SET last_recalc_at = now()
          WHERE location_id = $1 AND product_id = $2 AND minmax_mode = 'dynamic'`,
        [row.location_id, row.product_id],
      );
      await recordImportWarning(
        {
          source: 'minmax.recalc',
          entity: `stock:${row.location_id}:${row.product_id}`,
          severity: 'warning',
          message: 'Dynamic recalc would zero out min/max — preserved old values',
          payload: {
            location_id: row.location_id,
            product_id: row.product_id,
            avg_daily: avgDaily,
            min_new: minNew,
            max_new: maxNew,
            old: { min_level: oldMin, max_level: oldMax },
          },
        },
        tx,
      );
      return 'skipped';
    }

    if (minNew === oldMin && maxNew === oldMax) {
      // No-op — formula produced the same numbers. Still stamp the timestamp.
      await tx.query(
        `UPDATE stock SET last_recalc_at = now()
          WHERE location_id = $1 AND product_id = $2 AND minmax_mode = 'dynamic'`,
        [row.location_id, row.product_id],
      );
      return 'skipped';
    }

    // The race guard `minmax_mode = 'dynamic'` makes the UPDATE a no-op if a
    // manager flipped the row to 'manual' between our snapshot read and the
    // write — without this we could overwrite an in-flight manual override.
    const updateResult = await tx.query(
      `UPDATE stock
          SET min_level = $3, max_level = $4, last_recalc_at = now()
        WHERE location_id = $1 AND product_id = $2 AND minmax_mode = 'dynamic'`,
      [row.location_id, row.product_id, minNew, maxNew],
    );
    if (updateResult.rowCount === 0) {
      // The row's mode flipped under us — no error, just skip.
      return 'skipped';
    }

    await writeAudit(tx, {
      actorUserId,
      action: 'stock.minmax.recalc',
      entity: 'stock.minmax',
      entityId: null,
      payload: {
        location_id: row.location_id,
        product_id: row.product_id,
        old: { min_level: oldMin, max_level: oldMax },
        new: { min_level: minNew, max_level: maxNew },
        formula: {
          avg_daily: avgDaily,
          source,
          lead_time_days: leadTime,
          review_days: review,
          safety_factor: safety,
        },
      },
    });
    return 'updated';
  });
}

/** Round to 4 decimals — keeps `stock.min_level/max_level NUMERIC(14,4)` clean. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Test seam: a helper to recalc a single (loc, prod) row in an existing
 * transaction. Not part of the public API today, exported only for the
 * test suite if a future test needs deterministic single-row runs.
 */
export async function _recalcOneRowForTest(
  row: DynamicStockRow,
  actorUserId: number | null,
  _tx: TxClient,
): Promise<RowOutcome> {
  // Today the per-row helper opens its own tx; if the tests ever need a
  // shared-tx variant, this seam is the place to wire it.
  return recalcOneRow(row, actorUserId);
}
