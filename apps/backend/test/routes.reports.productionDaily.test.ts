/**
 * GET /api/reports/production-daily — the production half of the daily
 * report: orders given that Tashkent day, what was produced, cost / sales /
 * profit, otdels with the raw materials issued to them, warehouses and
 * supplier deliveries from Poster.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { PosterClient, setPosterClientForTests } from '../src/integrations/poster/client.js';

let ctx: TestContext;
let pmToken: string;
let oform: number;

function stubPoster(opts: { fail?: boolean } = {}): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const method = u.pathname.split('/').pop();
        if (!opts.fail && method === 'storage.getSupplies') {
          return Promise.resolve(new Response(JSON.stringify({ response: [
            { supply_id: '1', storage_id: '2', supplier_name: 'Абдукаххор сут', storage_name: 'Основной склад', date: '2026-09-28 11:10:30', supply_sum: '48000000', delete: '0' },
            { supply_id: '2', storage_id: '2', supplier_name: 'Deleted', storage_name: 'Основной склад', date: '2026-09-28 12:00:00', supply_sum: '100', delete: '1' },
          ] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 10, message: 'down' } }), { status: 200 }));
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

async function order(productId: number, qty: number, status: string, createdAt: string, parent: number | null = null): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO production_orders (product_id, qty, location_id, status, created_at, parent_production_order_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [productId, qty, oform, status, createdAt, parent],
  );
  return Number(rows[0]!.id);
}

beforeAll(async () => {
  ctx = await createTestContext();
  pmToken = (await makeUser(ctx.db, { role: 'pm' })).token;
  const raw = await makeLocation(ctx.db, { name: 'Основной склад', type: 'raw_warehouse' });
  oform = await makeLocation(ctx.db, { name: 'Оформления отдел', type: 'production' });
  const central = await makeLocation(ctx.db, { name: 'Склад Центральный', type: 'central_warehouse' });

  const flour = await makeProduct(ctx.db, { name: 'ун', type: 'raw', unit: 'kg' });
  const choco = await makeProduct(ctx.db, { name: 'шоколад', type: 'raw', unit: 'kg' });
  const egg = await makeProduct(ctx.db, { name: 'тухум', type: 'raw', unit: 'pcs' });
  const snickers = await makeProduct(ctx.db, { name: 'Г/П СНИКЕРС', type: 'finished', unit: 'pcs' });
  const medovik = await makeProduct(ctx.db, { name: 'Г/П МЕДОВИК', type: 'finished', unit: 'pcs' });
  const kapriz = await makeProduct(ctx.db, { name: 'Г/П КАПРИЗ', type: 'finished', unit: 'pcs' });
  await ctx.db.query('UPDATE products SET cost_price = 8000 WHERE id = $1', [flour]);
  await ctx.db.query('UPDATE products SET cost_price = 76000 WHERE id = $1', [choco]);
  await ctx.db.query('UPDATE products SET cost_price = 1500 WHERE id = $1', [egg]);
  await ctx.db.query('UPDATE products SET sell_price = 185000, cost_price = 4000 WHERE id = $1', [snickers]);
  await ctx.db.query('UPDATE products SET sell_price = 70000 WHERE id = $1', [medovik]);
  await ctx.db.query('UPDATE products SET sell_price = 180000 WHERE id = $1', [kapriz]);
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 0.5), ($3, $4, 1), ($5, $2, 1)`,
    [snickers, flour, medovik, choco, kapriz],
  );

  // 28.09 in Tashkent (the first one is 00:43 local = 27.09 19:43 UTC).
  const s1 = await order(snickers, 4, 'done', '2026-09-27T19:43:00Z');
  await order(medovik, 12, 'done', '2026-09-28T05:00:00Z');
  await order(kapriz, 10, 'new', '2026-09-28T06:00:00Z');
  await order(snickers, 99, 'cancelled', '2026-09-28T06:00:00Z'); // excluded
  await order(flour, 5, 'done', '2026-09-28T06:00:00Z', s1); // a sub-order — excluded
  await order(snickers, 7, 'done', '2026-09-27T10:00:00Z'); // the 27th — excluded

  // Raw issued to the otdel on the 28th: 2 kg flour = 16 000.
  await ctx.db.query(
    `INSERT INTO production_dispatches
       (production_order_id, product_id, product_name, product_unit, qty_needed,
        from_location_id, to_location_id, status, dispatched_at)
     VALUES ($1, $2, 'ун', 'kg', 2, $3, $4, 'received', '2026-09-28T06:00:00Z')`,
    [s1, flour, raw, oform],
  );

  // Warehouses: 5 cakes at central (cost 4000 → 20 000); eggs below their minimum.
  await ctx.db.query('INSERT INTO stock (location_id, product_id, qty) VALUES ($1, $2, 5)', [central, snickers]);
  await ctx.db.query(
    'INSERT INTO stock (location_id, product_id, qty, min_level, max_level) VALUES ($1, $2, 120, 500, 1000)',
    [raw, egg],
  );
});

afterEach(() => {
  setPosterClientForTests(undefined);
});

afterAll(async () => {
  await ctx.dispose();
});

function get(query: string): Promise<request.Response> {
  return request(ctx.app).get(`/api/reports/production-daily?${query}`).set('Authorization', `Bearer ${pmToken}`);
}

describe('GET /api/reports/production-daily', () => {
  it('summarises the Tashkent day: orders, output, cost, sales, profit', async () => {
    stubPoster();
    const res = await get('from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.summary).toMatchObject({ orders: 3, done_orders: 2, ordered_qty: 26, produced_qty: 16, supplies_total: 480000, supplies_count: 1 });

    const snickers = r.products.find((p: { product_name: string }) => p.product_name === 'Г/П СНИКЕРС');
    expect(snickers).toMatchObject({ produced_qty: 4, unit_cost: 4000, sell_price: 185000, cost_total: 16000, sales_total: 740000, profit_total: 724000, loss: false });
    const medovik = r.products.find((p: { product_name: string }) => p.product_name === 'Г/П МЕДОВИК');
    expect(medovik).toMatchObject({ unit_cost: 76000, sell_price: 70000, profit_total: -72000, loss: true });
    const kapriz = r.products.find((p: { product_name: string }) => p.product_name === 'Г/П КАПРИЗ');
    expect(kapriz).toMatchObject({ ordered_qty: 10, produced_qty: 0, pending_orders: 1 });

    expect(r.summary.profit_total).toBe(724000 - 72000);
  });

  it('shows each otdel with the raw materials issued to it', async () => {
    stubPoster();
    const r = (await get('from=2026-09-28&to=2026-09-28')).body;
    expect(r.otdels).toHaveLength(1);
    expect(r.otdels[0]).toMatchObject({ location_name: 'Оформления отдел', orders: 3, produced_qty: 16, raw_given_value: 16000 });
  });

  it('lists warehouses, low raw materials and the problems first', async () => {
    stubPoster();
    const r = (await get('from=2026-09-28&to=2026-09-28')).body;
    expect(r.stock.groups.find((g: { key: string }) => g.key === 'central').value).toBe(20000);
    expect(r.stock.low[0]).toMatchObject({ product_name: 'тухум', qty: 120, min_level: 500 });
    expect(r.problems.losses.map((l: { product_name: string }) => l.product_name)).toEqual(['Г/П МЕДОВИК']);
    expect(r.problems.unfinished.map((u: { product_name: string }) => u.product_name)).toEqual(['Г/П КАПРИЗ']);
  });

  it('still answers when Poster is down, with a warning instead of supplies', async () => {
    stubPoster({ fail: true });
    const res = await get('from=2026-09-28&to=2026-09-28');
    expect(res.status).toBe(200);
    expect(res.body.supplies).toBeNull();
    expect(res.body.warnings.join(' ')).toContain('postavka');
  });

  it('rejects a reversed range', async () => {
    stubPoster();
    expect((await get('from=2026-09-29&to=2026-09-28')).status).toBe(422);
  });
});
