/**
 * F4.6 — `GET /api/dashboard/chain-layer/:type` integration tests.
 *
 * The endpoint backs the five chain-layer pages (raw_warehouse, production,
 * supply, central_warehouse, store). Per-layer it returns the locations of
 * that type with KPIs, totals, recent movements, and layer-specific extras
 * (active_production_orders / pending_shipments / sales_today_count).
 *
 * Coverage:
 *   - All five layer types return a well-shaped payload for PM.
 *   - production layer carries `active_production_orders`.
 *   - supply / central_warehouse carry `pending_shipments`.
 *   - store carries `sales_today_count`.
 *   - Each layer's manager passes RBAC; a non-matching manager gets 403.
 *   - An unknown `:type` returns 422.
 *   - A scoped manager's totals only count their own locations.
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

const LAYER_TYPES = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;
type LayerType = (typeof LAYER_TYPES)[number];

describe('GET /api/dashboard/chain-layer/:type', () => {
  it.each(LAYER_TYPES)(
    'PM gets a well-shaped payload for layer %s',
    async (layer: LayerType) => {
      const pm = await makeUser(ctx.db, { role: 'pm' });
      const loc = await makeLocation(ctx.db, { type: layer });
      const product = await makeProduct(ctx.db);
      await setStock(ctx.db, {
        locationId: loc,
        productId: product,
        qty: 1,
        minLevel: 5,
        maxLevel: 20,
      });

      const res = await request(ctx.app)
        .get(`/api/dashboard/chain-layer/${layer}`)
        .set('Authorization', `Bearer ${pm.token}`);
      expect(res.status).toBe(200);
      expect(res.body.layer_type).toBe(layer);
      expect(Array.isArray(res.body.locations)).toBe(true);
      // Every returned location row is of the requested type.
      for (const row of res.body.locations as { type: string }[]) {
        expect(row.type).toBe(layer);
      }
      // The seeded location is in the result.
      const ids = (res.body.locations as { id: number }[]).map((r) => Number(r.id));
      expect(ids).toContain(loc);

      expect(res.body.totals.total_locations).toBeGreaterThanOrEqual(1);
      expect(res.body.totals.total_products).toBeGreaterThanOrEqual(1);
      expect(res.body.totals.below_min_count).toBeGreaterThanOrEqual(1);
      expect(typeof res.body.totals.open_requests_count).toBe('number');
      expect(Array.isArray(res.body.recent_movements)).toBe(true);

      // Layer-specific extras.
      if (layer === 'production') {
        expect(typeof res.body.totals.active_production_orders).toBe('number');
      } else {
        expect(res.body.totals.active_production_orders).toBeUndefined();
      }
      if (layer === 'supply' || layer === 'central_warehouse') {
        expect(typeof res.body.totals.pending_shipments).toBe('number');
      } else {
        expect(res.body.totals.pending_shipments).toBeUndefined();
      }
      if (layer === 'store') {
        expect(typeof res.body.totals.sales_today_count).toBe('number');
      } else {
        expect(res.body.totals.sales_today_count).toBeUndefined();
      }
    },
  );

  it('production layer counts active production orders', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await ctx.db.query(
      `INSERT INTO production_orders
         (product_id, qty, status, location_id, target_location_id, created_by)
       VALUES ($1, 10, 'new', $2, $3, $4),
              ($1, 5,  'in_progress', $2, $3, $4),
              ($1, 8,  'done', $2, $3, $4)`,
      [product, prod, central, pm.id],
    );
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/production')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    // Two open (new + in_progress); done is excluded.
    expect(res.body.totals.active_production_orders).toBeGreaterThanOrEqual(2);
  });

  it('supply layer counts pending shipments (replenishment_requests targeting supply)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const supply = await makeLocation(ctx.db, { type: 'supply' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await ctx.db.query(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
       VALUES ($1, $2, $3, 12, 'NEW', $4),
              ($1, $2, $3, 5,  'CLOSED', $4)`,
      [product, store, supply, pm.id],
    );
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/supply')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    // Only the NEW row is pending; CLOSED is terminal.
    expect(res.body.totals.pending_shipments).toBeGreaterThanOrEqual(1);
  });

  it('store layer counts today sales', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
         poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 3, 1000, now(), 99001, 1),
              ($1, $2, 1, 1000, now(), 99001, 2)`,
      [store, product],
    );
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/store')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.sales_today_count).toBeGreaterThanOrEqual(2);
  });

  it('rejects an unknown layer type with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/garage')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('a non-matching layer manager is forbidden (403)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/raw_warehouse')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('the matching layer manager is scoped to its own locations', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, {
      locationId: ownStore,
      productId: product,
      qty: 2,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, {
      locationId: otherStore,
      productId: product,
      qty: 2,
      minLevel: 5,
      maxLevel: 10,
    });
    const res = await request(ctx.app)
      .get('/api/dashboard/chain-layer/store')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.locations as { id: number }[]).map((r) => Number(r.id));
    expect(ids).toContain(ownStore);
    expect(ids).not.toContain(otherStore);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/chain-layer/store');
    expect(res.status).toBe(401);
  });
});
