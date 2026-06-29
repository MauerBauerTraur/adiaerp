/**
 * Sales aggregate cron — integration test (Phase-2 F2.1).
 *
 * Exercises `runSalesAggregateCycle()` against a per-suite isolated schema:
 *   - `sales` rows in the last 31 days are upserted into `sales_stats_daily`
 *     with qty_sold = SUM(sales.qty);
 *   - `avg_7d` and `avg_30d` are populated from the trailing window;
 *   - re-running the cycle is idempotent (the same numbers land).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct } from './helpers/fixtures.js';
import { runSalesAggregateCycle } from '../src/workers/salesAggregateCron.js';

let ctx: TestContext;
let storeId: number;
let productId: number;

beforeAll(async () => {
  ctx = await createTestContext();
  storeId = await makeLocation(ctx.db, { type: 'store' });
  productId = await makeProduct(ctx.db, { unit: 'pcs' });
});

afterAll(async () => {
  await ctx.dispose();
});

/** Seed N sales rows on `date` with the given qty values (one row each). */
async function seedSales(
  date: Date,
  qtys: readonly number[],
): Promise<void> {
  for (let i = 0; i < qtys.length; i += 1) {
    const txId = Date.now() * 1000 + Math.floor(Math.random() * 999) + i;
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
                          poster_transaction_id, poster_line_id)
       VALUES ($1, $2, $3, 0, $4, $5, $6)`,
      [storeId, productId, qtys[i], date.toISOString(), txId, i + 1],
    );
  }
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe('runSalesAggregateCycle', () => {
  it('aggregates sales into sales_stats_daily with avg_7d and avg_30d', async () => {
    // Reset state for a clean assertion.
    await ctx.db.query('DELETE FROM sales');
    await ctx.db.query('DELETE FROM sales_stats_daily');

    // Last 7 days: 5 units/day. Days 8..14: 1 unit/day (lower).
    for (let i = 0; i < 7; i += 1) {
      await seedSales(daysAgo(i), [3, 2]); // sum = 5
    }
    for (let i = 7; i < 14; i += 1) {
      await seedSales(daysAgo(i), [1]); // sum = 1
    }

    const summary = await runSalesAggregateCycle();
    expect(summary.rowsAggregated).toBeGreaterThanOrEqual(14);

    // Latest aggregate row has avg_7d ≈ 5 and avg_30d ≈ 3 (5*7 + 1*7) / 14.
    const { rows } = await ctx.db.query<{ qty_sold: string; avg_7d: string; avg_30d: string }>(
      `SELECT qty_sold, avg_7d, avg_30d
         FROM sales_stats_daily
        WHERE location_id = $1 AND product_id = $2
        ORDER BY stat_date DESC LIMIT 1`,
      [storeId, productId],
    );
    expect(rows[0]).toBeDefined();
    expect(Number(rows[0]!.qty_sold)).toBe(5);
    expect(Number(rows[0]!.avg_7d)).toBeCloseTo(5, 2);
    expect(Number(rows[0]!.avg_30d)).toBeGreaterThan(2.5);
    expect(Number(rows[0]!.avg_30d)).toBeLessThan(3.5);
  });

  it('is idempotent — a second pass on the same data produces the same numbers', async () => {
    const { rows: before } = await ctx.db.query<{ qty_sold: string; avg_7d: string }>(
      `SELECT qty_sold, avg_7d FROM sales_stats_daily
        WHERE location_id = $1 AND product_id = $2
        ORDER BY stat_date DESC LIMIT 1`,
      [storeId, productId],
    );

    await runSalesAggregateCycle();
    await runSalesAggregateCycle();

    const { rows: after } = await ctx.db.query<{ qty_sold: string; avg_7d: string }>(
      `SELECT qty_sold, avg_7d FROM sales_stats_daily
        WHERE location_id = $1 AND product_id = $2
        ORDER BY stat_date DESC LIMIT 1`,
      [storeId, productId],
    );
    expect(after[0]!.qty_sold).toBe(before[0]!.qty_sold);
    expect(after[0]!.avg_7d).toBe(before[0]!.avg_7d);
  });

  it('writes one audit row per cycle (entity=sales_stats_daily)', async () => {
    const before = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'sales_stats.aggregate'`,
    );
    await runSalesAggregateCycle();
    const after = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'sales_stats.aggregate'`,
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
  });
});
