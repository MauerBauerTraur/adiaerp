/**
 * C2 + I1 (Sprint 3 audit) — `syncLog` invariants:
 *
 *  C2 — `notifyPosterSyncFailed` debounces to one notification per entity per
 *       60 minutes; a Poster outage at the 1-minute scan cadence would
 *       otherwise flood every active PM.
 *  I1 — `redactUrl()` strips `token=<value>` from error_detail strings
 *       before they are written to `poster_sync_log.error_detail` or to a
 *       notification body.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
} from '../src/integrations/poster/syncLog.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM poster_sync_log');
  await ctx.db.query('DELETE FROM users');
});

async function makePm(name = 'PM'): Promise<number> {
  // F4.12 — `users.username` is NOT NULL with a 3..32 charset CHECK. Use a
  // random suffix so re-runs inside the same suite never collide on it.
  const username = `pm_${Math.random().toString(36).slice(2, 10)}`;
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO users (name, username, password_hash, role)
     VALUES ($1, $2, 'x', 'pm') RETURNING id`,
    [name, username],
  );
  return Number(rows[0]!.id);
}

describe('redactUrl (I1)', () => {
  it('strips `token=<value>` from a Poster URL', () => {
    const before = 'POST https://joinposter.com/api/menu.getProducts?token=ABCD1234 failed';
    const after = redactUrl(before);
    expect(after).not.toContain('ABCD1234');
    expect(after).toContain('token=***');
  });

  it('does not touch strings without a token query parameter', () => {
    expect(redactUrl('plain error')).toBe('plain error');
  });

  it('handles null/undefined defensively', () => {
    expect(redactUrl(null)).toBe('');
    expect(redactUrl(undefined)).toBe('');
  });
});

describe('finishSyncRun stores a redacted error_detail (I1)', () => {
  it('redacts `token=` before writing to poster_sync_log.error_detail', async () => {
    const id = await startSyncRun('spots', 'manual');
    await finishSyncRun(
      id,
      'failed',
      { recordsIn: 0, recordsApplied: 0 },
      'fetch https://joinposter.com/api/x?token=SECRET failed',
    );
    const { rows } = await ctx.db.query<{ error_detail: string | null }>(
      `SELECT error_detail FROM poster_sync_log WHERE id = $1`,
      [id],
    );
    const detail = rows[0]?.error_detail ?? '';
    expect(detail).not.toContain('SECRET');
    expect(detail).toContain('token=***');
  });
});

describe('notifyPosterSyncFailed dedupe (C2)', () => {
  it('writes one notification per active PM, dropping duplicates within the 60-minute window', async () => {
    const pmA = await makePm('A');
    const pmB = await makePm('B');

    // Two consecutive failures of the same entity within seconds — only the
    // first should land in `notifications` per PM.
    await notifyPosterSyncFailed('leftovers', 'boom 1');
    await notifyPosterSyncFailed('leftovers', 'boom 2');

    const { rows } = await ctx.db.query<{ recipient_user_id: number; n: number }>(
      `SELECT recipient_user_id, count(*)::int AS n
         FROM notifications
        WHERE type = 'poster_sync_failed'
        GROUP BY recipient_user_id`,
    );
    const byUser = new Map(rows.map((r) => [Number(r.recipient_user_id), Number(r.n)]));
    expect(byUser.get(pmA)).toBe(1);
    expect(byUser.get(pmB)).toBe(1);

    // The dedupeKey is entity-scoped so a DIFFERENT entity still fires.
    await notifyPosterSyncFailed('transactions', 'oops');
    const { rows: byEntity } = await ctx.db.query<{ entity: string; n: number }>(
      `SELECT title AS entity, count(*)::int AS n
         FROM notifications WHERE type = 'poster_sync_failed'
         GROUP BY title`,
    );
    expect(byEntity.length).toBe(2);
  });

  it('redacts the token from the notification body', async () => {
    await makePm('A');
    await notifyPosterSyncFailed(
      'spots',
      'fetch https://joinposter.com/api/access.getSpots?token=SECRET failed',
    );
    const { rows } = await ctx.db.query<{ body: string }>(
      `SELECT body FROM notifications WHERE type='poster_sync_failed' LIMIT 1`,
    );
    expect(rows[0]?.body).not.toContain('SECRET');
    expect(rows[0]?.body).toContain('token=***');
  });
});
