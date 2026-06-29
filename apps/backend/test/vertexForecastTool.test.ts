/**
 * `get_forecast` AI tool — executor test (F3.4 / ADR-0010).
 *
 * The tool reads the `forecasts` cache table; the sidecar is never called
 * at request time. We seed `forecasts` rows by hand and verify:
 *
 *   1. PM sees every (location, product) row, ordered by stockout date.
 *   2. A `store_manager` is pinned to their own location_id by the
 *      server-side scope helper even when args say otherwise.
 *   3. `daily_predictions` is sliced to `days_ahead` entries.
 *   4. Empty result (no cached row) returns `[]` — system prompt rule #8
 *      tells the model to reply "Ma'lumot yetarli emas".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../src/integrations/vertex/tools.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import type { AuthPrincipal } from '../src/auth/jwt.js';

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

function pmPrincipal(userId: number): AuthPrincipal {
  return { userId, role: 'pm', locationId: null };
}
function managerPrincipal(userId: number, locationId: number): AuthPrincipal {
  return { userId, role: 'store_manager', locationId };
}

async function seedForecast(
  locationId: number,
  productId: number,
  predictions: Array<{ date: string; yhat: number; yhat_lower: number; yhat_upper: number }>,
  stockout: string | null,
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO forecasts (location_id, product_id, daily_predictions,
                            expected_stockout_date, generated_at, source)
     VALUES ($1, $2, $3::jsonb, $4, now(), 'prophet')
     ON CONFLICT (location_id, product_id) DO UPDATE
       SET daily_predictions = EXCLUDED.daily_predictions,
           expected_stockout_date = EXCLUDED.expected_stockout_date`,
    [locationId, productId, JSON.stringify(predictions), stockout],
  );
}

describe('get_forecast executor', () => {
  it('returns every row for a PM principal', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const l1 = await makeLocation(ctx.db, { name: 'L1' });
    const l2 = await makeLocation(ctx.db, { name: 'L2' });
    const p1 = await makeProduct(ctx.db);
    const p2 = await makeProduct(ctx.db);
    await seedForecast(
      l1,
      p1,
      [{ date: '2099-01-01', yhat: 5, yhat_lower: 4, yhat_upper: 6 }],
      '2099-02-01',
    );
    await seedForecast(
      l2,
      p2,
      [{ date: '2099-01-01', yhat: 8, yhat_lower: 7, yhat_upper: 9 }],
      '2099-01-15',
    );

    const rows = await TOOL_REGISTRY.get_forecast.execute({}, pmPrincipal(pm.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Earlier stockout first.
    const indexL2 = rows.findIndex((r) => r.location_id === l2);
    const indexL1 = rows.findIndex((r) => r.location_id === l1);
    expect(indexL2).toBeLessThan(indexL1);
  });

  it('pins a store_manager to their own location even when args override', async () => {
    const ownLoc = await makeLocation(ctx.db, { name: 'own' });
    const otherLoc = await makeLocation(ctx.db, { name: 'other' });
    const product = await makeProduct(ctx.db);
    await seedForecast(
      ownLoc,
      product,
      [{ date: '2099-01-01', yhat: 1, yhat_lower: 0, yhat_upper: 2 }],
      null,
    );
    await seedForecast(
      otherLoc,
      product,
      [{ date: '2099-01-01', yhat: 1, yhat_lower: 0, yhat_upper: 2 }],
      null,
    );
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: ownLoc,
    });

    const rows = await TOOL_REGISTRY.get_forecast.execute(
      { location_id: otherLoc },
      managerPrincipal(manager.id, ownLoc),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location_id).toBe(ownLoc);
  });

  it('slices daily_predictions to days_ahead entries', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db);
    const product = await makeProduct(ctx.db);
    const predictions = Array.from({ length: 14 }, (_, i) => ({
      date: `2099-01-${String(i + 1).padStart(2, '0')}`,
      yhat: 1,
      yhat_lower: 0,
      yhat_upper: 2,
    }));
    await seedForecast(loc, product, predictions, null);

    const rows = await TOOL_REGISTRY.get_forecast.execute(
      { days_ahead: 3 },
      pmPrincipal(pm.id),
    );
    expect(rows).toHaveLength(1);
    const dailyPredictions = rows[0]!.daily_predictions as unknown as Array<{ date: string }>;
    expect(Array.isArray(dailyPredictions)).toBe(true);
    expect(dailyPredictions).toHaveLength(3);
  });

  it('returns an empty array when no forecast row exists (Maʼlumot yetarli emas)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rows = await TOOL_REGISTRY.get_forecast.execute(
      { product_id: 999999 },
      pmPrincipal(pm.id),
    );
    expect(rows).toEqual([]);
  });
});
