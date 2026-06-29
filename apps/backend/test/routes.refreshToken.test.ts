/**
 * Sprint-3 (ADR-0005) — refresh-token flow end-to-end.
 *
 *   POST /api/auth/refresh  rotate, atomic, single-use
 *   POST /api/auth/logout   idempotent revoke
 *   Authorization Bearer    refresh token rejected as access token
 *
 * Drives the HTTP boundary so middleware + handler branches are exercised
 * end-to-end and the new DB rows (`refresh_tokens`) are observed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';
import { hashRefreshToken } from '../src/auth/jwt.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Log in with a fresh user and return both tokens + the user id. */
async function loginFresh(): Promise<{
  userId: number;
  username: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}> {
  const username = `refresh-${Math.random().toString(36).slice(2, 8)}`;
  const password = 'a-strong-pass';
  const user = await makeUser(ctx.db, { role: 'pm', username, password });
  const res = await request(ctx.app).post('/api/auth/login').send({ login: username, password });
  expect(res.status).toBe(200);
  return {
    userId: user.id,
    username,
    password,
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token,
  };
}

describe('POST /api/auth/login — refresh-token persistence', () => {
  it('stores the SHA-256 hash of the refresh token (never the raw value)', async () => {
    const session = await loginFresh();
    const expectedHash = hashRefreshToken(session.refreshToken);

    const { rows } = await ctx.db.query<{
      n: string;
      raw_match: string;
    }>(
      `SELECT count(*) AS n,
              sum(CASE WHEN token_hash = $1 THEN 1 ELSE 0 END) AS raw_match
         FROM refresh_tokens
        WHERE user_id = $2`,
      [session.refreshToken, session.userId],
    );
    // No row stores the raw token (cast to ::text doesn't matter — equal would be 0).
    expect(Number(rows[0]?.raw_match)).toBe(0);

    // But exactly one row stores its hash.
    const byHash = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM refresh_tokens WHERE token_hash = $1`,
      [expectedHash],
    );
    expect(Number(byHash.rows[0]?.n)).toBe(1);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token (single-use) and returns a fresh access token', async () => {
    const session = await loginFresh();

    const res = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: session.refreshToken });

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');
    // The new refresh token must differ from the old one (rotation).
    expect(res.body.refresh_token).not.toBe(session.refreshToken);
    // User payload unchanged.
    expect(res.body.user).toMatchObject({ id: session.userId, username: session.username });

    // The old row is revoked AND its rotated_to points at the new row.
    const { rows } = await ctx.db.query<{
      revoked_at: Date | null;
      rotated_to: string | null;
    }>(
      `SELECT revoked_at, rotated_to FROM refresh_tokens WHERE token_hash = $1`,
      [hashRefreshToken(session.refreshToken)],
    );
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[0]?.rotated_to).not.toBeNull();
  });

  it('rejects a refresh token that has already been rotated (replay) with a generic 401', async () => {
    const session = await loginFresh();

    // First refresh succeeds.
    const ok = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: session.refreshToken });
    expect(ok.status).toBe(200);

    // Re-using the now-revoked token must fail — generic 401, no enumeration.
    const replay = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: session.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown refresh token with the same generic 401', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: 'a'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired refresh token (manual expiry in the past)', async () => {
    const session = await loginFresh();
    // Force-expire the row.
    await ctx.db.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = $1`,
      [hashRefreshToken(session.refreshToken)],
    );

    const res = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: session.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('returns 422 when refresh_token is missing from the body', async () => {
    const res = await request(ctx.app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token and is idempotent (204 on a re-call)', async () => {
    const session = await loginFresh();

    const first = await request(ctx.app)
      .post('/api/auth/logout')
      .send({ refresh_token: session.refreshToken });
    expect(first.status).toBe(204);

    // After logout, the refresh token is unusable.
    const refresh = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: session.refreshToken });
    expect(refresh.status).toBe(401);

    // Calling logout again with the same (already revoked) token is a no-op.
    const second = await request(ctx.app)
      .post('/api/auth/logout')
      .send({ refresh_token: session.refreshToken });
    expect(second.status).toBe(204);
  });

  it('returns 204 for an unknown refresh token (no enumeration, no error)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/logout')
      .send({ refresh_token: 'b'.repeat(64) });
    expect(res.status).toBe(204);
  });

  it('returns 204 even when called with no body', async () => {
    const res = await request(ctx.app).post('/api/auth/logout').send();
    expect(res.status).toBe(204);
  });
});

describe('Authorization: Bearer — refresh token must not authenticate', () => {
  it('rejects a refresh token presented as a bearer credential', async () => {
    const session = await loginFresh();
    // The refresh token is 64 hex chars — definitely not a JWT, so the
    // middleware's verifyToken fails immediately. Expectation: 401.
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.refreshToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });
});
