/**
 * The shared Poster recipe advisory lock (integrations/poster/recipeLock.ts).
 *
 * R2 (review round 4): the lock lives on a checked-out pooled client. If that
 * connection drops (PG restart, pg_terminate_backend) the client emits
 * 'error'; without a listener that is an unhandled 'error' that crashes the
 * API process, and the lock silently vanishes. The handle must survive the
 * event, report `lost`, and still release cleanly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  POSTER_RECIPE_LOCK_KEY,
  acquirePosterRecipeLock,
} from '../src/integrations/poster/recipeLock.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Kill the session that holds the recipe advisory lock (what a PG restart does). */
async function terminateLockHolder(db: TestContext['db']): Promise<number> {
  const { rows } = await db.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND objid::bigint = $1::bigint AND classid::bigint = 0`,
    [POSTER_RECIPE_LOCK_KEY],
  );
  for (const r of rows) await db.query('SELECT pg_terminate_backend($1)', [r.pid]);
  return rows.length;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await delay(20);
}

describe('acquirePosterRecipeLock', () => {
  it('is exclusive and released by release()', async () => {
    const a = await acquirePosterRecipeLock();
    expect(a).not.toBeNull();
    expect(await acquirePosterRecipeLock()).toBeNull();
    await a!.release();
    const b = await acquirePosterRecipeLock();
    expect(b).not.toBeNull();
    await b!.release();
  });

  it('R2: a dropped lock connection is caught (no crash), reported as lost, and still releases', async () => {
    const held = await acquirePosterRecipeLock();
    expect(held).not.toBeNull();
    expect(held!.lost).toBe(false);
    const errors: unknown[] = [];
    const onUncaught = (err: unknown): void => { errors.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      expect(await terminateLockHolder(ctx.db)).toBe(1);
      await until(() => held!.lost);
      expect(held!.lost).toBe(true);
      await held!.release(); // must not throw on a dead connection
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    // The lock is gone with the session: it can be taken again.
    const again = await acquirePosterRecipeLock();
    expect(again).not.toBeNull();
    await again!.release();
  });
});
