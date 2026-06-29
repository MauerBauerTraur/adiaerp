/**
 * EPIC 8.7 — GET /api/safe-expenses integration tests + mapper unit tests.
 *
 * Coverage:
 *   - mapSafeExpense + isExpense: tiyin->so'm, type filter (expense only).
 *   - route maps Poster finance.getTransactions -> SafeExpense contract,
 *     drops income rows, returns { items: [...] }.
 *   - RBAC: PM allowed; store_manager forbidden (403); unauth -> 401.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
import { mapSafeExpense, isExpense } from '../src/services/safeExpense.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  setPosterClientForTests(undefined);
  resetPosterClientCache();
});

beforeEach(() => {
  setPosterClientForTests(undefined);
});

function stubFinanceTransactions(txns: unknown[]): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'finance.getTransactions') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: txns }), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

describe('mapSafeExpense / isExpense (pure)', () => {
  it('maps an expense row to so\'m and keeps a positive amount', () => {
    const dto = mapSafeExpense({
      transaction_id: 55,
      type: 0,
      amount: 500000, // tiyin -> 5000 so'm
      category_name: 'Ijara',
      date: '2026-05-29 12:00:00',
      comment: 'May ijara',
      user_id: 7,
    });
    expect(dto.id).toBe(55);
    expect(dto.amount).toBe(5000);
    expect(dto.category).toBe('Ijara');
    expect(dto.note).toBe('May ijara');
  });

  it('isExpense distinguishes expense (0) from income (1)', () => {
    expect(isExpense({ transaction_id: 1, type: 0 })).toBe(true);
    expect(isExpense({ transaction_id: 2, type: 1 })).toBe(false);
    expect(isExpense({ transaction_id: 3 })).toBe(false);
  });
});

describe('GET /api/safe-expenses', () => {
  it('PM gets expense rows only (income dropped)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubFinanceTransactions([
      { transaction_id: 11, type: 0, amount: 200000, category_name: 'Transport', date: '2026-05-29 09:00:00' },
      { transaction_id: 12, type: 1, amount: 999999, category_name: 'Daromad', date: '2026-05-29 10:00:00' },
    ]);
    const res = await request(ctx.app)
      .get('/api/safe-expenses?range=today')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((e: { id: number }) => e.id);
    expect(ids).toContain(11);
    expect(ids).not.toContain(12);
    const e = res.body.items.find((x: { id: number }) => x.id === 11);
    expect(e.amount).toBe(2000);
  });

  it('store_manager forbidden -> 403', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    stubFinanceTransactions([]);
    const res = await request(ctx.app)
      .get('/api/safe-expenses?range=today')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/safe-expenses');
    expect(res.status).toBe(401);
  });
});
