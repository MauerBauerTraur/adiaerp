/**
 * Poster sync log helper — every sync run starts with an insert, ends with a
 * status/counters update. Failures are notified to PM via the `notifications`
 * table (`type='poster_sync_failed'`) — debounced for 1 hour per entity so a
 * Poster outage cannot flood every active PM at the 1-minute scan cadence.
 *
 * Why one helper: every entity (spots/storages/ingredients/products/leftovers/
 * transactions) records the same shape, and the workers must never forget the
 * `finished_at` + status update on the error path.
 *
 * Security note (I1): `error_detail` strings are passed through `redactUrl()`
 * before being stored or notified — Poster errors can carry the API URL with
 * the access `token=` query parameter, and that token must never leak into
 * audit/notification rows.
 */
import { query, withTransaction } from '../../db/index.js';
import { createNotification, getPmRecipients } from '../../services/notify.js';

export type SyncEntity =
  | 'spots'
  | 'storages'
  | 'ingredients'
  | 'products'
  | 'leftovers'
  | 'transactions';

export type SyncTrigger = 'poll' | 'webhook' | 'manual';

export type SyncSummary = {
  readonly recordsIn: number;
  readonly recordsApplied: number;
};

/** Insert a `started` row and return its id. */
export async function startSyncRun(
  entity: SyncEntity,
  trigger: SyncTrigger,
): Promise<number> {
  // poster_sync_status enum has no 'started' value; we initialise as 'partial'
  // and overwrite on completion. 'partial' means "in progress / unknown outcome"
  // until the finishing update lands. This keeps the enum constrained without
  // adding an extra value just for the in-flight window.
  const { rows } = await query<{ id: number }>(
    `INSERT INTO poster_sync_log (entity, status, trigger, started_at)
     VALUES ($1, 'partial', $2, now())
     RETURNING id`,
    [entity, trigger],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('poster_sync_log insert returned no id');
  return id;
}

/**
 * Strip access tokens from a string before it is written to `error_detail`
 * or to a notification body. Poster surfaces the API URL in some error paths
 * (network failures, fetch rejections) and the URL carries `token=<...>` —
 * leaking that into audit rows would expose the integration secret.
 *
 * Matches `token=<non-space-non-&>` case-insensitively. Returns the input
 * unchanged when no token query parameter is present.
 */
export function redactUrl(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/token=[^&\s]+/gi, 'token=***');
}

/** Mark a sync run finished with ok/partial/failed. */
export async function finishSyncRun(
  id: number,
  status: 'ok' | 'partial' | 'failed',
  summary: SyncSummary,
  errorDetail: string | null = null,
): Promise<void> {
  const safeDetail = errorDetail === null ? null : redactUrl(errorDetail);
  await query(
    `UPDATE poster_sync_log
        SET status = $1,
            records_in = $2,
            records_applied = $3,
            error_detail = $4,
            finished_at = now()
      WHERE id = $5`,
    [status, summary.recordsIn, summary.recordsApplied, safeDetail, id],
  );
}

/**
 * Drop a `poster_sync_failed` notification for every active PM user.
 *
 * Debounce (C2 — Sprint 3 audit): one notification per entity per 60 minutes.
 * A Poster outage at the 1-minute scan cadence would otherwise flood every
 * PM's Telegram. The dedupe key is keyed on entity only — the actual error
 * detail moves into `payload` for forensic inspection.
 *
 * Best-effort — failures are swallowed (a sync-failure path must never throw
 * a SECOND error and hide the first).
 */
export async function notifyPosterSyncFailed(
  entity: SyncEntity,
  errorDetail: string,
): Promise<void> {
  const safeDetail = redactUrl(errorDetail);
  try {
    await withTransaction(async (tx) => {
      const recipients = await getPmRecipients(tx);
      for (const userId of recipients) {
        await createNotification(tx, {
          recipientUserId: userId,
          type: 'poster_sync_failed',
          title: `Poster sync failed: ${entity}`,
          body: safeDetail.slice(0, 500),
          payload: { entity, error: safeDetail },
          // `createNotification` dedupes by `dedupe_key` alone (it does NOT
          // include the recipient), so the per-PM scope must be encoded
          // into the key itself — otherwise the FIRST PM's row would
          // suppress every other PM's nudge.
          dedupeKey: `poster_sync_failed:${entity}:user:${userId}`,
          dedupeWindowMinutes: 60,
        });
      }
    });
  } catch (err) {
    console.error('[poster] notifyPosterSyncFailed swallow:', redactUrl((err as Error).message));
  }
}
