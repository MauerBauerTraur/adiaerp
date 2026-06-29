/**
 * EPIC 5 / ADR-0016 §3.3 (OQ4) — production dialog expiry cron.
 *
 * Schedule: `* * * * *` (every minute). An open `production_dialog_sessions`
 * row has a 6-hour TTL (`expires_at`); this worker stamps every overdue open
 * dialog as EXPIRED and escalates to PM (a notification), but NEVER auto-
 * creates documents — an abandoned dialog stays side-effect-free and a human
 * re-triggers the order.
 *
 * `answerDialog` also does a lazy expire check before it accepts a stale
 * answer, so a user who taps a button after the TTL still gets SESSION_EXPIRED
 * even if the cron hasn't fired yet. This cron keeps the open-dialog list
 * accurate without a per-row stale flag (mirrors actionExpireCron).
 */
import cron from 'node-cron';
import { expireStaleDialogs } from '../services/productionDialog.js';

/** node-cron expression — every minute. */
export const DIALOG_EXPIRE_SCHEDULE = '* * * * *';

let task: cron.ScheduledTask | undefined;

/** Test hook — observable so suites can assert overlap behaviour. */
export const cronGuard: { running: boolean } = { running: false };

export function startProductionDialogExpireWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(DIALOG_EXPIRE_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopProductionDialogExpireWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — overlap guard + expire sweep. Exported for tests. */
export async function runOneCycle(): Promise<{ expired: number }> {
  if (cronGuard.running) {
    console.log('[dialog-expire] previous cycle still running, skipping');
    return { expired: 0 };
  }
  cronGuard.running = true;
  try {
    const expired = await expireStaleDialogs();
    if (expired > 0) {
      console.log(`[dialog-expire] expired=${expired} stale production dialogs`);
    }
    return { expired };
  } catch (err) {
    console.error('[dialog-expire] cycle failed:', (err as Error).message);
    return { expired: 0 };
  } finally {
    cronGuard.running = false;
  }
}
