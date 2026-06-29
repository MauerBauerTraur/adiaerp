/**
 * EPIC 3.2 — Telegram self-link.
 *
 * Covers:
 *   - service `issueLinkToken` / `redeemLinkToken` / `getLinkStatus`;
 *   - route `POST/GET /api/users/:id/telegram-link-token` RBAC + happy path;
 *   - `DELETE /api/users/:id/telegram` unlink;
 *   - the bot `/start <token>` command via `handleStartCommand`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';
import {
  getLinkStatus,
  issueLinkToken,
  redeemLinkToken,
} from '../src/services/userTelegramLink.js';
import { handleStartCommand } from '../src/integrations/telegram/startCommand.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('userTelegramLink service', () => {
  it('issues a single-use token and redeems it, binding telegram_id', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const issued = await issueLinkToken(user.id, user.id);
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const outcome = await redeemLinkToken(issued.token, 555000111);
    expect(outcome.kind).toBe('linked');

    const { rows } = await ctx.db.query<{ telegram_id: string | null }>(
      `SELECT telegram_id::text AS telegram_id FROM users WHERE id = $1`,
      [user.id],
    );
    expect(rows[0]?.telegram_id).toBe('555000111');
  });

  it('rejects an already-used token on the second redemption', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const issued = await issueLinkToken(user.id, null);

    expect((await redeemLinkToken(issued.token, 600000222)).kind).toBe('linked');
    expect((await redeemLinkToken(issued.token, 600000222)).kind).toBe('already_used');
  });

  it('rejects an unknown token', async () => {
    expect((await redeemLinkToken('deadbeef'.repeat(8), 700000333)).kind).toBe('invalid');
  });

  it('refuses to bind a telegram id already owned by another user', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const a = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const b = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    // Bind A first.
    await redeemLinkToken((await issueLinkToken(a.id, null)).token, 800000444);
    // B tries to claim the SAME telegram id — must be refused.
    const outcome = await redeemLinkToken((await issueLinkToken(b.id, null)).token, 800000444);
    expect(outcome.kind).toBe('telegram_taken');
  });

  it('invalidates an earlier token when a new one is issued', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const first = await issueLinkToken(user.id, null);
    const second = await issueLinkToken(user.id, null);
    expect((await redeemLinkToken(first.token, 900000555)).kind).toBe('already_used');
    expect((await redeemLinkToken(second.token, 900000555)).kind).toBe('linked');
  });

  it('reports link status', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    let status = await getLinkStatus(user.id);
    expect(status.telegramLinked).toBe(false);
    expect(status.hasPendingToken).toBe(false);

    await issueLinkToken(user.id, null);
    status = await getLinkStatus(user.id);
    expect(status.hasPendingToken).toBe(true);

    await redeemLinkToken((await issueLinkToken(user.id, null)).token, 111222333);
    status = await getLinkStatus(user.id);
    expect(status.telegramLinked).toBe(true);
    expect(status.telegramId).toBe('111222333');
  });
});

describe('POST /api/users/:id/telegram-link-token — RBAC', () => {
  it('lets pm mint a token for any user', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const target = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .post(`/api/users/${target.id}/telegram-link-token`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.start_command).toContain('/start ');
  });

  it('lets a user mint their own token', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const self = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const res = await request(ctx.app)
      .post(`/api/users/${self.id}/telegram-link-token`)
      .set('Authorization', `Bearer ${self.token}`);
    expect(res.status).toBe(201);
  });

  it('forbids minting a token for someone else (non-pm)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const a = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const b = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const res = await request(ctx.app)
      .post(`/api/users/${b.id}/telegram-link-token`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/users/:id/telegram-link-token + DELETE /api/users/:id/telegram', () => {
  it('reports status then unlinks', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    await redeemLinkToken((await issueLinkToken(user.id, null)).token, 444555666);

    const statusRes = await request(ctx.app)
      .get(`/api/users/${user.id}/telegram-link-token`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.telegram_linked).toBe(true);
    expect(statusRes.body.telegram_id).toBe('444555666');

    const delRes = await request(ctx.app)
      .delete(`/api/users/${user.id}/telegram`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(delRes.status).toBe(204);

    const after = await getLinkStatus(user.id);
    expect(after.telegramLinked).toBe(false);
  });
});

describe('bot /start <token> command', () => {
  it('binds telegram_id and replies on success', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const issued = await issueLinkToken(user.id, null);

    const replies: string[] = [];
    await handleStartCommand({
      fromTelegramId: 1234509876,
      token: issued.token,
      reply: async (t) => {
        replies.push(t);
      },
    });
    expect(replies[0]).toContain('ulandi');

    const status = await getLinkStatus(user.id);
    expect(status.telegramId).toBe('1234509876');
  });

  it('greets when no token payload is present', async () => {
    const replies: string[] = [];
    await handleStartCommand({
      fromTelegramId: 999,
      token: '',
      reply: async (t) => {
        replies.push(t);
      },
    });
    expect(replies[0]).toContain('ADIA ERP');
  });

  it('replies with an error on an invalid token', async () => {
    const replies: string[] = [];
    await handleStartCommand({
      fromTelegramId: 888,
      token: 'nope'.repeat(16),
      reply: async (t) => {
        replies.push(t);
      },
    });
    expect(replies[0]).toContain("noto'g'ri");
  });
});
