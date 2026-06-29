/**
 * Refresh-token cleanup cron — Sprint-3 / ADR-0005.
 *
 * Schedule: `0 2 * * *` (every day at 02:00 UTC = 07:00 Toshkent).
 *
 * Deletes refresh-token rows whose `expires_at` is older than 7 days.
 * The 7-day lag keeps a short audit trail for debugging refresh issues
 * after the token itself stopped being usable; older rows are removed
 * so the table does not grow unbounded over months / years.
 *
 * Per-cycle work is small (`DELETE ... WHERE expires_at < now() - 7d`)
 * and runs in a single statement — no per-row transaction needed.
 */
import cron from 'node-cron';
import { cleanupExpired } from '../auth/refreshTokens.js';

/** node-cron expression — every day at 02:00. */
export const REFRESH_TOKEN_CLEANUP_SCHEDULE = '0 2 * * *';

let task: cron.ScheduledTask | undefined;

export const cronGuard: { running: boolean } = { running: false };

export function startRefreshTokenCleanupWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(REFRESH_TOKEN_CLEANUP_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopRefreshTokenCleanupWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — overlap guard + cleanup. Exported for tests. */
export async function runOneCycle(): Promise<{ deleted: number }> {
  if (cronGuard.running) {
    console.log('[refresh-token-cleanup] previous cycle still running, skipping');
    return { deleted: 0 };
  }
  cronGuard.running = true;
  try {
    const deleted = await cleanupExpired();
    if (deleted > 0) {
      console.log(`[refresh-token-cleanup] deleted=${deleted} expired refresh tokens`);
    }
    return { deleted };
  } catch (err) {
    console.error('[refresh-token-cleanup] cycle failed:', (err as Error).message);
    return { deleted: 0 };
  } finally {
    cronGuard.running = false;
  }
}
