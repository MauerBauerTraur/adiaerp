/**
 * Replenishment scan worker — TZ 8.2, spec section 2.4.
 *
 * Every 5 minutes node-cron triggers `runEngineCycle()`:
 *   1. scan all `stock` rows where `qty <= min_level` (a partial index covers it);
 *   2. for each row, create a `replenishment_request(qty_needed = max - qty)`
 *      unless an OPEN one already exists (invariant 2 — partial UNIQUE index
 *      is the DB-level guard; the service catches the unique-violation and
 *      treats it as expected);
 *   3. step every non-terminal open request forward by ONE state.
 *
 * The cron runs as the "system actor" (`actor_user_id = NULL`); transition
 * rows and audit rows are written with a NULL actor, matching the schema.
 */
import cron from 'node-cron';
import { runEngineCycle } from '../services/replenishment.js';

/** node-cron expression — every 5 minutes. */
export const REPLENISHMENT_SCAN_SCHEDULE = '*/5 * * * *';

let task: cron.ScheduledTask | undefined;

/**
 * Re-entrancy guard — a cycle that runs longer than the 5-minute interval
 * must not be overlapped by the next tick (it would create duplicate
 * replenishment requests, race on the same rows, and double the DB load).
 * Module scope is sufficient because the worker is a single Node process.
 * For a multi-process deployment we would upgrade this to a PostgreSQL
 * `pg_try_advisory_lock`; MVP runs as one PM2 process so the flag is enough.
 *
 * Exported for tests only.
 */
export const cronGuard: { running: boolean } = { running: false };

/**
 * Start the cron loop. Safe to call once at server boot; calling twice is a
 * no-op (the second call is ignored). Returns the scheduled task for tests.
 */
export function startReplenishmentScanWorker(): cron.ScheduledTask {
  if (task !== undefined) {
    return task;
  }
  task = cron.schedule(REPLENISHMENT_SCAN_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

/** Stop the cron loop (used by tests and graceful shutdown). */
export function stopReplenishmentScanWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/**
 * Run one cycle of the engine. Exported so a test (or a future
 * `POST /api/replenishment/scan` admin endpoint) can drive the engine
 * synchronously rather than wait for the cron.
 */
export async function runOneCycle(): Promise<void> {
  // Re-entrancy guard — if the previous cycle is still in flight, skip this
  // tick. The cron fires every 5 minutes; an in-progress cycle catches up on
  // its next own tick.
  if (cronGuard.running) {
    console.log('[replenishment-scan] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const summary = await runEngineCycle();
    if (summary.scanned > 0 || summary.created > 0 || summary.advanced > 0) {
      console.log(
        `[replenishment-scan] scanned=${summary.scanned} created=${summary.created} advanced=${summary.advanced}`,
      );
    }
  } catch (err) {
    console.error('[replenishment-scan] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}
