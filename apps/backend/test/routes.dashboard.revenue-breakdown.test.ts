/**
 * Sub-task #7 — GET /api/dashboard/revenue-breakdown integration tests.
 *
 * DEMO PATH (working tree): the endpoint derives the breakdown from the LOCAL
 * `sales` table (Poster is slow / not aligned with seeded local data) and
 * splits the day's revenue across payment methods with a fixed bakery ratio
 * (~40 cash / 35 card / 15 payme / 10 click). It does NOT call Poster.
 *
 * Coverage:
 *   - PM gets a chain-wide aggregate for the requested date from local sales.
 *   - the bucket split is internally consistent (buckets sum to total).
 *   - a date with no local sales yields a zero breakdown.
 *   - 422 on a malformed date.
 *   - 403 when a store_manager asks for a spot outside their assigned
 *     stores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
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

/**
 * Install a stub Poster client whose `dash.getPaymentsReport` returns the
 * given rows and remembers the last URL it was called with (for assertion).
 */
function stubPosterPayments(
  rows: Array<{
    payment_id: number | string;
    payment_title: string;
    payment_sum: number | string;
    payment_count?: number | string;
  }>,
): { lastUrl: () => string | undefined } {
  let lastUrl: string | undefined;
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        lastUrl = u.toString();
        if (m === 'dash.getPaymentsReport') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: rows }), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  // The route checks config.poster.token != ''; set a non-empty value.
  process.env.POSTER_TOKEN = 'acc:test';
  return { lastUrl: () => lastUrl };
}

describe('GET /api/dashboard/revenue-breakdown', () => {
  it('reads the real Poster getPaymentsReport (tiyin) and reports so\'m (PM scope)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // EPIC 0.3 — the route now calls Poster directly. Stub the real
    // `{days, total}` aggregate shape in TIYIN; the route must ÷100 to so'm.
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'dash.getPaymentsReport') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  response: {
                    days: [],
                    total: {
                      payed_cash_sum: 870_577_000, // 8_705_770 so'm
                      payed_card_sum: 1_084_753_000, // 10_847_530 so'm
                      payed_sum_sum: 1_955_330_000, // 19_553_300 so'm
                      transactions_count: 84,
                    },
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
              status: 200,
            }),
          );
        }) as unknown as typeof fetch,
      }),
    );
    process.env.POSTER_TOKEN = 'acc:test';

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=2026-05-29')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: '2026-05-29',
      spot_id: null,
      total: 19_553_300,
      by_method: {
        cash: 8_705_770,
        card: 10_847_530,
        payme: 0,
        click: 0,
        other: 0,
      },
    });
    // Internal consistency: the buckets sum back to the reported total.
    const sumOfBuckets =
      res.body.by_method.cash +
      res.body.by_method.card +
      res.body.by_method.payme +
      res.body.by_method.click +
      res.body.by_method.other;
    expect(sumOfBuckets).toBe(res.body.total);
  });

  it('returns a zero breakdown when Poster reports no sales for the day', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    // Poster returns an empty aggregate (total all-zero).
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'dash.getPaymentsReport') {
            return Promise.resolve(
              new Response(
                JSON.stringify({ response: { days: [], total: { payed_sum_sum: 0 } } }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
              status: 200,
            }),
          );
        }) as unknown as typeof fetch,
      }),
    );
    process.env.POSTER_TOKEN = 'acc:test';
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=2019-01-15')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: '2019-01-15',
      spot_id: null,
      total: 0,
      by_method: { cash: 0, card: 0, payme: 0, click: 0, other: 0 },
    });
  });

  it('rejects a malformed date with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=not-a-date')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(422);
  });

  // ---------------------------------------------------------------------------
  // QA Prove-It (2026-05-28) — production was returning HTTP 500 on this
  // endpoint because the route iterates the Poster response as if it were
  // an array of `{payment_id, payment_title, payment_sum}` rows, but the
  // real `dash.getPaymentsReport` returns a single aggregate object:
  //   { days: [{date, payed_cash_sum, payed_card_sum, …}],
  //     total: {payed_cash_sum, payed_card_sum, payed_ewallet_sum, …,
  //             payed_sum_sum, transactions_count} }
  // The existing tests stub a synthetic row-array shape Poster never emits,
  // so they passed while production failed. This test pins the real shape
  // and will stay red until the route is fixed to read `total.payed_*_sum`.
  // ---------------------------------------------------------------------------
  it('parses the real Poster aggregate shape (days + total)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // Override the stub: respond with the SHAPE Poster actually returns.
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'dash.getPaymentsReport') {
            // Real Poster payload (verified against production account
            // `adia` on 2026-05-28). Money is in tiyin (1 so'm = 100).
            const realPayload = {
              response: {
                days: [
                  {
                    date: '2026-05-28',
                    payed_cash_sum: '1174545000',
                    payed_card_sum: '966402500',
                    payed_cert_in_sum: '0',
                    payed_cert_out_sum: '0',
                    payed_bonus_sum: '0',
                    payed_sum_sum: '2140947500',
                    round_sum: '0',
                  },
                ],
                total: {
                  payed_cash_sum: 1_174_545_000,
                  payed_card_sum: 966_402_500,
                  payed_third_party_sum: 0,
                  payed_cert_in_sum: 0,
                  payed_cert_out_sum: 0,
                  payed_ewallet_sum: 0,
                  payed_bonus_sum: 0,
                  payed_sum_sum: 2_140_947_500,
                  transactions_count: 80,
                },
              },
            };
            return Promise.resolve(
              new Response(JSON.stringify(realPayload), { status: 200 }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
              status: 200,
            }),
          );
        }) as unknown as typeof fetch,
      }),
    );
    process.env.POSTER_TOKEN = 'acc:test';

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=2026-05-28')
      .set('Authorization', `Bearer ${pm.token}`);

    // Must NOT crash with 500 — the route has to handle Poster's real shape.
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    expect(res.body).toMatchObject({
      date: '2026-05-28',
      spot_id: null,
    });
    // Total must equal `payed_sum_sum`. The route may divide by 100 to turn
    // tiyin into so'm — accept either convention as long as everything stays
    // internally consistent (sum of by_method buckets == total).
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThan(0);
    const sumOfBuckets =
      res.body.by_method.cash +
      res.body.by_method.card +
      res.body.by_method.payme +
      res.body.by_method.click +
      res.body.by_method.other;
    expect(sumOfBuckets).toBeCloseTo(res.body.total, 0);
    // The two largest Poster buckets must show up under cash + card.
    expect(res.body.by_method.cash).toBeGreaterThan(0);
    expect(res.body.by_method.card).toBeGreaterThan(0);
  });

  it('rejects a store_manager asking for a spot outside their stores', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPosterPayments([]);

    // Two stores; the manager only owns store A. Spot id 999 maps to neither.
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'B' });
    // Map a poster_spot_id onto storeB so the principal's spot check has a
    // real row to find (and reject).
    await ctx.db.query(`UPDATE locations SET poster_spot_id = $1 WHERE id = $2`, [
      99,
      storeB,
    ]);
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: storeA,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?spotId=99')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(403);
  });
});
