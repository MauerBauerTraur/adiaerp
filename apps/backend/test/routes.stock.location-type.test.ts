/**
 * F4.6 — `GET /api/stock?location_type=` filter.
 *
 * Each chain layer page hits `/api/stock` with a `location_type` filter
 * and expects every stock row for every location of that type back.
 *
 * Covered:
 *   - PM sees every location of the requested type, regardless of how many
 *     locations exist on other types.
 *   - A scoped manager only sees rows from locations of the type that ALSO
 *     belong to its `locationIds` set.
 *   - An unknown `location_type` value is rejected with 422.
 *   - `location_type` and `location_id` are mutually exclusive (422).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('GET /api/stock?location_type=', () => {
  it('PM gets stock for every location of the requested type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const storeA = await makeLocation(ctx.db, { type: 'store' });
    const storeB = await makeLocation(ctx.db, { type: 'store' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const cake = await makeProduct(ctx.db);
    const flour = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: storeA, productId: cake, qty: 5 });
    await setStock(ctx.db, { locationId: storeB, productId: cake, qty: 7 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const res = await request(ctx.app)
      .get('/api/stock?location_type=store')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { location_id: number }[]).map((r) => Number(r.location_id));
    // Both store rows present, raw_warehouse row absent.
    expect(ids).toEqual(expect.arrayContaining([storeA, storeB]));
    expect(ids).not.toContain(rawWh);
  });

  it('a scoped manager only sees rows from the intersection of type and own locations', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 3 });
    await setStock(ctx.db, { locationId: otherStore, productId: cake, qty: 4 });

    const res = await request(ctx.app)
      .get('/api/stock?location_type=store')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { location_id: number }[]).map((r) => Number(r.location_id));
    expect(ids).toContain(ownStore);
    expect(ids).not.toContain(otherStore);
  });

  it('rejects an unknown location_type (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock?location_type=garage')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects passing both location_id and location_type (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .get(`/api/stock?location_id=${loc}&location_type=store`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('a scoped manager asking for a type with no matching own location gets an empty list', async () => {
    // The DB CHECK constraint requires location-scoped roles to carry a
    // primary location, so we cannot test the "locationIds is empty"
    // branch directly. Instead: the manager's location is a `store`, so
    // filtering by `raw_warehouse` intersects to zero rows.
    const own = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: own });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const flour = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 50 });
    const res = await request(ctx.app)
      .get('/api/stock?location_type=raw_warehouse')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
