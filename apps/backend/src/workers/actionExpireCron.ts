/**
 * AI assistant — pending action expiry cron (Faza-3 F3.2, ADR-0009 §1).
 *
 * Schedule: `* * * * *` (every minute). A pending `assistant_action` row
 * has a 5-minute TTL (`expires_at = created_at + 5 minutes`); this worker
 * sweeps `pending` rows whose `expires_at` is in the past and flips them
 * to `expired`.
 *
 * The sweep is one `UPDATE … WHERE status='pending' AND expires_at<now()`,
 * which is atomic and idempotent — overlapping runs are safe. The overlap
 * guard still applies so we don't waste DB connections when a slow cycle
 * runs longer than 60s.
 *
 * The confirm endpoint also does a lazy expire check inside its
 * transaction, so a user who clicks "Tasdiqlash" 5 minutes 1 second after
 * the action was staged still gets a 410 even if the cron hasn't fired
 * yet. The cron exists so the UI's `/actions?status=pending` list stays
 * accurate without a per-row stale flag.
 */
import cron from 'node-cron';
import { expirePendingActions } from '../services/assistantActions.js';

/** node-cron expression — every minute. */
export const ACTION_EXPIRE_SCHEDULE = '* * * * *';

let task: cron.ScheduledTask | undefined;

/** Test hook — observable so suites can assert overlap behaviour. */
export const cronGuard: { running: boolean } = { running: false };

export function startActionExpireWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(ACTION_EXPIRE_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopActionExpireWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — overlap guard + expire sweep. Exported for tests. */
export async function runOneCycle(): Promise<{ expired: number }> {
  if (cronGuard.running) {
    console.log('[action-expire] previous cycle still running, skipping');
    return { expired: 0 };
  }
  cronGuard.running = true;
  try {
    const { expired } = await expirePendingActions();
    if (expired > 0) {
      console.log(`[action-expire] expired=${expired} pending assistant actions`);
    }
    return { expired };
  } catch (err) {
    console.error('[action-expire] cycle failed:', (err as Error).message);
    return { expired: 0 };
  } finally {
    cronGuard.running = false;
  }
}
