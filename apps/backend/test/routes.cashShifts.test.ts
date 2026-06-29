/**
 * EPIC 8.5 — GET /api/cash-shifts integration tests + mapper unit tests.
 *
 * Coverage:
 *   - mapCashShift: tiyin->so'm, closing_balance + kniжный/факт discrepancy.
 *   - route maps Poster finance.getCashshifts onto the CashShift contract,
 *     resolves spot_id -> ADIA store, returns { items: [...] }.
 *   - RBAC: store_manager sees only its own store; foreign store_id -> 403.
 *   - unauthenticated -> 401.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
import { mapCashShift } from '../src/services/cashShift.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

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

/** Create a store carrying a Poster spot_id and return both ids. */
async function makeStoreWithSpot(spotId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ($1, 'store', $2) RETURNING id`,
    [name, spotId],
  );
  return Number(rows[0]!.id);
}

/** Stub the Poster client so finance.getCashshifts returns `shifts`. */
function stubCashShifts(shifts: unknown[]): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'finance.getCashshifts') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: shifts }), { status: 200 }),
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

describe('mapCashShift (pure)', () => {
  it('converts tiyin->so\'m and derives closing balance + discrepancy', () => {
    // amounts in tiyin: start 100000(=1000), cash 500000(=5000),
    // card 200000(=2000), debit 50000(=500), collection 300000(=3000),
    // end 120000(=1200 factual).
    const dto = mapCashShift(
      {
        cash_shift_id: 7,
        spot_id: 1,
        amount_start: 100000,
        amount_end: 120000,
        amount_sell_cash: 500000,
        amount_sell_card: 200000,
        amount_debit: 50000,
        amount_collection: 300000,
        date_start: '2026-05-29 08:00:00',
        date_end: '2026-05-29 20:00:00',
        user_id: 42,
      },
      { id: 9, name: 'Do\'kon-1' },
    );
    expect(dto.id).toBe(7);
    expect(dto.store_id).toBe(9);
    expect(dto.status).toBe('closed');
    expect(dto.cash_amount).toBe(5000);
    expect(dto.card_amount).toBe(2000);
    expect(dto.total_sales).toBe(7000);
    expect(dto.expense_amount).toBe(500);
    expect(dto.collected_amount).toBe(3000);
    // closing = 1000 + 5000 - 500 - 3000 = 2500.
    expect(dto.closing_balance).toBe(2500);
    // discrepancy = 2500 - 1200 (factual end) = 1300.
    expect(dto.balance_discrepancy).toBe(1300);
  });

  it('open shift (no date_end) has status open and zero discrepancy', () => {
    const dto = mapCashShift(
      { cash_shift_id: 1, amount_sell_cash: 100000, date_start: '2026-05-29 08:00:00' },
      { id: 5, name: 'S' },
    );
    expect(dto.status).toBe('open');
    expect(dto.balance_discrepancy).toBe(0);
  });
});

describe('GET /api/cash-shifts', () => {
  it('PM sees mapped shifts for stores with a resolved spot', async () => {
    const store = await makeStoreWithSpot(501, 'Spot Store A');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubCashShifts([
      {
        cash_shift_id: 1001,
        spot_id: 501,
        amount_sell_cash: 400000,
        amount_sell_card: 100000,
        date_start: '2026-05-29 08:00:00',
        date_end: '2026-05-29 20:00:00',
      },
      // A shift for an unmapped spot — must be dropped.
      { cash_shift_id: 1002, spot_id: 99999, amount_sell_cash: 1 },
    ]);

    const res = await request(ctx.app)
      .get('/api/cash-shifts?range=today')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: { id: number }) => s.id);
    expect(ids).toContain(1001);
    expect(ids).not.toContain(1002);
    const shift = res.body.items.find((s: { id: number }) => s.id === 1001);
    expect(shift.store_id).toBe(store);
    expect(shift.total_sales).toBe(5000);
  });

  it('store_manager requesting a foreign store_id -> 403', async () => {
    const storeB = await makeStoreWithSpot(502, 'Spot Store B');
    const otherStore = await makeStoreWithSpot(503, 'Spot Store C');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: storeB });
    stubCashShifts([]);
    const res = await request(ctx.app)
      .get(`/api/cash-shifts?store_id=${otherStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/cash-shifts');
    expect(res.status).toBe(401);
  });
});
