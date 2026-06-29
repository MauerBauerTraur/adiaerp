/**
 * Dynamic min/max recalc cron — integration test (Phase-2 F2.1).
 *
 * Exercises `runMinmaxRecalcCycle()` against an isolated schema. Covers:
 *   - `minmax_mode='dynamic'` rows are recomputed; `'manual'` rows are not;
 *   - `avg_daily = 0` / no sales history → row skipped, info warning logged,
 *     `last_recalc_at` still stamped;
 *   - audit row carries the formula inputs + old/new pair;
 *   - filter `{ locationId, productId }` narrows the iteration;
 *   - sales doubled → recalc roughly doubles min/max (TZ §15 AC#3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { runSalesAggregateCycle } from '../src/workers/salesAggregateCron.js';
import { runMinmaxRecalcCycle } from '../src/workers/minmaxRecalcCron.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Clean DB state between tests — each test seeds what it needs.
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM import_warnings');
  await ctx.db.query('DELETE FROM sales');
  await ctx.db.query('DELETE FROM sales_stats_daily');
  await ctx.db.query('DELETE FROM stock');
});

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function seedDailySales(
  storeId: number,
  productId: number,
  dailyQty: number,
  days: number,
): Promise<void> {
  for (let i = 0; i < days; i += 1) {
    const txId = Date.now() * 1000 + Math.floor(Math.random() * 999) + i;
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
                          poster_transaction_id, poster_line_id)
       VALUES ($1, $2, $3, 0, $4, $5, 1)`,
      [storeId, productId, dailyQty, daysAgo(i).toISOString(), txId],
    );
  }
}

describe('runMinmaxRecalcCycle', () => {
  it('updates min/max for dynamic rows with the TZ §8.3 formula', async () => {
    // Location defaults: lead_time=1, review=2, safety=1.3 (schema default).
    // We override on insert so the math is predictable.
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, lead_time_days, review_days, safety_factor)
       VALUES ('Test store', 'store', 2, 2, 1.3) RETURNING id`,
    );
    const storeId = Number(rows[0]!.id);
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });

    // Sales: 10 units/day for 14 days → avg_7d = 10 → avg_daily = 10.
    await seedDailySales(storeId, productId, 10, 14);
    await runSalesAggregateCycle();

    // Stock seeded with old min/max (manual values) then mode flipped.
    await setStock(ctx.db, { locationId: storeId, productId, qty: 50, minLevel: 5, maxLevel: 20 });
    await ctx.db.query(
      `UPDATE stock SET minmax_mode = 'dynamic'
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );

    const summary = await runMinmaxRecalcCycle();
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);

    // Formula: min = 10 * 2 * 1.3 = 26; max = 26 + 10 * 2 = 46.
    const { rows: stockRows } = await ctx.db.query<{
      min_level: string;
      max_level: string;
      last_recalc_at: Date | null;
    }>(
      `SELECT min_level, max_level, last_recalc_at FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    expect(Number(stockRows[0]!.min_level)).toBeCloseTo(26, 2);
    expect(Number(stockRows[0]!.max_level)).toBeCloseTo(46, 2);
    expect(stockRows[0]!.last_recalc_at).not.toBeNull();
  });

  it('does not touch rows where minmax_mode is manual', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    await seedDailySales(storeId, productId, 10, 14);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: storeId, productId, qty: 50, minLevel: 5, maxLevel: 20 });
    // Mode left at 'manual' (default).

    await runMinmaxRecalcCycle();

    const { rows } = await ctx.db.query<{ min_level: string; max_level: string }>(
      `SELECT min_level, max_level FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    expect(Number(rows[0]!.min_level)).toBe(5);
    expect(Number(rows[0]!.max_level)).toBe(20);
  });

  it('skips rows with no sales history and writes an info import_warning', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: storeId, productId, qty: 0, minLevel: 5, maxLevel: 20 });
    await ctx.db.query(
      `UPDATE stock SET minmax_mode = 'dynamic'
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );

    const summary = await runMinmaxRecalcCycle();
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(1);

    // min/max unchanged.
    const { rows: stockRows } = await ctx.db.query<{
      min_level: string;
      max_level: string;
      last_recalc_at: Date | null;
    }>(
      `SELECT min_level, max_level, last_recalc_at FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    expect(Number(stockRows[0]!.min_level)).toBe(5);
    expect(Number(stockRows[0]!.max_level)).toBe(20);
    expect(stockRows[0]!.last_recalc_at).not.toBeNull();

    // info-severity warning recorded.
    const { rows: warnings } = await ctx.db.query<{ severity: string; source: string; message: string }>(
      `SELECT severity, source, message FROM import_warnings
        WHERE source = 'minmax.recalc'`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('info');
  });

  it('writes an audit_log row with old/new + formula inputs', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, lead_time_days, review_days, safety_factor)
       VALUES ('Store A', 'store', 2, 2, 1.3) RETURNING id`,
    );
    const storeId = Number(rows[0]!.id);
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    await seedDailySales(storeId, productId, 10, 14);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: storeId, productId, qty: 50, minLevel: 5, maxLevel: 20 });
    await ctx.db.query(
      `UPDATE stock SET minmax_mode = 'dynamic'
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );

    await runMinmaxRecalcCycle();
    const { rows: audits } = await ctx.db.query<{
      payload: { old: { min_level: number; max_level: number }; new: { min_level: number; max_level: number }; formula: Record<string, unknown> };
    }>(
      `SELECT payload FROM audit_log WHERE action = 'stock.minmax.recalc'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload.old.min_level).toBe(5);
    expect(audits[0]!.payload.old.max_level).toBe(20);
    expect(Number(audits[0]!.payload.new.min_level)).toBeCloseTo(26, 2);
    expect(audits[0]!.payload.formula).toMatchObject({
      source: 'avg_7d',
      lead_time_days: 2,
      review_days: 2,
      safety_factor: 1.3,
    });
  });

  it('filter narrows to one (location, product)', async () => {
    const { rows: l1 } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, lead_time_days, review_days, safety_factor)
       VALUES ('S1', 'store', 1, 1, 1) RETURNING id`,
    );
    const { rows: l2 } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, lead_time_days, review_days, safety_factor)
       VALUES ('S2', 'store', 1, 1, 1) RETURNING id`,
    );
    const store1 = Number(l1[0]!.id);
    const store2 = Number(l2[0]!.id);
    const product = await makeProduct(ctx.db);
    await seedDailySales(store1, product, 10, 14);
    await seedDailySales(store2, product, 10, 14);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: store1, productId: product, qty: 0, minLevel: 0, maxLevel: 0 });
    await setStock(ctx.db, { locationId: store2, productId: product, qty: 0, minLevel: 0, maxLevel: 0 });
    await ctx.db.query(`UPDATE stock SET minmax_mode = 'dynamic'`);

    const summary = await runMinmaxRecalcCycle({ locationId: store1 });
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(1);

    // store2's row should still have min=max=0.
    const { rows } = await ctx.db.query<{ min_level: string }>(
      `SELECT min_level FROM stock WHERE location_id = $1 AND product_id = $2`,
      [store2, product],
    );
    expect(Number(rows[0]!.min_level)).toBe(0);
  });

  it('doubles min/max when sales double (TZ §15 AC#3)', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, lead_time_days, review_days, safety_factor)
       VALUES ('Store B', 'store', 2, 2, 1.3) RETURNING id`,
    );
    const storeId = Number(rows[0]!.id);
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });

    // Phase A: 5 units/day for 14 days.
    await seedDailySales(storeId, productId, 5, 14);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: storeId, productId, qty: 0, minLevel: 0, maxLevel: 0 });
    await ctx.db.query(
      `UPDATE stock SET minmax_mode = 'dynamic'
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    await runMinmaxRecalcCycle();
    const { rows: phaseA } = await ctx.db.query<{ min_level: string; max_level: string }>(
      `SELECT min_level, max_level FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    const minA = Number(phaseA[0]!.min_level);
    const maxA = Number(phaseA[0]!.max_level);

    // Phase B: double the recent sales — add another 5 units/day for last 7 days.
    await seedDailySales(storeId, productId, 5, 7);
    await runSalesAggregateCycle();
    await runMinmaxRecalcCycle();
    const { rows: phaseB } = await ctx.db.query<{ min_level: string; max_level: string }>(
      `SELECT min_level, max_level FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    const minB = Number(phaseB[0]!.min_level);
    const maxB = Number(phaseB[0]!.max_level);

    // ~2× increase (slight tolerance for window edges).
    expect(minB / minA).toBeGreaterThan(1.7);
    expect(maxB / maxA).toBeGreaterThan(1.7);
  });
});
