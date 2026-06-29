/**
 * M3 — Stock & Movements HTTP integration tests (spec section 4.4).
 *
 * Covers the endpoint layer over `applyMovement`:
 *   - GET /api/stock              RBAC scoping;
 *   - PATCH /api/stock/minmax     own-location guard;
 *   - POST /api/stock/movement    201 happy path, 409 on shortage, RBAC;
 *   - GET /api/stock/movements    history + scoping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeLocation, makeProduct, setStock, getQty } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('GET /api/stock — RBAC scoping', () => {
  it('a manager sees only its own location stock; pm sees all', async () => {
    const whId = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: whId, productId: product, qty: 5 });
    await setStock(ctx.db, { locationId: storeId, productId: product, qty: 3 });

    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
    const mgrRes = await request(ctx.app)
      .get('/api/stock')
      .set('Authorization', `Bearer ${storeMgr.token}`);
    expect(mgrRes.status).toBe(200);
    expect(Array.isArray(mgrRes.body)).toBe(true);
    expect(
      (mgrRes.body as { location_id: number }[]).every(
        (r) => Number(r.location_id) === storeId,
      ),
    ).toBe(true);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const pmRes = await request(ctx.app)
      .get('/api/stock')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(pmRes.body.length).toBeGreaterThanOrEqual(2);
  });

  it('a manager asking for another location is forbidden (403)', async () => {
    const own = await makeLocation(ctx.db, { type: 'store' });
    const other = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: own });
    const res = await request(ctx.app)
      .get(`/api/stock?location_id=${other}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/stock/minmax', () => {
  it('sets min/max for an own location and audit-logs it', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: loc, product_id: product, min_level: 5, max_level: 20 });
    expect(res.status).toBe(200);
    expect(Number(res.body.stock.min_level)).toBe(5);
    expect(Number(res.body.stock.max_level)).toBe(20);

    // `stock` has a composite PK — the audit row carries both keys in the
    // payload and leaves entity_id NULL.
    const audit = await ctx.db.query<{ entity_id: number | null; payload: unknown }>(
      `SELECT entity_id, payload FROM audit_log
       WHERE action = 'stock.minmax.update'
       ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.entity_id).toBe(null);
    const payload = audit.rows[0]?.payload as { location_id: number; product_id: number };
    expect(Number(payload.location_id)).toBe(loc);
    expect(Number(payload.product_id)).toBe(product);
  });

  it('rejects max < min (422) and another location (403)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const other = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const bad = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: loc, product_id: product, min_level: 10, max_level: 2 });
    expect(bad.status).toBe(422);

    const denied = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: other, product_id: product, min_level: 1, max_level: 2 });
    expect(denied.status).toBe(403);
  });
});

describe('POST /api/stock/movement', () => {
  it('AC3.1 — a transfer moves stock and returns 201 with a movement id', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 10 });
    // PM is read-only (owner-approved 2026-05-28) — use the central
    // warehouse manager who owns `from`.
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 4,
        reason: 'transfer',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.movement_id)).toBeGreaterThan(0);
    expect(await getQty(ctx.db, from, product)).toBe(6);
    expect(await getQty(ctx.db, to, product)).toBe(4);
  });

  it('AC3.2 — a shortage returns 409 INSUFFICIENT_STOCK and changes nothing', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 2 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 9,
        reason: 'transfer',
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await getQty(ctx.db, from, product)).toBe(2);
    expect(await getQty(ctx.db, to, product)).toBe(null);
  });

  it('a system reason from a client is rejected (422)', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 10 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 1,
        reason: 'purchase',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a two-sided movement sent with reason "adjust" is rejected (422)', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 10 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 1,
        reason: 'adjust',
      });
    expect(res.status).toBe(422);
  });

  it('a one-sided movement with no reason is accepted as an adjust (201)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db);
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: loc,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, to_location_id: loc, qty: 8 });
    expect(res.status).toBe(201);
    expect(await getQty(ctx.db, loc, product)).toBe(8);

    const movement = await ctx.db.query<{ reason: string }>(
      'SELECT reason FROM stock_movements WHERE id = $1',
      [res.body.movement_id],
    );
    expect(movement.rows[0]?.reason).toBe('adjust');
  });

  it('a two-sided movement with no reason is accepted as a transfer (201)', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 10 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, from_location_id: from, to_location_id: to, qty: 3 });
    expect(res.status).toBe(201);
    const movement = await ctx.db.query<{ reason: string }>(
      'SELECT reason FROM stock_movements WHERE id = $1',
      [res.body.movement_id],
    );
    expect(movement.rows[0]?.reason).toBe('transfer');
  });

  it('a store manager may not create a movement at all (403)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: loc, productId: product, qty: 5 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ product_id: product, from_location_id: loc, qty: 1, reason: 'adjust' });
    expect(res.status).toBe(403);
  });

  it('a scoped manager cannot move stock that does not involve its location (403)', async () => {
    const own = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const foreignA = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const foreignB = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: foreignA, productId: product, qty: 5 });
    const mgr = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: own });

    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        product_id: product,
        from_location_id: foreignA,
        to_location_id: foreignB,
        qty: 1,
        reason: 'transfer',
      });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/stock/movements', () => {
  it('returns movement history scoped to the manager location', async () => {
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: wh, productId: product, qty: 10 });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: wh,
    });

    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product,
        from_location_id: wh,
        to_location_id: store,
        qty: 3,
        reason: 'transfer',
      });

    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .get('/api/stock/movements')
      .set('Authorization', `Bearer ${storeMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    // Every returned movement touches the store.
    expect(
      (res.body.items as { from_location_id: number; to_location_id: number }[]).every(
        (m) => Number(m.from_location_id) === store || Number(m.to_location_id) === store,
      ),
    ).toBe(true);
    // Embedded JOIN fields are present.
    expect(typeof res.body.items[0].product_name).toBe('string');
    expect(typeof res.body.items[0].to_location_name).toBe('string');
  });
});
