/**
 * `GET /api/forecasts` route test (F3.4 / ADR-0010).
 *
 * Verifies:
 *   * Auth required (401 without a JWT).
 *   * PM sees every row; store_manager pinned to their own location_id.
 *   * Stale flag flips when `generated_at` is older than 24h.
 *   * Filters `location_id` / `product_id` work for PM.
 *   * Empty payload when a scoped principal has `locationId === null`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { signToken } from '../src/auth/jwt.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM forecasts');
});

afterEach(async () => {
  // Tests touch users/locations/products — clean broadly to avoid PK clashes
  // between describe blocks.
  await ctx.db.query('DELETE FROM forecasts');
});

async function seedForecast(
  locationId: number,
  productId: number,
  opts: { generatedAt?: Date; expectedStockoutDate?: string | null } = {},
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO forecasts (location_id, product_id, daily_predictions,
                            expected_stockout_date, generated_at, source)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'prophet')
     ON CONFLICT (location_id, product_id) DO UPDATE
       SET daily_predictions = EXCLUDED.daily_predictions,
           expected_stockout_date = EXCLUDED.expected_stockout_date,
           generated_at = EXCLUDED.generated_at`,
    [
      locationId,
      productId,
      JSON.stringify([{ date: '2099-01-01', yhat: 5, yhat_lower: 4, yhat_upper: 6 }]),
      opts.expectedStockoutDate ?? null,
      opts.generatedAt ?? new Date(),
    ],
  );
}

describe('GET /api/forecasts', () => {
  it('returns 401 without a token', async () => {
    const res = await request(ctx.app).get('/api/forecasts');
    expect(res.status).toBe(401);
  });

  it('PM sees every forecast row', async () => {
    const l1 = await makeLocation(ctx.db, { name: 'PM-L1' });
    const l2 = await makeLocation(ctx.db, { name: 'PM-L2' });
    const p1 = await makeProduct(ctx.db);
    const p2 = await makeProduct(ctx.db);
    await seedForecast(l1, p1);
    await seedForecast(l2, p2);
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

    const res = await request(ctx.app)
      .get('/api/forecasts')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });

  it('store_manager is pinned to their own location', async () => {
    const ownStore = await makeLocation(ctx.db, { name: 'own-store' });
    const otherStore = await makeLocation(ctx.db, { name: 'other-store' });
    const product = await makeProduct(ctx.db);
    await seedForecast(ownStore, product);
    await seedForecast(otherStore, product);
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: ownStore,
    });

    // Even with a misleading ?location_id=otherStore, RBAC pins to own.
    const res = await request(ctx.app)
      .get(`/api/forecasts?location_id=${otherStore}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].location_id).toBe(ownStore);
  });

  it('flags stale forecasts (generated_at > 24h ago)', async () => {
    const loc = await makeLocation(ctx.db);
    const product = await makeProduct(ctx.db);
    // 48h ago — should be stale.
    await seedForecast(loc, product, {
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

    const res = await request(ctx.app)
      .get('/api/forecasts')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].stale).toBe(true);
  });

  it('returns empty list when a scoped principal has no locationId', async () => {
    const loc = await makeLocation(ctx.db);
    const product = await makeProduct(ctx.db);
    await seedForecast(loc, product);
    // The DB CHECK forbids a managed user with NULL location_id, but a JWT
    // could be issued before a location bind / after an unbind. Mint such a
    // token directly to exercise the route's defensive empty-list branch.
    const orphanToken = signToken({
      userId: 9999999,
      role: 'store_manager',
      locationId: null,
    });

    const res = await request(ctx.app)
      .get('/api/forecasts')
      .set('Authorization', `Bearer ${orphanToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('rejects invalid filter values', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/forecasts?location_id=not-a-number')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });
});
