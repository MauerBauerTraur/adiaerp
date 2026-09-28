/**
 * Krem kaymak is handed over by the kaymokchi, so its sub-order must wait for
 * the kaymokchi's "Berdim" instead of being auto-completed when the order is
 * created. Every other sub-order still auto-completes as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function statusOf(orderId: number): Promise<string> {
  const { rows } = await ctx.db.query<{ status: string }>(
    'SELECT status::text AS status FROM production_orders WHERE id = $1',
    [orderId],
  );
  return rows[0]!.status;
}

describe('POST /api/production-orders — krem kaymak hand-over', () => {
  it('leaves the kaymak sub-order waiting and auto-completes the others', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { name: 'Оформления отдел', type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    await makeLocation(ctx.db, { type: 'raw_warehouse' });

    const cake = await makeProduct(ctx.db, { name: 'Г/П СНИКЕРС', type: 'finished', unit: 'pcs' });
    const kaymak = await makeProduct(ctx.db, { name: 'крем каймак', type: 'semi', unit: 'kg' });
    const zg = await makeProduct(ctx.db, { name: 'з/г сникерс', type: 'semi', unit: 'kg' });
    const kaymok = await makeProduct(ctx.db, { name: 'каймок', type: 'raw', unit: 'kg' });
    const flour = await makeProduct(ctx.db, { name: 'ун', type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES
         ($1, $2, 0.5), ($1, $3, 1), ($2, $4, 0.8), ($3, $5, 0.3)`,
      [cake, kaymak, zg, kaymok, flour],
    );

    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: cake, qty: 4, location_id: prod, target_location_id: central });
    expect(res.status).toBe(201);

    const subs = res.body.sub_orders as { id: number; product_id: number }[];
    const kaymakSub = subs.find((s) => Number(s.product_id) === kaymak);
    const zgSub = subs.find((s) => Number(s.product_id) === zg);
    expect(kaymakSub).toBeDefined();
    expect(zgSub).toBeDefined();

    expect(await statusOf(Number(kaymakSub!.id))).toBe('new');
    expect(await statusOf(Number(zgSub!.id))).toBe('done');

    // The kaymokchi's "Berdim" finishes it.
    const done = await request(ctx.app)
      .patch(`/api/production-orders/${kaymakSub!.id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(await statusOf(Number(kaymakSub!.id))).toBe('done');
  });
});
