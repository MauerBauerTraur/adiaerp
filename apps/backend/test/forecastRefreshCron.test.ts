/**
 * Forecast refresh cron — integration test (F3.4 / ADR-0010).
 *
 * Covers the Node-side cycle: pair selection, sidecar batching, upsert,
 * skip semantics, error path. The sidecar HTTP call is stubbed via
 * `setSidecarCaller` so we never depend on a running Python container.
 *
 * Acceptance criteria mapping (TZ §14 / ADR-0010 §"Test strategiyasi"):
 *   * 30-day constant series + current_qty → forecast row written with
 *     `expected_stockout_date ≈ today + qty/avg_daily`.
 *   * < 30 days history → pair filtered out before the sidecar call.
 *   * Sidecar HTTP failure → import_warnings row, errors counter += 1,
 *     old forecasts row survives.
 *   * Idempotency: two cycles in a row produce one row per pair (upsert).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { runSalesAggregateCycle } from '../src/workers/salesAggregateCron.js';
import {
  runForecastRefreshCycle,
  setSidecarCaller,
} from '../src/workers/forecastRefreshCron.js';

let ctx: TestContext;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined): void {
  ORIGINAL_ENV[k] ??= process.env[k];
  if (v === undefined) {
    delete process.env[k];
  } else {
    process.env[k] = v;
  }
}

beforeAll(async () => {
  // Enable the feature gate so loadConfig() exposes forecaster.enabled=true.
  setEnv('FORECASTER_URL', 'http://stub-forecaster:8000');
  setEnv('FORECASTER_SHARED_SECRET', 'test-secret');
  setEnv('FORECASTER_BATCH_SIZE', '50');
  setEnv('FORECASTER_HORIZON_DAYS', '7');

  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  // Restore env values we changed.
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM import_warnings');
  await ctx.db.query('DELETE FROM forecasts');
  await ctx.db.query('DELETE FROM sales');
  await ctx.db.query('DELETE FROM sales_stats_daily');
  await ctx.db.query('DELETE FROM stock');
});

afterEach(() => {
  setSidecarCaller(null);
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

describe('runForecastRefreshCycle', () => {
  it('writes one forecast row per eligible pair', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });

    // 35 days of constant sales → > 30 day history, eligible.
    await seedDailySales(storeId, productId, 10, 35);
    await runSalesAggregateCycle();
    await setStock(ctx.db, {
      locationId: storeId,
      productId,
      qty: 50,
      minLevel: 5,
      maxLevel: 100,
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const isoToday = today.toISOString().slice(0, 10);
    const isoTomorrow = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

    const sidecarStub = vi.fn().mockResolvedValue({
      forecasts: [
        {
          location_id: storeId,
          product_id: productId,
          daily_predictions: [
            { date: isoToday, yhat: 10, yhat_lower: 8, yhat_upper: 12 },
            { date: isoTomorrow, yhat: 10, yhat_lower: 8, yhat_upper: 12 },
          ],
          expected_stockout_date: '2099-01-01',
        },
      ],
    });
    setSidecarCaller(sidecarStub);

    const summary = await runForecastRefreshCycle();
    expect(summary.scanned).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);

    expect(sidecarStub).toHaveBeenCalledTimes(1);
    const callBody = sidecarStub.mock.calls[0]![1] as { items: Array<{ current_qty: number }> };
    expect(callBody.items[0]!.current_qty).toBe(50);

    const { rows } = await ctx.db.query<{
      location_id: string;
      product_id: string;
      daily_predictions: unknown;
      expected_stockout_date: Date;
    }>(`SELECT * FROM forecasts`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.location_id)).toBe(storeId);
    expect(Number(rows[0]!.product_id)).toBe(productId);
    expect(Array.isArray(rows[0]!.daily_predictions)).toBe(true);
  });

  it('filters out pairs with under 30 days of history', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    // Only 10 days — under the MIN_HISTORY_DAYS threshold.
    await seedDailySales(storeId, productId, 5, 10);
    await runSalesAggregateCycle();

    const sidecarStub = vi.fn().mockResolvedValue({ forecasts: [] });
    setSidecarCaller(sidecarStub);

    const summary = await runForecastRefreshCycle();
    expect(summary.scanned).toBe(0);
    expect(sidecarStub).not.toHaveBeenCalled();
  });

  it('records an import_warnings row when the sidecar errors out', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    await seedDailySales(storeId, productId, 8, 35);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: storeId, productId, qty: 50 });

    setSidecarCaller(async () => {
      throw new Error('forecaster HTTP 500: stan model failed');
    });

    const summary = await runForecastRefreshCycle();
    expect(summary.scanned).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.updated).toBe(0);

    const { rows } = await ctx.db.query<{ severity: string; source: string; message: string }>(
      `SELECT severity, source, message FROM import_warnings`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('error');
    expect(rows[0]!.source).toBe('forecast.refresh');
    expect(rows[0]!.message).toContain('sidecar');
  });

  it('treats insufficient_data and failed items as skips, not writes', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p3 = await makeProduct(ctx.db, { unit: 'pcs' });
    await seedDailySales(storeId, p1, 3, 35);
    await seedDailySales(storeId, p2, 3, 35);
    await seedDailySales(storeId, p3, 3, 35);
    await runSalesAggregateCycle();
    for (const pid of [p1, p2, p3]) {
      await setStock(ctx.db, { locationId: storeId, productId: pid, qty: 10 });
    }

    const isoToday = new Date().toISOString().slice(0, 10);
    setSidecarCaller(async (_url, body) => ({
      forecasts: body.items.map((it, idx) => {
        if (idx === 0) {
          return {
            location_id: it.location_id,
            product_id: it.product_id,
            daily_predictions: [
              { date: isoToday, yhat: 3, yhat_lower: 2, yhat_upper: 4 },
            ],
            expected_stockout_date: null,
          };
        }
        if (idx === 1) {
          return {
            location_id: it.location_id,
            product_id: it.product_id,
            daily_predictions: [],
            expected_stockout_date: null,
            insufficient_data: true,
          };
        }
        return {
          location_id: it.location_id,
          product_id: it.product_id,
          daily_predictions: [],
          expected_stockout_date: null,
          failed: true,
          error: 'divergent fit',
        };
      }),
    }));

    const summary = await runForecastRefreshCycle();
    expect(summary.scanned).toBe(3);
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(2);

    const { rows } = await ctx.db.query(`SELECT * FROM forecasts`);
    expect(rows).toHaveLength(1);
  });

  it('upsert is idempotent — running twice still leaves one row per pair', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db, { unit: 'pcs' });
    await seedDailySales(storeId, productId, 4, 35);
    await runSalesAggregateCycle();
    await setStock(ctx.db, { locationId: storeId, productId, qty: 30 });

    const isoToday = new Date().toISOString().slice(0, 10);
    setSidecarCaller(async (_url, body) => ({
      forecasts: body.items.map((it) => ({
        location_id: it.location_id,
        product_id: it.product_id,
        daily_predictions: [
          { date: isoToday, yhat: 4, yhat_lower: 3, yhat_upper: 5 },
        ],
        expected_stockout_date: isoToday,
      })),
    }));

    await runForecastRefreshCycle();
    await runForecastRefreshCycle();

    const { rows } = await ctx.db.query(`SELECT * FROM forecasts`);
    expect(rows).toHaveLength(1);
  });
});
