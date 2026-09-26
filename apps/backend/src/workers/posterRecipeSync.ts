/**
 * Poster recipe sync cron worker.
 *
 * Schedule: every hour. Keeps product recipes (BOM) in ERP consistent with
 * Poster. Products with recipe_locked = TRUE are skipped (replaceRecipe
 * handles the guard internally). The cycle takes the shared recipe advisory
 * lock (integrations/poster/recipeLock.ts) and skips itself while the bulk
 * recipe audit/apply/restore job holds it.
 *
 * The worker NEVER throws — Poster outages are logged and the next tick retries.
 */
import cron from 'node-cron';
import { loadConfig } from '../config/index.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import { syncIngredients, syncPrepacks, syncMenuProducts } from '../integrations/poster/seedSync.js';
import { syncModifications } from '../integrations/poster/modificationSync.js';
import { acquirePosterRecipeLock, type HeldPosterRecipeLock } from '../integrations/poster/recipeLock.js';

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
  let held: HeldPosterRecipeLock | null = null;
  try {
    // Shared with the bulk recipe audit/apply/restore job: never rewrite
    // recipes while that job is comparing, applying or restoring them.
    held = await acquirePosterRecipeLock();
    if (held === null) {
      console.log('[poster-recipe-sync] bulk recipe job holds the recipe lock, skipping this cycle');
      return;
    }
    const client = createPosterClientFromConfig();
    // Sequential on purpose: prepacks resolve components the ingredient pass
    // creates/renames, and menu products resolve prepacks the prepack pass
    // creates/renames. Run in parallel they raced and could bind stale rows
    // (the Poster client serialises calls anyway, so parallelism bought nothing).
    const ingr = await syncIngredients(client, 'poll');
    const prepacks = await syncPrepacks(client, 'poll');
    const menu = await syncMenuProducts(client, 'poll');
    const applied = (ingr.recordsApplied ?? 0) + (prepacks.recordsApplied ?? 0) + (menu.recordsApplied ?? 0);
    if (applied > 0) {
      console.log(`[poster-recipe-sync] updated=${applied}`);
    }
    // Sync modification weights (weight-based product variants like КУСОК/ЦЕЛЫЙ).
    // Runs sequentially after recipe sync to avoid Poster rate-limit contention.
    const mods = await syncModifications(client);
    if (mods.modificationsUpserted > 0) {
      console.log(
        `[poster-recipe-sync] modifications synced: products=${mods.productsScanned} mods=${mods.modificationsUpserted}`,
      );
    }
  } catch (err) {
    console.error('[poster-recipe-sync] cycle failed:', (err as Error).message);
  } finally {
    if (held !== null) await held.release();
    cronGuard.running = false;
  }
}
