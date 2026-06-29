/**
 * Poster recipe sync cron worker.
 *
 * Schedule: every hour. Keeps product recipes (BOM) in ERP consistent with
 * Poster. Products with recipe_locked = TRUE are skipped (replaceRecipe
 * handles the guard internally).
 *
 * The worker NEVER throws — Poster outages are logged and the next tick retries.
 */
import cron from 'node-cron';
import { loadConfig } from '../config/index.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import { syncIngredients, syncPrepacks, syncMenuProducts } from '../integrations/poster/seedSync.js';

export const POSTER_RECIPE_SYNC_SCHEDULE = '0 * * * *'; // every hour at :00

let task: cron.ScheduledTask | undefined;

const cronGuard = { running: false };

export function startPosterRecipeSyncWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(POSTER_RECIPE_SYNC_SCHEDULE, () => {
    void runRecipeSyncCycle();
  });
  return task;
}

export function stopPosterRecipeSyncWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

export async function runRecipeSyncCycle(): Promise<void> {
  if (cronGuard.running) {
    console.log('[poster-recipe-sync] previous cycle still running, skipping');
    return;
  }
  const cfg = loadConfig();
  if (cfg.poster.token === '') return; // Poster not configured
  cronGuard.running = true;
  try {
    const client = createPosterClientFromConfig();
    const [ingr, prepacks, menu] = await Promise.all([
      syncIngredients(client, 'poll'),
      syncPrepacks(client, 'poll'),
      syncMenuProducts(client, 'poll'),
    ]);
    const applied = (ingr.recordsApplied ?? 0) + (prepacks.recordsApplied ?? 0) + (menu.recordsApplied ?? 0);
    if (applied > 0) {
      console.log(`[poster-recipe-sync] updated=${applied}`);
    }
  } catch (err) {
    console.error('[poster-recipe-sync] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}
