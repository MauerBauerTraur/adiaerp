/**
 * GET /api/reports/store-sales — "Do'konlar sotuvi": each store's sales for a
 * period, read straight from Poster's own reports so the numbers match
 * Poster's "Товары" screen 1:1. Fixtures mirror real 28.09.2026 responses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';
import { PosterClient, setPosterClientForTests } from '../src/integrations/poster/client.js';
import { clearStoreSalesCache } from '../src/services/storeSalesReport.js';

let ctx: TestContext;
let pmToken: string;
let storeToken: string;
let calls: string[] = [];

const SPOTS = [
  { spot_id: '1', name: 'Кукча' },
  { spot_id: '2', name: 'Рабочий' },
];
const SPOT_SALES: Record<string, unknown> = {
  '1': { revenue: 1000000, profit: 700000, clients: 10, middle_invoice: 100000 },
  '2': { revenue: 4029870, profit: 3517105.53, clients: 26, middle_invoice: 154995 },
};
const PRODUCT_SALES: Record<string, unknown[]> = {
  '1': [
    { product_id: '9', product_name: 'Fanta', modification_id: '5', modificator_name: 'баночный', count: '2.0000000', unit: 'p', payed_sum: '1400000', product_profit: '1400000' },
  ],
  '2': [
    { product_id: '440', product_name: 'НАПОЛЕОН', modification_id: '1731', modificator_name: 'КУСОК', count: '19.0000000', unit: 'p', payed_sum: '45600000', product_profit: '45600000' },
    { product_id: '440', product_name: 'НАПОЛЕОН', modification_id: '1732', modificator_name: 'ПОЛОВИНА', count: '1.0000000', unit: 'p', payed_sum: '19200000', product_profit: '19200000' },
    { product_id: '2244', product_name: 'КОРОБКИ', modification_id: '2422', modificator_name: 'Рулет 6-шт', count: '6.0000000', unit: 'p', payed_sum: '1500000', product_profit: '1500000' },
    { product_id: '77', product_name: 'ЭКЛЕР КГ', modification_id: '0', modificator_name: '', count: '1.2500000', unit: 'kg', payed_sum: '13750000', product_profit: '10000000' },
  ],
};
const PRODUCTS: Record<string, unknown> = {
  '440': {
    product_id: '440', product_name: 'НАПОЛЕОН', type: '2',
    group_modifications: [{ group_id: '1', modifications: [
      { dish_modification_id: '426', name: 'ЦЕЛЫЙ', brutto: 1000 },
      { dish_modification_id: '1220', name: 'ПОЛОВИНА', brutto: 500 },
      { dish_modification_id: '1221', name: 'КУСОК', brutto: 62.5 },
    ] }],
  },
};

function stubPoster(opts: { fail?: boolean } = {}): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const method = u.pathname.split('/').pop() ?? '';
        calls.push(method);
        const ok = (response: unknown) =>
          Promise.resolve(new Response(JSON.stringify({ response }), { status: 200 }));
        if (opts.fail) {
          return Promise.resolve(new Response(JSON.stringify({ error: { code: 10, message: 'down' } }), { status: 200 }));
        }
        const spot = u.searchParams.get('spot_id') ?? '';
        if (method === 'access.getSpots') return ok(SPOTS);
        if (method === 'dash.getSpotsSales') return ok(SPOT_SALES[spot]);
        if (method === 'dash.getProductsSales') return ok(PRODUCT_SALES[spot] ?? []);
        if (method === 'menu.getProduct') return ok(PRODUCTS[u.searchParams.get('product_id') ?? ''] ?? {});
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }));
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

beforeAll(async () => {
  ctx = await createTestContext();
  pmToken = (await makeUser(ctx.db, { role: 'pm' })).token;
  const store = await makeLocation(ctx.db, { type: 'store' });
  storeToken = (await makeUser(ctx.db, { role: 'store_manager', locationId: store })).token;
});

afterEach(() => {
  setPosterClientForTests(undefined);
  clearStoreSalesCache();
  calls = [];
});

afterAll(async () => {
  await ctx.dispose();
});

function get(token: string, query: string): Promise<request.Response> {
  return request(ctx.app).get(`/api/reports/store-sales?${query}`).set('Authorization', `Bearer ${token}`);
}

type Item = { product_name: string; modifier: string | null; qty: number; unit: string; revenue: number; profit: number; whole_factor: number | null };
type Store = { spot_id: number; name: string; revenue: number; profit: number; checks: number; avg_check: number; items: Item[] };

describe('GET /api/reports/store-sales', () => {
  it("returns each store's totals and Poster's product rows in so'm", async () => {
    stubPoster();
    const res = await get(pmToken, 'from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(200);
    const stores = res.body.stores as Store[];
    expect(stores.map((s) => s.name)).toEqual(['Кукча', 'Рабочий']);

    const rab = stores.find((s) => s.name === 'Рабочий')!;
    expect(rab).toMatchObject({ spot_id: 2, revenue: 4029870, checks: 26, avg_check: 154995 });

    const kusok = rab.items.find((i) => i.modifier === 'КУСОК')!;
    expect(kusok).toMatchObject({ product_name: 'НАПОЛЕОН', qty: 19, unit: 'pcs', revenue: 456000, profit: 456000 });
    expect(kusok.whole_factor).toBeCloseTo(0.0625);
    expect(rab.items.find((i) => i.modifier === 'ПОЛОВИНА')!.whole_factor).toBeCloseTo(0.5);

    // A non-size modifier is its own item, never a fraction of a cake.
    expect(rab.items.find((i) => i.modifier === 'Рулет 6-шт')).toMatchObject({ qty: 6, revenue: 15000, whole_factor: null });
    // Weighed goods keep their kg and an empty modifier becomes null.
    expect(rab.items.find((i) => i.product_name === 'ЭКЛЕР КГ')).toMatchObject({ qty: 1.25, unit: 'kg', modifier: null, revenue: 137500 });
    // Rows come sorted by revenue, highest first.
    expect(rab.items[0]!.product_name).toBe('НАПОЛЕОН');
  });

  it('serves a repeated request from cache instead of calling Poster again', async () => {
    stubPoster();
    await get(pmToken, 'from=2026-09-28&to=2026-09-28');
    const first = calls.length;
    const res = await get(pmToken, 'from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(200);
    expect(calls.length).toBe(first);
  });

  it('is PM-only', async () => {
    stubPoster();
    const res = await get(storeToken, 'from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(403);
  });

  it('rejects a reversed range', async () => {
    stubPoster();
    const res = await get(pmToken, 'from=2026-09-29&to=2026-09-28');
    expect(res.status).toBe(422);
  });

  it('reports a Poster failure as 502', async () => {
    stubPoster({ fail: true });
    const res = await get(pmToken, 'from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(502);
  });
});
