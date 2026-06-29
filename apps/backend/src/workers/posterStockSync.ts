/**
 * Poster stock-leftover sync cron worker (ADR-0002 §2 + §7).
 *
 * Schedule: every 15 minutes. node-cron drives `runStockSyncCycle()`. An
 * in-flight cycle blocks the next tick (`cronGuard.running`) to avoid double
 * `adjust` movements when a sync is slow under temporary Poster latency.
 *
 * The worker NEVER throws — Poster outages are logged and the next tick
 * retries (the sync log preserves the failure reason for the PM dashboard).
 */
import cron from 'node-cron';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import { syncStockLeftovers } from '../integrations/poster/stockSync.js';
import { recalculateBomCosts } from '../services/costCalc.js';

export const POSTER_STOCK_SYNC_SCHEDULE = '*/15 * * * *';

let task: cron.ScheduledTask | undefined;

export const cronGuard: { running: boolean } = { running: false };

export function startPosterStockSyncWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(POSTER_STOCK_SYNC_SCHEDULE, () => {
    void runStockSyncCycle();
  });
  return task;
}

export function stopPosterStockSyncWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

export async function runStockSyncCycle(): Promise<void> {
  if (cronGuard.running) {
    console.log('[poster-stock-sync] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const client = createPosterClientFromConfig();
    const summary = await syncStockLeftovers(client, 'poll');
    if (
      summary.storagesScanned > 0 ||
      summary.adjustments > 0 ||
      summary.negativesClamped > 0
    ) {
      console.log(
        `[poster-stock-sync] storages=${summary.storagesScanned} ` +
          `adjustments=${summary.adjustments} clamped=${summary.negativesClamped} ` +
          `skipped=${summary.skippedNoProduct}`,
      );
    }
    // Propagate refreshed raw-material costs through the BOM tree.
    if (summary.adjustments > 0 || summary.storagesScanned > 0) {
      const costResult = await recalculateBomCosts();
      if (costResult.updated > 0) {
        console.log(
          `[poster-stock-sync] cost recalc: updated=${costResult.updated} ` +
            `skipped=${costResult.skippedNoCost} cycles=${costResult.cycles}`,
        );
      }
    }
  } catch (err) {
    console.error('[poster-stock-sync] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}
