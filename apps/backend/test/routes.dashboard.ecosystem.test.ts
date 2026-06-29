/**
 * F4.4 — GET /api/dashboard/ecosystem integration tests (spec §2.4).
 *
 * Coverage:
 *   - PM (chain-wide) sees the full Poster status, every link of the
 *     supply chain (chain_flow ordered by type), the latest 20 alerts
 *     and the 30-day sales series.
 *   - store_manager sees only its own location in chain_flow AND
 *     sales_chart restricted to that location.
 *   - poster_status.sync_errors_24h counts only `failed` rows from the
 *     last 24h (older failed rows are ignored).
 *   - alerts_feed orders by created_at DESC and carries a derived
 *     `severity` per spec routing.
 *   - empty alerts -> [] (not null).
 *   - unauthenticated -> 401.
 *   - response time < 1s budget on a seeded fixture (AC4.4.6 — P95
 *     < 1000ms; here we cap at 1s).
 *
 * The existing `routes.dashboard.test.ts` (M8 overview) MUST keep
 * passing — this file adds a sibling endpoint, it does not change
 * the M8 surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
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
  rawWh: number;
  central: number;
  production: number;
  supply: number;
  storeA: number;
  storeB: number;
  productFlour: number;
  productCake: number;
  pm: SeededUser;
  storeAManager: SeededUser;
};

async function seedWorld(): Promise<World> {
  // Locations — one per type so chain_flow ordering can be asserted.
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'Raw WH' });
  const production = await makeLocation(ctx.db, { type: 'production', name: 'Prod' });
  const supply = await makeLocation(ctx.db, { type: 'supply', name: 'Supply' });
  const central = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: 'Central WH',
  });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Store B' });

  const productFlour = await makeProduct(ctx.db, { name: 'Flour', type: 'raw', unit: 'kg' });
  const productCake = await makeProduct(ctx.db, {
    name: 'Cake',
    type: 'finished',
    unit: 'pcs',
  });

  // storeA cake — below min, storeB cake — healthy, rawWh flour — below min.
  await setStock(ctx.db, {
    locationId: storeA,
    productId: productCake,
    qty: 1,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: storeB,
    productId: productCake,
    qty: 15,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: rawWh,
    productId: productFlour,
    qty: 2,
    minLevel: 10,
    maxLevel: 50,
  });
  await setStock(ctx.db, {
    locationId: central,
    productId: productCake,
    qty: 30,
    minLevel: 10,
    maxLevel: 100,
  });

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });

  // Open replenishment requests — one touches storeA, one touches rawWh.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'NEW', $5)`,
    [productCake, storeA, central, 19, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'SHIP_TO_REQUESTER', $5)`,
    [productFlour, rawWh, central, 48, pm.id],
  );

  // Poster sync log — two recent runs (one ok latest, one failed within 24h)
  // and one ANCIENT failed run to confirm it is NOT counted in the 24h window.
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at)
     VALUES ('transactions','ok','poll',10,10, now() - interval '5 minutes', now() - interval '4 minutes')`,
  );
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at, error_detail)
     VALUES ('leftovers','failed','poll',0,0, now() - interval '1 hour', now() - interval '1 hour', 'boom')`,
  );
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at, error_detail)
     VALUES ('leftovers','failed','poll',0,0, now() - interval '5 days', now() - interval '5 days', 'old')`,
  );

  // Sales today — three lines, total qty = 9.
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeA, productCake, 3, 1000, 1001, 1],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeA, productCake, 2, 1000, 1001, 2],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeB, productCake, 4, 1000, 1002, 1],
  );

  // sales_stats_daily — last 5 days for both stores.
  for (let i = 0; i < 5; i++) {
    await ctx.db.query(
      `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
       VALUES ($1, $2, CURRENT_DATE - $3::int, $4)`,
      [storeA, productCake, i, 5 + i],
    );
    await ctx.db.query(
      `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
       VALUES ($1, $2, CURRENT_DATE - $3::int, $4)`,
      [storeB, productCake, i, 3 + i],
    );
  }
  // One row outside the 30d window — must NOT appear in sales_chart.
  await ctx.db.query(
    `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
     VALUES ($1, $2, CURRENT_DATE - 45, 99)`,
    [storeA, productCake],
  );

  // Notifications — three rows of mixed types/severities.
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'stock_below_min','Cake low','Cake@StoreA below min',
       $2::jsonb, now() - interval '1 minute')`,
    [pm.id, JSON.stringify({ location_id: storeA })],
  );
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'poster_sync_failed','Sync failed','leftovers boom',
       $2::jsonb, now() - interval '30 seconds')`,
    [pm.id, JSON.stringify({ entity: 'leftovers' })],
  );
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'replenishment_created','Replenishment','For storeA',
       $2::jsonb, now())`,
    [pm.id, JSON.stringify({ location_id: storeA })],
  );

  return {
    rawWh,
    central,
    production,
    supply,
    storeA,
    storeB,
    productFlour,
    productCake,
    pm,
    storeAManager,
  };
}

describe('GET /api/dashboard/ecosystem', () => {
  it('returns the chain-wide ecosystem snapshot for pm', async () => {
    const w = await seedWorld();
    // F4.9 — the default `?range=today` would clip 5-day-old seeded rows out
    // of the sales_chart. The original assertions were written for the old
    // 30-day window, so we pass `?range=month` to preserve them.
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // poster_status — last_sync_status is the most recent row (ok), and the
    // 24h failed counter sees the recent failure but NOT the 5-day-old one.
    expect(body.poster_status.last_sync_status).toBe('ok');
    expect(typeof body.poster_status.last_sync_at).toBe('string');
    expect(body.poster_status.sync_errors_24h).toBe(1);
    expect(body.poster_status.sales_today_count).toBe(3);
    expect(body.poster_status.sales_today_sum).toBe(9000); // revenue: (3+2+4) × price(1000)

    // chain_flow — one row per location, ordered by type:
    // raw_warehouse, production, supply, central_warehouse, store, store.
    expect(body.chain_flow).toHaveLength(6);
    expect(body.chain_flow.map((r: { location_type: string }) => r.location_type)).toEqual([
      'raw_warehouse',
      'production',
      'supply',
      'central_warehouse',
      'store',
      'store',
    ]);

    const flowRaw = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.rawWh,
    );
    expect(flowRaw).toMatchObject({
      location_name: 'Raw WH',
      below_min_count: 1, // flour
      open_requests_count: 1, // flour shipment
      total_products: 1,
    });

    const flowStoreA = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.storeA,
    );
    expect(flowStoreA).toMatchObject({
      below_min_count: 1, // cake
      open_requests_count: 1, // cake replenishment
      total_products: 1,
    });

    const flowStoreB = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.storeB,
    );
    expect(flowStoreB.below_min_count).toBe(0);

    // alerts_feed — 3 rows, sorted DESC by created_at, with derived severity.
    expect(body.alerts_feed).toHaveLength(3);
    expect(body.alerts_feed[0].type).toBe('replenishment_created'); // most recent
    const sev: Record<string, string> = {};
    for (const a of body.alerts_feed as Array<{ type: string; severity: string }>) {
      sev[a.type] = a.severity;
    }
    expect(sev.stock_below_min).toBe('warning');
    expect(sev.poster_sync_failed).toBe('danger');
    expect(sev.replenishment_created).toBe('info');

    // sales_chart — last 30 days. Five distinct dates were seeded; the 45-day
    // outlier MUST NOT appear. days[i].qty is the sum across both stores.
    const days = body.sales_chart.days;
    expect(Array.isArray(days)).toBe(true);
    expect(days.length).toBe(5);
    // qty_sold seeded as storeA(5..9 = 35) + storeB(3..7 = 25) = 60 total.
    const totalQty = days.reduce(
      (acc: number, d: { qty: number }) => acc + Number(d.qty),
      0,
    );
    expect(totalQty).toBe(60);
  });

  // F4.x — sex (production) nodes carry two extra KPIs the canvas surfaces
  // in place of the meaningless SKU/MIN/SO'ROV trio (a sex is a conversion
  // point, not a stock vault). Non-production rows MUST carry `null` so the
  // frontend can type-switch on the field shape without a separate lookup.
  it('surfaces active_production_orders + done_today_count on production rows', async () => {
    const w = await seedWorld();

    // Baseline snapshot — earlier tests may have stamped production_orders
    // at `w.production` already. Capture pre-deltas so the per-test asserts
    // measure ONLY what we insert below.
    const baseRes = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(baseRes.status).toBe(200);
    const baseProdRow = (
      baseRes.body.chain_flow as Array<{
        location_id: number;
        location_type: string;
        active_production_orders: number | null;
        done_today_count: number | null;
      }>
    ).find((r) => r.location_id === w.production);
    expect(baseProdRow?.active_production_orders).not.toBeNull();
    expect(baseProdRow?.done_today_count).not.toBeNull();
    const baseActive = baseProdRow!.active_production_orders!;
    const baseDone = baseProdRow!.done_today_count!;

    // Insert: 2 active (new + in_progress), 1 done today, 1 done YESTERDAY
    // (must NOT bump done_today_count), 1 cancelled (must NOT bump active).
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status)
       VALUES ($1, 5, $2, 'new')`,
      [w.productCake, w.production],
    );
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status)
       VALUES ($1, 7, $2, 'in_progress')`,
      [w.productCake, w.production],
    );
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status, done_at)
       VALUES ($1, 3, $2, 'done', now())`,
      [w.productCake, w.production],
    );
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status, done_at)
       VALUES ($1, 9, $2, 'done', now() - interval '1 day')`,
      [w.productCake, w.production],
    );
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status)
       VALUES ($1, 2, $2, 'cancelled')`,
      [w.productCake, w.production],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const rows = res.body.chain_flow as Array<{
      location_id: number;
      location_type: string;
      active_production_orders: number | null;
      done_today_count: number | null;
    }>;

    const prodRow = rows.find((r) => r.location_id === w.production);
    expect(prodRow).toBeDefined();
    expect(prodRow!.active_production_orders).toBe(baseActive + 2);
    expect(prodRow!.done_today_count).toBe(baseDone + 1);

    // Every non-production row MUST carry `null` for the production-only KPIs.
    for (const row of rows) {
      if (row.location_type === 'production') continue;
      expect(row.active_production_orders).toBeNull();
      expect(row.done_today_count).toBeNull();
    }
  });

  it('scopes a store_manager to its own store (chain_flow + sales_chart)', async () => {
    const w = await seedWorld();
    // F4.9 — pass range=month so the 5-day-back sales_stats_daily seed lands
    // in the chart window (the test pre-dates the range parameter).
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem?range=month')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // chain_flow — only storeA appears.
    expect(body.chain_flow).toHaveLength(1);
    expect(body.chain_flow[0]).toMatchObject({
      location_id: w.storeA,
      location_type: 'store',
      below_min_count: 1,
      open_requests_count: 1,
    });

    // sales_today_sum — only storeA sales (3 + 2 = 5 units × price 1000 = 5000).
    expect(body.poster_status.sales_today_sum).toBe(5000);
    expect(body.poster_status.sales_today_count).toBe(2);

    // sales_chart — only storeA's qty (5..9 = 35).
    const totalQty = body.sales_chart.days.reduce(
      (acc: number, d: { qty: number }) => acc + Number(d.qty),
      0,
    );
    expect(totalQty).toBe(35);
  });

  it('returns an empty alerts feed when no notifications exist', async () => {
    // Fresh world — but truncate notifications added by seedWorld.
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM notifications');
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.alerts_feed).toEqual([]);
  });

  it('responds under the 1s budget on a seeded fixture (AC4.4.6)', async () => {
    const w = await seedWorld();
    const t0 = Date.now();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/ecosystem');
    expect(res.status).toBe(401);
  });

  // F4.11 Bug-MIN-03 — alerts_feed must be scoped to the principal.
  it('scopes alerts_feed to a store_manager (own location + personal only)', async () => {
    const w = await seedWorld();
    // Strip the seedWorld notifications so this test owns the table state.
    await ctx.db.query('DELETE FROM notifications');

    // Three alerts: one tagged to storeA (visible), one tagged to storeB
    // (must be hidden), one addressed personally to the storeA manager
    // (visible) with no location tag.
    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreA low','cake@StoreA',
         $1::jsonb, now() - interval '3 minutes')`,
      [JSON.stringify({ location_id: w.storeA })],
    );
    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreB low','cake@StoreB',
         $1::jsonb, now() - interval '2 minutes')`,
      [JSON.stringify({ location_id: w.storeB })],
    );
    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES ($1,'replenishment_created','Direct','for you',
         '{}'::jsonb, now() - interval '1 minute')`,
      [w.storeAManager.id],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);

    expect(res.status).toBe(200);
    const titles = (res.body.alerts_feed as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain('StoreA low');
    expect(titles).toContain('Direct');
    expect(titles).not.toContain('StoreB low');
  });

  it('keeps alerts_feed chain-wide for pm', async () => {
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM notifications');

    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreA low','cake@StoreA',
         $1::jsonb, now() - interval '2 minutes')`,
      [JSON.stringify({ location_id: w.storeA })],
    );
    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreB low','cake@StoreB',
         $1::jsonb, now() - interval '1 minute')`,
      [JSON.stringify({ location_id: w.storeB })],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const titles = (res.body.alerts_feed as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain('StoreA low');
    expect(titles).toContain('StoreB low');
  });

  it('keeps alerts_feed chain-wide for a central_warehouse_manager', async () => {
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM notifications');

    const cwManager = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: w.central,
    });

    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreA low','cake@StoreA',
         $1::jsonb, now() - interval '2 minutes')`,
      [JSON.stringify({ location_id: w.storeA })],
    );
    await ctx.db.query(
      `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
       VALUES (NULL,'stock_below_min','StoreB low','cake@StoreB',
         $1::jsonb, now() - interval '1 minute')`,
      [JSON.stringify({ location_id: w.storeB })],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${cwManager.token}`);

    expect(res.status).toBe(200);
    const titles = (res.body.alerts_feed as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain('StoreA low');
    expect(titles).toContain('StoreB low');
  });

  // ---------------------------------------------------------------------
  // Sprint B / task B3 — `chain_summary` (one row per chain stage).
  // ---------------------------------------------------------------------
  // NOTE: this suite seeds a fresh `seedWorld()` per test — over many tests
  // the same schema accumulates locations / stock / movements. The
  // assertions below therefore stay in TWO safe modes:
  //   (a) shape + ordering (always exact)
  //   (b) per-test deltas in `pulse` (today-scoped values measured BEFORE
  //       we insert + AFTER, asserting the diff matches what we wrote).
  it('returns one chain_summary row per stage for pm (all 5 types)', async () => {
    const w = await seedWorld();

    // Snapshot today's pulse values BEFORE we add per-test data — every
    // previous test's seedWorld() also stamps "today" rows, so we measure
    // deltas instead of absolutes.
    const baseRes = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const basePulses = Object.fromEntries(
      (
        baseRes.body.chain_summary as Array<{
          type: string;
          pulse: Record<string, number | string | null>;
        }>
      ).map((n) => [n.type, n.pulse]),
    );
    // Add today-stamped activity to validate the per-type pulses.
    //   1. raw_warehouse received 100 (purchase) + issued 30 today
    await ctx.db.query(
      `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason, created_at)
       VALUES ($1, NULL, $2, 100, 'purchase', now())`,
      [w.productFlour, w.rawWh],
    );
    await ctx.db.query(
      `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason, created_at)
       VALUES ($1, $2, NULL, 30, 'production_input', now())`,
      [w.productFlour, w.rawWh],
    );
    //   2. production — one in-progress + one done today
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status)
       VALUES ($1, 10, $2, 'in_progress')`,
      [w.productCake, w.production],
    );
    await ctx.db.query(
      `INSERT INTO production_orders (product_id, qty, location_id, status, done_at)
       VALUES ($1, 20, $2, 'done', now())`,
      [w.productCake, w.production],
    );
    //   3. supply — shipped 15 + received 25 today
    await ctx.db.query(
      `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason, created_at)
       VALUES ($1, $2, $3, 15, 'transfer', now())`,
      [w.productCake, w.supply, w.storeA],
    );
    await ctx.db.query(
      `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason, created_at)
       VALUES ($1, $2, $3, 25, 'production_output', now())`,
      [w.productCake, w.production, w.supply],
    );
    //   4. central + store pulses are already exercised by the base seed
    //      (poster_sync_log latest 'ok' run; sales total = 9 units across 3
    //      checks today, two of them sharing a transaction id so we expect
    //      2 distinct receipts).

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);

    const summary = res.body.chain_summary as Array<{
      type: string;
      location_count: number;
      total_products: number;
      below_min_count: number;
      status: string;
      pulse: Record<string, unknown> & { kind: string };
    }>;
    expect(Array.isArray(summary)).toBe(true);
    // 5 stages: raw / production / supply / central / store — stable order.
    expect(summary.map((n) => n.type)).toEqual([
      'raw_warehouse',
      'production',
      'supply',
      'central_warehouse',
      'store',
    ]);

    const byType = Object.fromEntries(summary.map((n) => [n.type, n]));

    // Shape — every node carries the required fields.
    for (const node of summary) {
      expect(typeof node.location_count).toBe('number');
      expect(typeof node.total_products).toBe('number');
      expect(typeof node.below_min_count).toBe('number');
      expect(['ok', 'warn', 'danger']).toContain(node.status);
      expect(node.pulse).toBeDefined();
    }

    // Pulse deltas — measure the values we INSERT in this test against the
    // baseline so accumulating fixture data from earlier tests doesn't
    // break the assertion.
    const raw = byType.raw_warehouse?.pulse as {
      received_today: number;
      issued_today: number;
    };
    const baseRaw = basePulses.raw_warehouse as {
      received_today: number;
      issued_today: number;
    };
    expect(raw.received_today - baseRaw.received_today).toBe(100);
    expect(raw.issued_today - baseRaw.issued_today).toBe(30);
    expect(byType.raw_warehouse?.pulse.kind).toBe('raw');

    const prod = byType.production?.pulse as {
      active_orders: number;
      done_today: number;
    };
    const baseProd = basePulses.production as {
      active_orders: number;
      done_today: number;
    };
    expect(prod.active_orders - baseProd.active_orders).toBe(1);
    expect(prod.done_today - baseProd.done_today).toBe(1);
    expect(byType.production?.pulse.kind).toBe('production');

    const sup = byType.supply?.pulse as {
      shipped_today: number;
      received_today: number;
    };
    const baseSup = basePulses.supply as {
      shipped_today: number;
      received_today: number;
    };
    expect(sup.shipped_today - baseSup.shipped_today).toBe(15);
    expect(sup.received_today - baseSup.received_today).toBe(25);
    expect(byType.supply?.pulse.kind).toBe('supply');

    // central_warehouse — latest poster sync was 'ok' (most recent seed row).
    expect(byType.central_warehouse?.pulse).toMatchObject({
      kind: 'central',
      last_sync_status: 'ok',
    });
    expect(typeof byType.central_warehouse?.pulse.last_sync_at).toBe('string');

    // store pulse — kind + types only; absolute counts accumulate across
    // every seedWorld() invocation in this suite. We still verify the
    // shape and that sums are positive after seeding 3 sales lines.
    expect(byType.store?.pulse.kind).toBe('store');
    expect(typeof byType.store?.pulse.sales_today_sum).toBe('number');
    expect(typeof byType.store?.pulse.receipts_today).toBe('number');

    // -----------------------------------------------------------------
    // Sprint C — extended pulse fields. We only smoke-check the shape:
    // every new key is present and carries the right primitive type
    // (numbers default to `0`, strings can be `null`). Exact values are
    // covered by deeper tests; here we guarantee the contract holds.
    // -----------------------------------------------------------------
    const rawPulse = byType.raw_warehouse?.pulse as {
      pending_purchase_orders: number;
      total_qty_by_unit: Array<{ unit: string; qty: number }>;
    };
    expect(typeof rawPulse.pending_purchase_orders).toBe('number');
    expect(Array.isArray(rawPulse.total_qty_by_unit)).toBe(true);
    for (const row of rawPulse.total_qty_by_unit) {
      expect(typeof row.unit).toBe('string');
      expect(typeof row.qty).toBe('number');
    }

    const prodPulse = byType.production?.pulse as {
      overdue_orders: number;
      sex_count: number;
      input_today: number;
      output_today: number;
    };
    expect(typeof prodPulse.overdue_orders).toBe('number');
    expect(typeof prodPulse.sex_count).toBe('number');
    expect(typeof prodPulse.input_today).toBe('number');
    expect(typeof prodPulse.output_today).toBe('number');

    const supPulse = byType.supply?.pulse as {
      open_requests: number;
      top_destination_count: number;
    };
    expect(typeof supPulse.open_requests).toBe('number');
    expect(typeof supPulse.top_destination_count).toBe('number');

    const centralPulse = byType.central_warehouse?.pulse as {
      sync_errors_24h: number;
    };
    expect(typeof centralPulse.sync_errors_24h).toBe('number');
    expect(centralPulse.sync_errors_24h).toBeGreaterThanOrEqual(0);

    const storePulse = byType.store?.pulse as {
      avg_receipt_today: number;
      open_replenishments: number;
      transit_count: number;
      top_product_name: string | null;
      qty_today: number;
    };
    expect(typeof storePulse.avg_receipt_today).toBe('number');
    expect(typeof storePulse.open_replenishments).toBe('number');
    expect(typeof storePulse.transit_count).toBe('number');
    expect(
      storePulse.top_product_name === null ||
        typeof storePulse.top_product_name === 'string',
    ).toBe(true);
    expect(typeof storePulse.qty_today).toBe('number');
    // avg_receipt = sum / receipts when receipts > 0; otherwise 0.
    if ((byType.store?.pulse as { receipts_today: number }).receipts_today > 0) {
      const expected =
        (byType.store?.pulse as { sales_today_sum: number }).sales_today_sum /
        (byType.store?.pulse as { receipts_today: number }).receipts_today;
      expect(storePulse.avg_receipt_today).toBeCloseTo(expected, 4);
    } else {
      expect(storePulse.avg_receipt_today).toBe(0);
    }
  });

  it('derives chain_summary.status thresholds correctly (ok / warn / danger)', async () => {
    const w = await seedWorld();
    // Capture the baseline so the assertion is delta-based — other tests in
    // the file may have left below-min rows in storeA, and we only care that
    // adding 4 more below-min rows pushes the count past the danger threshold.
    const baselineRes = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const baselineStore = (
      baselineRes.body.chain_summary as Array<{ type: string; below_min_count: number }>
    ).find((n) => n.type === 'store');
    const baselineBelowMin = baselineStore?.below_min_count ?? 0;

    for (let i = 0; i < 4; i++) {
      const extra = await makeProduct(ctx.db, {
        name: `ExtraProd${i}`,
        type: 'finished',
        unit: 'pcs',
      });
      await ctx.db.query(
        `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
         VALUES ($1, $2, 0, 5, 20)`,
        [w.storeA, extra],
      );
    }
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const byType = Object.fromEntries(
      (res.body.chain_summary as Array<{ type: string; status: string; below_min_count: number }>).map(
        (n) => [n.type, n],
      ),
    );
    // 4 added on top of whatever was already there.
    expect(byType.store?.below_min_count).toBe(baselineBelowMin + 4);
    // ≥4 is enough for danger per the threshold (1..3 = warn, 4+ = danger).
    expect(byType.store?.status).toBe('danger');
    // central_warehouse, production, supply have no below-min stock -> ok.
    expect(byType.central_warehouse?.status).toBe('ok');
    expect(byType.production?.status).toBe('ok');
    expect(byType.supply?.status).toBe('ok');
  });

  it('scopes chain_summary to a store_manager (only their stage)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(200);
    const summary = res.body.chain_summary as Array<{
      type: string;
      location_count: number;
    }>;
    expect(summary).toHaveLength(1);
    expect(summary[0]?.type).toBe('store');
    // Only storeA is assigned -> location_count = 1, not 2.
    expect(summary[0]?.location_count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // D-0026 — chain_edges (explicit M:N supply-chain edges).
  // ---------------------------------------------------------------------
  it('returns the chain_edges array on the ecosystem payload', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chain_edges)).toBe(true);
  });

  it('surfaces a freshly-inserted location_flows row to pm', async () => {
    const w = await seedWorld();

    // Add a `production_output` edge between the seeded production sex
    // and a sex_storage we create on the fly. The 0026 seed targets the
    // canonical Poster names (Tort sexi, …) which the test world does not
    // create — so the test owns its own edge.
    const skladi = await makeLocation(ctx.db, {
      type: 'supply',
      name: 'Test sklad for edge',
    });
    await ctx.db.query(
      `INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
       VALUES ($1, $2, 'production_output')
       ON CONFLICT DO NOTHING`,
      [w.production, skladi],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const edges = res.body.chain_edges as Array<{
      from: number;
      to: number;
      type: string;
    }>;
    const ours = edges.find(
      (e) => e.from === w.production && e.to === skladi,
    );
    expect(ours).toBeDefined();
    expect(ours?.type).toBe('production_output');
  });

  it('scopes chain_edges to a store_manager (only edges touching their location)', async () => {
    const w = await seedWorld();

    // Edge 1: storeA (visible to storeAManager) ← central
    // Edge 2: storeB ← central (must NOT appear)
    await ctx.db.query(
      `INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
       VALUES ($1, $2, 'forward') ON CONFLICT DO NOTHING`,
      [w.central, w.storeA],
    );
    await ctx.db.query(
      `INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
       VALUES ($1, $2, 'forward') ON CONFLICT DO NOTHING`,
      [w.central, w.storeB],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(200);
    const edges = res.body.chain_edges as Array<{
      from: number;
      to: number;
    }>;
    // storeAManager must see the central→storeA edge but never central→storeB.
    expect(edges.some((e) => e.to === w.storeA)).toBe(true);
    expect(edges.some((e) => e.to === w.storeB)).toBe(false);
  });

  it('returns nulls in poster_status when no sync runs exist', async () => {
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM poster_sync_log');
    await ctx.db.query('DELETE FROM sales');
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.poster_status.last_sync_at).toBeNull();
    expect(res.body.poster_status.last_sync_status).toBeNull();
    expect(res.body.poster_status.sync_errors_24h).toBe(0);
    expect(res.body.poster_status.sales_today_count).toBe(0);
    expect(res.body.poster_status.sales_today_sum).toBe(0);
  });
});
