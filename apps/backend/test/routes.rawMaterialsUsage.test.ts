/**
 * GET /api/production-orders/raw-materials-usage — "Xomashyo iste'moli".
 *
 * The owner reads this page as "what did I hand to production on these days":
 * it sums the dispatch lines that were actually given out (status dispatched
 * or received), dated by when they were given (Asia/Tashkent), and never the
 * BOM-computed consumption of finished orders.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

type UsageRow = {
  product_id: number;
  product_name: string;
  unit: string;
  source: 'ombordan' | 'sexdan';
  total_qty: number;
  order_count: number;
  total_cost: number | null;
};

let pmToken: string;
let egg: number;
let flour: number;
let cream: number;

beforeAll(async () => {
  ctx = await createTestContext();
  const raw = await makeLocation(ctx.db, { name: 'Основной склад', type: 'raw_warehouse' });
  const oform = await makeLocation(ctx.db, { name: 'Оформления отдел', type: 'production' });
  const kremSex = await makeLocation(ctx.db, { name: 'Каймок отдел', type: 'production' });
  const central = await makeLocation(ctx.db, { name: 'Склад Центральный', type: 'central_warehouse' });
  pmToken = (await makeUser(ctx.db, { role: 'pm', locationId: null })).token;

  egg = await makeProduct(ctx.db, { name: 'тухум', type: 'raw', unit: 'pcs' });
  flour = await makeProduct(ctx.db, { name: 'ун', type: 'raw', unit: 'kg' });
  cream = await makeProduct(ctx.db, { name: 'крем каймак', type: 'semi', unit: 'kg' });
  const cake = await makeProduct(ctx.db, { name: 'Г/П СНИКЕРС', type: 'finished', unit: 'pcs' });
  await ctx.db.query('UPDATE products SET cost_price = 1350 WHERE id = $1', [egg]);

  const order = async (productId: number): Promise<number> => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 4, $2, $3, 'new') RETURNING id`,
      [productId, oform, central],
    );
    return Number(rows[0]!.id);
  };
  const dispatch = async (o: {
    orderId: number; productId: number; qty: number; from: number; to: number;
    status: 'pending' | 'dispatched' | 'received'; at: string | null;
  }): Promise<void> => {
    await ctx.db.query(
      `INSERT INTO production_dispatches
         (production_order_id, product_id, product_name, product_unit, qty_needed,
          from_location_id, to_location_id, status, dispatched_at)
       VALUES ($1, $2, 'x', 'kg', $3, $4, $5, $6, $7)`,
      [o.orderId, o.productId, o.qty, o.from, o.to, o.status, o.at],
    );
  };

  const o1 = await order(cake);
  const o2 = await order(cake);
  // 2026-09-27T20:30Z is 28 Sep 01:30 in Tashkent — it belongs to the 28th.
  await dispatch({ orderId: o1, productId: egg, qty: 10, from: raw, to: oform, status: 'dispatched', at: '2026-09-27T20:30:00Z' });
  await dispatch({ orderId: o1, productId: flour, qty: 2, from: raw, to: oform, status: 'received', at: '2026-09-28T06:00:00Z' });
  await dispatch({ orderId: o2, productId: egg, qty: 6, from: raw, to: oform, status: 'received', at: '2026-09-28T07:00:00Z' });
  // A semi handed over from another sex.
  await dispatch({ orderId: o1, productId: cream, qty: 3, from: kremSex, to: oform, status: 'received', at: '2026-09-28T08:00:00Z' });
  // Not given out yet — must not count.
  await dispatch({ orderId: o1, productId: flour, qty: 5, from: raw, to: oform, status: 'pending', at: null });
  // The order's own output going to the warehouse — not an input.
  await dispatch({ orderId: o1, productId: cake, qty: 4, from: oform, to: central, status: 'dispatched', at: '2026-09-28T09:00:00Z' });
  // Given on the 27th (Tashkent).
  await dispatch({ orderId: o2, productId: flour, qty: 1, from: raw, to: oform, status: 'dispatched', at: '2026-09-27T10:00:00Z' });

  // BOM consumption of a finished order must NOT feed this report any more.
  await ctx.db.query(
    `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason, production_order_id, created_at)
     VALUES ($1, $2, NULL, 999, 'production_input', $3, '2026-09-28T10:00:00Z')`,
    [egg, oform, o1],
  );
});

afterAll(async () => {
  await ctx.dispose();
});

async function usage(from: string, to: string): Promise<request.Response> {
  return request(ctx.app)
    .get(`/api/production-orders/raw-materials-usage?from=${from}&to=${to}`)
    .set('Authorization', `Bearer ${pmToken}`);
}

describe('GET /api/production-orders/raw-materials-usage', () => {
  it('sums what was given to production on the day, by Tashkent date', async () => {
    const res = await usage('2026-09-28', '2026-09-28');
    expect(res.status).toBe(200);
    const rows = res.body as UsageRow[];
    const byKey = new Map(rows.map((r) => [`${r.product_id}:${r.source}`, r]));

    const eggRow = byKey.get(`${egg}:ombordan`);
    expect(eggRow?.total_qty).toBe(16); // 10 + 6, not the 999 BOM consumption
    expect(eggRow?.order_count).toBe(2);
    expect(eggRow?.total_cost).toBe(16 * 1350);

    expect(byKey.get(`${flour}:ombordan`)?.total_qty).toBe(2); // pending 5 excluded, 27th excluded
    expect(byKey.get(`${cream}:sexdan`)?.total_qty).toBe(3);
    expect(rows).toHaveLength(3); // the output dispatch is not an input
  });

  it('puts a dispatch in the Tashkent day it was given', async () => {
    const rows = (await usage('2026-09-27', '2026-09-27')).body as UsageRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: flour, source: 'ombordan', total_qty: 1 });
  });

  it('rejects a range whose start is after its end', async () => {
    const res = await usage('2026-09-28', '2026-09-27');
    expect(res.status).toBe(422);
  });
});
