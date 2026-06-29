/**
 * Sales aggregate cron worker — Phase-2 F2.1 (ADR-0007 §2, spec §5.1).
 *
 * Schedule: `0 3 * * *` (every day at 03:00 UTC = 08:00 Toshkent).
 *
 * The job rebuilds `sales_stats_daily` from the rolling 31-day window of
 * `sales` rows:
 *
 *   1. INSERT ... ON CONFLICT DO UPDATE — upsert one row per
 *      (location_id, product_id, stat_date) with `qty_sold = SUM(qty)`.
 *      Idempotent: a second run on the same data lands the same numbers.
 *
 *   2. UPDATE ... FROM (SUBQUERY) — for every row in the 31-day window,
 *      recompute `avg_7d` and `avg_30d` using a self-join with date-range
 *      FILTER aggregates. This is the input the recalc cron (04:00 UTC)
 *      reads to derive `avg_daily`.
 *
 * Both steps run inside ONE transaction so a partial outcome is impossible
 * — if step 2 fails, step 1 also rolls back and the next tick retries.
 *
 * Re-entrancy guard prevents the next tick from overlapping a slow run.
 *
 * Audit: one `audit_log` row per cycle (system actor) with the row counts
 * so the operator can see "last aggregate touched N rows" without scanning
 * the table itself.
 */
import cron from 'node-cron';
import { withTransaction } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';

/** node-cron expression — every day at 03:00 (UTC by default in node-cron). */
export const SALES_AGGREGATE_SCHEDULE = '0 3 * * *';

let task: cron.ScheduledTask | undefined;

/**
 * Re-entrancy guard. Exported for the test suite to reset between cases.
 * Sales aggregate is heavy enough that a slow Postgres + the 03:00 + 04:00
 * pair could land overlapping work; the flag keeps the engine sane on one
 * Node process. Multi-process would require `pg_try_advisory_lock`.
 */
export const cronGuard: { running: boolean } = { running: false };

export type SalesAggregateSummary = {
  /** Number of (location, product, date) rows upserted / refreshed. */
  readonly rowsAggregated: number;
};

/**
 * Start the cron loop. No-op if already started. Tests do not call this;
 * they invoke `runSalesAggregateCycle()` directly.
 */
export function startSalesAggregateWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(SALES_AGGREGATE_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopSalesAggregateWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — wraps `runSalesAggregateCycle()` with the overlap guard. */
export async function runOneCycle(): Promise<void> {
  if (cronGuard.running) {
    console.log('[sales-aggregate] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const summary = await runSalesAggregateCycle();
    if (summary.rowsAggregated > 0) {
      console.log(`[sales-aggregate] rows=${summary.rowsAggregated}`);
    }
  } catch (err) {
    console.error('[sales-aggregate] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}

/**
 * Execute one aggregate pass. Exported so tests + the manual recalc trigger
 * (`POST /api/admin/recalc-minmax`) can drive it synchronously.
 *
 * Atomicity: both statements share one transaction. A failure in either
 * rolls the whole pass back — the next cron tick (or manual retry) repeats
 * cleanly because the SQL is idempotent.
 */
export async function runSalesAggregateCycle(): Promise<SalesAggregateSummary> {
  return withTransaction(async (tx) => {
    // Step 1 — daily upsert over the last 31 days.
    // `count_estimated` from the UPSERT is the number of writes that hit
    // the table; `RETURNING 1` lets us count rows in one round trip.
    const upsert = await tx.query<{ k: number }>(
      `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
         SELECT s.store_id,
                s.product_id,
                date_trunc('day', s.sold_at)::date,
                sum(s.qty)
           FROM sales s
          WHERE s.sold_at >= current_date - interval '31 days'
          GROUP BY 1, 2, 3
       ON CONFLICT (location_id, product_id, stat_date) DO UPDATE
          SET qty_sold = EXCLUDED.qty_sold
       RETURNING 1 AS k`,
    );
    const rowsAggregated = upsert.rowCount;

    // Step 2 — refresh avg_7d / avg_30d for every row in the 31-day window.
    // The correlated self-join lets PostgreSQL build the window aggregate
    // in a single query; FILTER (WHERE ...) keeps both averages in one
    // pass (otherwise we would need two UPDATEs).
    await tx.query(
      `UPDATE sales_stats_daily ssd
          SET avg_7d  = sub.a7,
              avg_30d = sub.a30
         FROM (
           SELECT ssd2.location_id, ssd2.product_id, ssd2.stat_date,
                  avg(ssd3.qty_sold) FILTER (
                      WHERE ssd3.stat_date BETWEEN ssd2.stat_date - 6  AND ssd2.stat_date
                  ) AS a7,
                  avg(ssd3.qty_sold) FILTER (
                      WHERE ssd3.stat_date BETWEEN ssd2.stat_date - 29 AND ssd2.stat_date
                  ) AS a30
             FROM sales_stats_daily ssd2
             JOIN sales_stats_daily ssd3
               ON ssd3.location_id = ssd2.location_id
              AND ssd3.product_id  = ssd2.product_id
            WHERE ssd2.stat_date >= current_date - 31
            GROUP BY ssd2.location_id, ssd2.product_id, ssd2.stat_date
         ) sub
        WHERE ssd.location_id = sub.location_id
          AND ssd.product_id  = sub.product_id
          AND ssd.stat_date   = sub.stat_date`,
    );

    await writeAudit(tx, {
      actorUserId: null,
      action: 'sales_stats.aggregate',
      entity: 'sales_stats_daily',
      entityId: null,
      payload: { rows_aggregated: rowsAggregated },
    });
    return { rowsAggregated };
  });
}
