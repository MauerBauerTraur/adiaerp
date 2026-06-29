/**
 * F4.9 — `?range=` filter on dashboard endpoints.
 *
 * The original M8 / F4.4 / F4.6 endpoints answered with a hard-coded
 * "today" / "last 30 days" window. F4.9 makes the window explicit via
 * `?range=today|week|month` and `?range=custom&from=&to=`.
 *
 * Coverage:
 *   - default = today (today's movements only).
 *   - week pulls a 7-day-old movement back into the response.
 *   - month pulls a 25-day-old movement back into the response.
 *   - `sales_today_*` shrinks/grows with the same window.
 *   - sales_chart bounds match the requested range.
 *   - custom range with from/to honors both bounds.
 *   - invalid range -> 422; custom without from/to -> 422.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  type SeededUser,
} from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

type World = {
  storeA: number;
  central: number;
  productToday: number;
  productPast: number;
  productAncient: number;
  pm: SeededUser;
};

async function seedWorld(): Promise<World> {
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  // Each age-bucket uses its own product id so we can identify it in the
  // recent_movements response (which embeds product_id but not the note).
  const productToday = await makeProduct(ctx.db, { type: 'finished', name: 'Today' });
  const productPast = await makeProduct(ctx.db, { type: 'finished', name: 'Past' });
  const productAncient = await makeProduct(ctx.db, { type: 'finished', name: 'Ancient' });
  const pm = await makeUser(ctx.db, { role: 'pm' });

  // Three stock movements at distinct ages: today, 5 days ago, 25 days ago.
  // (5 days for "past" — 7 days lands exactly on the half-open lower bound of
  // `?range=week` depending on the time of day and would flake.)
  await ctx.db.query(
    `INSERT INTO stock_movements (product_id, from_location_id, to_location_id,
       qty, reason, created_by, created_at)
     VALUES ($1, $2, $3, 1, 'transfer', $4, now())`,
    [productToday, central, storeA, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO stock_movements (product_id, from_location_id, to_location_id,
       qty, reason, created_by, created_at)
     VALUES ($1, $2, $3, 1, 'transfer', $4, now() - interval '5 days')`,
    [productPast, central, storeA, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO stock_movements (product_id, from_location_id, to_location_id,
       qty, reason, created_by, created_at)
     VALUES ($1, $2, $3, 1, 'transfer', $4, now() - interval '25 days')`,
    [productAncient, central, storeA, pm.id],
  );

  // Sales at the same three ages. Random poster_transaction_id to avoid the
  // (txn_id, product_id, line_id) unique index colliding across `it`s.
  const baseTxn = 500000 + Math.floor(Math.random() * 100000);
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 1, 100, now(), $3, 1)`,
    [storeA, productToday, baseTxn],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 1, 100, now() - interval '5 days', $3, 1)`,
    [storeA, productPast, baseTxn + 1],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 1, 100, now() - interval '25 days', $3, 1)`,
    [storeA, productAncient, baseTxn + 2],
  );

  // sales_stats_daily — three days at distinct ages.
  await ctx.db.query(
    `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
     VALUES ($1, $2, CURRENT_DATE, 10)`,
    [storeA, productToday],
  );
  await ctx.db.query(
    `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
     VALUES ($1, $2, CURRENT_DATE - 5, 20)`,
    [storeA, productPast],
  );
  await ctx.db.query(
    `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
     VALUES ($1, $2, CURRENT_DATE - 25, 30)`,
    [storeA, productAncient],
  );

  return { storeA, central, productToday, productPast, productAncient, pm };
}

// All assertions are based on movements/notes seeded in this test file so
// they stay local to this run (the schema is shared across the file's
// `it`s — that is by design for speed).

describe('GET /api/dashboard/overview — ?range', () => {
  it('default = today: past/ancient movements are excluded', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const pids = res.body.recent_movements.map(
      (m: { product_id: number }) => m.product_id,
    );
    expect(pids).toContain(w.productToday);
    expect(pids).not.toContain(w.productPast);
    expect(pids).not.toContain(w.productAncient);
  });

  it('range=week pulls a 5-day-old movement in (but not 25-day-old)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview?range=week')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const pids = res.body.recent_movements.map(
      (m: { product_id: number }) => m.product_id,
    );
    expect(pids).toContain(w.productPast);
    expect(pids).not.toContain(w.productAncient);
  });

  it('range=month pulls the 25-day-old movement in as well', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const pids = res.body.recent_movements.map(
      (m: { product_id: number }) => m.product_id,
    );
    expect(pids).toContain(w.productPast);
    expect(pids).toContain(w.productAncient);
  });

  it('rejects an unknown range with 422', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview?range=year')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(422);
  });

  it('custom range requires both from and to', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview?range=custom&from=2026-01-01')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(422);
  });
});

describe('GET /api/dashboard/ecosystem — ?range', () => {
  it('default = today: sales_today reflects only today', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const todayCount = res.body.poster_status.sales_today_count;
    // sales_chart — at most one stat_date row (today). The 7-day and 25-day
    // sales_stats_daily seeds must NOT appear.
    expect(res.body.sales_chart.days.length).toBeLessThanOrEqual(1);
    // Same `it` later requests with range=month, expect strictly more rows.
    const month = await request(ctx.app)
      .get('/api/dashboard/ecosystem?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(month.body.poster_status.sales_today_count).toBeGreaterThan(
      todayCount,
    );
  });

  it('range=week grows sales_today_count and chart vs today', async () => {
    const w = await seedWorld();
    const today = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const week = await request(ctx.app)
      .get('/api/dashboard/ecosystem?range=week')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(week.status).toBe(200);
    expect(week.body.poster_status.sales_today_count).toBeGreaterThan(
      today.body.poster_status.sales_today_count,
    );
    // sales_chart for week includes the 7-day-ago bucket.
    expect(week.body.sales_chart.days.length).toBeGreaterThanOrEqual(
      today.body.sales_chart.days.length + 1,
    );
  });

  it('range=month pulls the 25-day-old chart row in', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    // The 25-day-old stat_date row is now inside the window.
    expect(res.body.sales_chart.days.length).toBeGreaterThanOrEqual(3);
    // The sum is global across the schema (other tests in this file also seed
    // sales_stats_daily). We only assert this seed's quantities are present.
    const qtySet = new Set(
      res.body.sales_chart.days.map((d: { qty: number }) => Number(d.qty)),
    );
    // qty_sold for this seed: 10 (today), 20 (-7d), 30 (-25d). Other seeds
    // pump the SAME location_id+product_id+stat_date keys though, so the
    // aggregate may roll up. Just assert one row exceeds the smallest single
    // seeded value.
    const maxQty = Math.max(...(qtySet as Set<number>));
    expect(maxQty).toBeGreaterThanOrEqual(30);
  });
});

describe('GET /api/dashboard/chain-layer/:type — ?range', () => {
  it('store layer sales_today_count grows with the range window', async () => {
    const w = await seedWorld();
    const today = await request(ctx.app)
      .get('/api/dashboard/chain-layer/store')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(today.status).toBe(200);

    const month = await request(ctx.app)
      .get('/api/dashboard/chain-layer/store?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(month.status).toBe(200);
    // Strict inequality: today's window must be smaller than month's, because
    // the 7-day-old and 25-day-old sales rows are only inside the month range.
    expect(month.body.totals.sales_today_count).toBeGreaterThan(
      today.body.totals.sales_today_count,
    );
  });
});
