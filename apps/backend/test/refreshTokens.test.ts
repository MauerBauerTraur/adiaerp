/**
 * Sprint-3 — refresh-token service unit tests.
 *
 * Covers:
 *   - SHA-256 hash determinism (the hash for one token is stable).
 *   - generate yields distinct, 64-hex-char strings (CSPRNG sanity).
 *   - validateAndRotate is atomic: only one of two concurrent rotations
 *     on the same raw token succeeds; the loser sees the row revoked.
 *   - revokeAllForUser revokes every active row in one shot.
 *   - cleanupExpired deletes rows past the 7-day cutoff and preserves
 *     fresh ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';
import {
  generateRefreshToken,
  hashRefreshToken,
} from '../src/auth/jwt.js';
import {
  cleanupExpired,
  issueRefreshToken,
  revokeAllForUser,
  validateAndRotate,
} from '../src/auth/refreshTokens.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('hashRefreshToken / generateRefreshToken', () => {
  it('hash is deterministic — same input -> same hex output', () => {
    const tok = 'a'.repeat(64);
    expect(hashRefreshToken(tok)).toBe(hashRefreshToken(tok));
  });
  it('hash is 64 hex chars (SHA-256)', () => {
    expect(hashRefreshToken('xyz')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('generate yields a fresh 64-hex-char token each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('validateAndRotate — concurrent rotation', () => {
  it('serialises two refreshes on the same raw token; one wins, one returns null', async () => {
    const user = await makeUser(ctx.db, { role: 'pm' });
    const issued = await issueRefreshToken(user.id);

    // Fire two rotations in parallel — one must win, the other must
    // see the revoked row when it acquires the FOR UPDATE lock.
    const [a, b] = await Promise.all([
      validateAndRotate(issued.rawToken),
      validateAndRotate(issued.rawToken),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    const losers = [a, b].filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Exactly one new (non-revoked) row exists for the user now.
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('returns null when the user has been deactivated mid-session', async () => {
    const user = await makeUser(ctx.db, { role: 'pm' });
    const issued = await issueRefreshToken(user.id);
    await ctx.db.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [user.id]);

    const result = await validateAndRotate(issued.rawToken);
    expect(result).toBeNull();
  });

  it('returns null for the empty string / non-string input', async () => {
    expect(await validateAndRotate('')).toBeNull();
    // Defensive — TS prevents this but the runtime guard exists.
    expect(await validateAndRotate(undefined as unknown as string)).toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('marks every active refresh token for the user as revoked', async () => {
    const user = await makeUser(ctx.db, { role: 'pm' });
    await issueRefreshToken(user.id);
    await issueRefreshToken(user.id);
    await issueRefreshToken(user.id);

    const revoked = await revokeAllForUser(user.id);
    expect(revoked).toBe(3);

    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('cleanupExpired', () => {
  it('deletes rows past expires_at + 7d, keeps fresh ones', async () => {
    const user = await makeUser(ctx.db, { role: 'pm' });
    const fresh = await issueRefreshToken(user.id);
    const stale = await issueRefreshToken(user.id);
    // Push `stale`'s expires_at 10 days into the past (> 7d cleanup cutoff).
    await ctx.db.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '10 days'
        WHERE id = $1`,
      [stale.id],
    );

    const deleted = await cleanupExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Fresh row survives, stale row is gone.
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM refresh_tokens WHERE user_id = $1`,
      [user.id],
    );
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });
});
