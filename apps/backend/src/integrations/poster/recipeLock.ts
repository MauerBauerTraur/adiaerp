/**
 * ONE PostgreSQL advisory lock shared by everything that rewrites recipes in
 * bulk from Poster:
 *
 *   - the hourly recipe sync (workers/posterRecipeSync.ts) — skips its cycle
 *     while the lock is held;
 *   - the manual POST /api/integrations/poster/sync (products / all) — 409;
 *   - the bulk recipe apply / restore job (services/posterRecipeAudit.ts) —
 *     409 while the sync holds it. (The read-only dry-run audit takes no lock.)
 *
 * Advisory locks belong to a database SESSION, so the lock is taken on a
 * dedicated pooled client that stays checked out while the lock is held;
 * `release()` unlocks and returns it. If that connection drops (PG restart,
 * pg_terminate_backend) the lock vanishes with it: the client's 'error' event
 * is caught here (an unhandled one would crash the API process), the handle
 * reports `lost`, and a job checks it between products and stops.
 */
import { getPool } from '../../db/pool.js';

/**
 * The advisory lock key (bigint; arbitrary but fixed and unique in this app).
 *
 * Ops: find the holder with
 *   SELECT pid, backend_start FROM pg_locks JOIN pg_stat_activity USING (pid)
 *    WHERE locktype = 'advisory' AND classid = 0 AND objid = 4144490001;
 * Terminating that backend releases the lock (the job then stops as 'failed').
 */
export const POSTER_RECIPE_LOCK_KEY = 4_144_490_001;

/** 409 text when a recipe-rewriting run finds the lock taken. */
export const RECIPE_LOCK_BUSY_MESSAGE =
  "Poster sinxronlash ishlayapti — birozdan keyin qayta urinib ko'ring.";

export type HeldPosterRecipeLock = {
  /** The lock's connection dropped — the lock is gone; stop writing. */
  readonly lost: boolean;
  release(): Promise<void>;
};

/**
 * Try to take the lock without waiting. Resolves to a handle while it is held,
 * or null when another session (the sync or a job) holds it.
 */
export async function acquirePosterRecipeLock(): Promise<HeldPosterRecipeLock | null> {
  const client = await getPool().connect();
  let lost = false;
  const onError = (err: Error): void => {
    lost = true;
    console.error('[poster:recipe-lock] lock connection lost:', err.message);
  };
  // Attach before the first query: a checked-out client has no pool listener.
  client.on('error', onError);

  let acquired = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS ok',
      [POSTER_RECIPE_LOCK_KEY],
    );
    acquired = rows[0]?.ok === true;
  } catch (err) {
    client.release(err as Error); // listener stays: the dead client may still emit
    throw err;
  }
  if (!acquired) {
    client.off('error', onError);
    client.release();
    return null;
  }

  let released = false;
  return {
    get lost() {
      return lost;
    },
    release: async () => {
      if (released) return;
      released = true;
      if (!lost) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [POSTER_RECIPE_LOCK_KEY]);
          client.off('error', onError);
          client.release();
          return;
        } catch (err) {
          lost = true;
          console.error('[poster:recipe-lock] unlock failed:', (err as Error).message);
        }
      }
      // A broken session: destroy it (that also drops any lock it still had).
      // Our listener stays attached, so a late 'error' from it is still caught.
      client.release(new Error('poster recipe lock connection lost'));
    },
  };
}
