/**
 * Sub-task #5 — GET /api/dashboard/aging-alerts integration tests.
 *
 * The endpoint flags stock sitting in a `sex_storage` for longer than its
 * `products.shelf_life_days` threshold. Coverage:
 *
 *   - critical urgency when days_in_storage >= shelf_life_days.
 *   - warning urgency at the 70% safe-zone boundary.
 *   - fresh stock (just landed) is NOT returned.
 *   - products with NULL shelf_life_days are ignored.
 *   - location scoping: a supply_manager only sees their own sex skladi.
 *   - PM sees the whole chain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
} from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Each test seeds fresh rows. Truncate dependent tables to keep them
  // isolated (FK cascade order matters).
  await ctx.db.query(`DELETE FROM stock_movements`);
  await ctx.db.query(`DELETE FROM stock`);
  await ctx.db.query(`DELETE FROM user_locations`);
  await ctx.db.query(`DELETE FROM users`);
  await ctx.db.query(`DELETE FROM products`);
  // Locations cannot be wiped because the migration seeds them; we always
  // create fresh sex_storage rows per test and rely on their isolated ids.
});

/**
 * Insert a deterministic inbound movement N days ago for (product, location)
 * so the aging query has a `last_inbound_at` to anchor on.
 */
async function seedInbound(opts: {
  productId: number;
  locationId: number;
  daysAgo: number;
  createdBy: number;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO stock_movements
       (product_id, to_location_id, qty, reason, created_by, created_at)
     VALUES ($1, $2, $3, 'production_output', $4, now() - make_interval(days => $5::int))`,
    [opts.productId, opts.locationId, 1, opts.createdBy, opts.daysAgo],
  );
}

describe('GET /api/dashboard/aging-alerts', () => {
  it('returns critical + warning items and skips fresh / non-expiring stock', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const sexStorage = await makeLocation(ctx.db, {
      type: 'sex_storage',
      name: 'Tort skladi',
    });

    // Product A — 5 day shelf life, sitting 6 days -> CRITICAL.
    const critical = await makeProduct(ctx.db, {
      name: 'Krem',
      type: 'semi',
      unit: 'kg',
    });
    await ctx.db.query(`UPDATE products SET shelf_life_days = 5 WHERE id = $1`, [
      critical,
    ]);
    await setStock(ctx.db, {
      locationId: sexStorage,
      productId: critical,
      qty: 2,
    });
    await seedInbound({
      productId: critical,
      locationId: sexStorage,
      daysAgo: 6,
      createdBy: pm.id,
    });

    // Product B — 10 day shelf life, sitting 8 days -> WARNING (80% > 70%).
    const warning = await makeProduct(ctx.db, {
      name: 'Hamr',
      type: 'semi',
      unit: 'kg',
    });
    await ctx.db.query(`UPDATE products SET shelf_life_days = 10 WHERE id = $1`, [
      warning,
    ]);
    await setStock(ctx.db, {
      locationId: sexStorage,
      productId: warning,
      qty: 3,
    });
    await seedInbound({
      productId: warning,
      locationId: sexStorage,
      daysAgo: 8,
      createdBy: pm.id,
    });

    // Product C — 5 day shelf life, JUST landed today -> NOT returned.
    const fresh = await makeProduct(ctx.db, {
      name: 'Tort base',
      type: 'semi',
      unit: 'pcs',
    });
    await ctx.db.query(`UPDATE products SET shelf_life_days = 5 WHERE id = $1`, [
      fresh,
    ]);
    await setStock(ctx.db, {
      locationId: sexStorage,
      productId: fresh,
      qty: 4,
    });
    await seedInbound({
      productId: fresh,
      locationId: sexStorage,
      daysAgo: 0,
      createdBy: pm.id,
    });

    // Product D — NULL shelf life (raw flour). Even if old, MUST NOT appear.
    const raw = await makeProduct(ctx.db, {
      name: 'Un',
      type: 'raw',
      unit: 'kg',
    });
    // shelf_life_days stays NULL by default.
    await setStock(ctx.db, { locationId: sexStorage, productId: raw, qty: 50 });
    await seedInbound({
      productId: raw,
      locationId: sexStorage,
      daysAgo: 30,
      createdBy: pm.id,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/aging-alerts')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    const items: Array<{
      product_id: number;
      product_name: string;
      urgency: 'warning' | 'critical';
      days_in_storage: number;
      shelf_life_days: number;
    }> = res.body.items;

    // Only the two products that crossed the 70% threshold.
    expect(items).toHaveLength(2);

    const byProduct = new Map(items.map((i) => [i.product_id, i]));
    const c = byProduct.get(critical);
    const w = byProduct.get(warning);
    expect(c?.urgency).toBe('critical');
    expect(c?.shelf_life_days).toBe(5);
    expect(c?.days_in_storage).toBeGreaterThanOrEqual(6);
    expect(w?.urgency).toBe('warning');
    expect(w?.shelf_life_days).toBe(10);
    expect(w?.days_in_storage).toBeGreaterThanOrEqual(8);

    // Fresh + raw must not be in the response.
    expect(byProduct.has(fresh)).toBe(false);
    expect(byProduct.has(raw)).toBe(false);
  });

  it('scopes the feed to the principal assigned sex_storage', async () => {
    const myStorage = await makeLocation(ctx.db, {
      type: 'sex_storage',
      name: 'Mine',
    });
    const otherStorage = await makeLocation(ctx.db, {
      type: 'sex_storage',
      name: 'Other',
    });

    const me = await makeUser(ctx.db, {
      role: 'supply_manager',
      locationId: myStorage,
    });

    const product = await makeProduct(ctx.db, {
      name: 'Krem',
      type: 'semi',
      unit: 'kg',
    });
    await ctx.db.query(`UPDATE products SET shelf_life_days = 3 WHERE id = $1`, [
      product,
    ]);

    // Both storages have the same aging stock.
    for (const loc of [myStorage, otherStorage]) {
      await setStock(ctx.db, { locationId: loc, productId: product, qty: 1 });
      await seedInbound({
        productId: product,
        locationId: loc,
        daysAgo: 5,
        createdBy: me.id,
      });
    }

    const res = await request(ctx.app)
      .get('/api/dashboard/aging-alerts')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    const items: Array<{ location_id: number }> = res.body.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.location_id).toBe(myStorage);
  });
});
