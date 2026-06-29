/**
 * List-response contract regression tests (spec section 4).
 *
 * The frontend depends on a fixed response shape per endpoint:
 *   - GET /api/products, /api/locations, /api/users, /api/stock
 *       -> a BARE ARRAY (no envelope);
 *   - GET /api/stock/movements
 *       -> the one paginated envelope `{ items, total, limit, offset }`.
 *
 * This suite locks those shapes so a regression to an envelope (or away from
 * the pagination envelope) fails fast.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeLocation, makeProduct, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('list endpoints return a bare array', () => {
  it('GET /api/products -> Product[]', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/locations -> Location[]', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeLocation(ctx.db);
    const res = await request(ctx.app)
      .get('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/users -> User[]', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/stock -> StockRow[] with embedded product_name/product_unit', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: loc, productId: product, qty: 7 });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/stock?location_id=${loc}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = (res.body as { product_name: string; product_unit: string }[])[0];
    expect(typeof row.product_name).toBe('string');
    expect(typeof row.product_unit).toBe('string');
  });
});

describe('GET /api/stock/movements -> pagination envelope', () => {
  it('returns { items, total, limit, offset } with embedded names', async () => {
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: wh, productId: product, qty: 20 });
    // PM is read-only on movement (owner-approved 2026-05-28). The
    // operator that owns the `from` location creates them; PM still
    // reads the list.
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: wh,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, from_location_id: wh, to_location_id: store, qty: 5 });

    const res = await request(ctx.app)
      .get(`/api/stock/movements?location_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.limit).toBe('number');
    expect(typeof res.body.offset).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.length).toBe(res.body.total);

    const item = res.body.items[0];
    expect(typeof item.product_name).toBe('string');
    expect(typeof item.product_unit).toBe('string');
    expect(typeof item.from_location_name).toBe('string');
    expect(typeof item.to_location_name).toBe('string');
  });

  it('total counts the filtered set, not just the returned page', async () => {
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: wh, productId: product, qty: 100 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: wh,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    for (let n = 0; n < 3; n += 1) {
      await request(ctx.app)
        .post('/api/stock/movement')
        .set('Authorization', `Bearer ${cwm.token}`)
        .send({ product_id: product, from_location_id: wh, to_location_id: store, qty: 1 });
    }

    const res = await request(ctx.app)
      .get(`/api/stock/movements?location_id=${store}&limit=1`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.limit).toBe(1);
  });
});
