/**
 * Dashboard MEGA Redesign Sprint C (task C3) — integration tests for the 5
 * per-stage detail endpoints consumed by `ChainDetailSheet`:
 *
 *   GET /api/dashboard/raw          — Mahsulot Ombori
 *   GET /api/dashboard/production   — Ishlab Chiqarish
 *   GET /api/dashboard/supply       — Ta'minot bo'limi
 *   GET /api/dashboard/central      — Markaziy Sklad
 *   GET /api/dashboard/stores       — Do'konlar
 *
 * Coverage per endpoint (1–2 smoke tests as per task scope):
 *   - PM (chain-wide) — 200, KPIs reflect seeded data.
 *   - Matching layer manager (location-scoped) — 200, scope intersects own
 *     location only.
 *   - Wrong-layer scoped role — 403.
 *   - Unauthenticated — 401.
 *
 * The fixtures are tiny and local; they do not interfere with other suites.
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
  production: number;
  supply: number;
  central: number;
  storeA: number;
  storeB: number;
  flour: number;
  cake: number;
  pm: SeededUser;
  rawManager: SeededUser;
  prodManager: SeededUser;
  supplyManager: SeededUser;
  centralManager: SeededUser;
  storeAManager: SeededUser;
};

async function seedWorld(): Promise<World> {
  // Reset the cross-cutting tables so every `it` in this suite starts from a
  // clean slate. Schema isolation handles other suites; CASCADE drops child
  // rows (movements, replenishments, POs, sales, notifications) in one go.
  await ctx.db.query('TRUNCATE TABLE stock_movements CASCADE');
  await ctx.db.query('TRUNCATE TABLE replenishment_requests CASCADE');
  await ctx.db.query('TRUNCATE TABLE production_orders CASCADE');
  await ctx.db.query('TRUNCATE TABLE purchase_orders CASCADE');
  await ctx.db.query('TRUNCATE TABLE sales CASCADE');
  await ctx.db.query('TRUNCATE TABLE sales_stats_daily CASCADE');
  await ctx.db.query('TRUNCATE TABLE poster_sync_log CASCADE');
  await ctx.db.query('TRUNCATE TABLE notifications CASCADE');
  await ctx.db.query('TRUNCATE TABLE stock CASCADE');
  // Locations + users + products are referenced by audit_log and similar —
  // RESTART IDENTITY ensures stable ids if any test asserts on them.
  await ctx.db.query('TRUNCATE TABLE user_locations CASCADE');
  await ctx.db.query('TRUNCATE TABLE users CASCADE');
  await ctx.db.query('TRUNCATE TABLE locations CASCADE');
  await ctx.db.query('TRUNCATE TABLE products CASCADE');

  // Locations — one per stage (+ two stores so scoping is observable).
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'RawWH' });
  const production = await makeLocation(ctx.db, { type: 'production', name: 'Sex1' });
  const supply = await makeLocation(ctx.db, { type: 'supply', name: 'Supply' });
  const central = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: 'Central',
  });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'StoreA' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'StoreB' });

  const flour = await makeProduct(ctx.db, { name: 'Flour', type: 'raw', unit: 'kg' });
  const cake = await makeProduct(ctx.db, { name: 'Cake', type: 'finished', unit: 'pcs' });

  // Stock — rawWh flour below min, central holds cake, storeA cake below min.
  await setStock(ctx.db, {
    locationId: rawWh,
    productId: flour,
    qty: 2,
    minLevel: 10,
    maxLevel: 100,
  });
  await setStock(ctx.db, {
    locationId: central,
    productId: cake,
    qty: 50,
    minLevel: 10,
    maxLevel: 100,
  });
  await setStock(ctx.db, {
    locationId: storeA,
    productId: cake,
    qty: 1,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: storeB,
    productId: cake,
    qty: 15,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: supply,
    productId: cake,
    qty: 20,
    minLevel: 0,
    maxLevel: 0,
  });

  // Users — one per role plus PM. Each call passes a unique username to
  // dodge the fixture's role-name truncation collision (the default username
  // derivation truncates to 24 chars, which strips the random suffix for
  // long role names like `central_warehouse_manager`).
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const pm = await makeUser(ctx.db, { role: 'pm', username: `pm_${uniq()}` });
  const rawManager = await makeUser(ctx.db, {
    role: 'raw_warehouse_manager',
    locationId: rawWh,
    username: `raw_${uniq()}`,
  });
  const prodManager = await makeUser(ctx.db, {
    role: 'production_manager',
    locationId: production,
    username: `prod_${uniq()}`,
  });
  const supplyManager = await makeUser(ctx.db, {
    role: 'supply_manager',
    locationId: supply,
    username: `sup_${uniq()}`,
  });
  const centralManager = await makeUser(ctx.db, {
    role: 'central_warehouse_manager',
    locationId: central,
    username: `cen_${uniq()}`,
  });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
    username: `sto_${uniq()}`,
  });

  // One approved-but-unreceived PO targeting rawWh (a "pending" PO).
  await ctx.db.query(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status,
        manager_approved_by, manager_approved_at,
        keeper_approved_by, keeper_approved_at)
     VALUES ($1, $2, $3, 'approved', $4, now(), $5, now())`,
    [flour, 25, rawWh, pm.id, pm.id],
  );

  // Production order — active on the production location.
  await ctx.db.query(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status, created_by)
     VALUES ($1, $2, $3, $4, 'in_progress', $5)`,
    [cake, 30, production, central, pm.id],
  );

  // Replenishment requests — storeA awaits cake, supply targets central wh.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'NEW', $5)`,
    [cake, storeA, supply, 19, pm.id],
  );

  // Sales today — storeA + storeB.
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 3, 1000, now(), 9001, 1)`,
    [storeA, cake],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 2, 1500, now(), 9002, 1)`,
    [storeB, cake],
  );

  // Stock movements today — production_input (raw -> production),
  // production_output (production -> central), transfer (supply -> storeA),
  // and purchase (-> rawWh).
  await ctx.db.query(
    `INSERT INTO stock_movements
       (product_id, from_location_id, to_location_id, qty, reason, created_by)
     VALUES ($1, $2, $3, 5, 'production_input', $4)`,
    [flour, rawWh, production, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO stock_movements
       (product_id, from_location_id, to_location_id, qty, reason, created_by)
     VALUES ($1, $2, $3, 10, 'production_output', $4)`,
    [cake, production, supply, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO stock_movements
       (product_id, from_location_id, to_location_id, qty, reason, created_by)
     VALUES ($1, $2, $3, 4, 'transfer', $4)`,
    [cake, supply, storeA, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO stock_movements
       (product_id, from_location_id, to_location_id, qty, reason, created_by)
     VALUES ($1, NULL, $2, 25, 'purchase', $3)`,
    [flour, rawWh, pm.id],
  );

  // Poster sync log — one ok + one failed in the last hour, plus an old failed.
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at)
     VALUES ('leftovers','ok','poll',5,5,
             now() - interval '5 minutes', now() - interval '4 minutes')`,
  );
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at, error_detail)
     VALUES ('transactions','failed','poll',0,0,
             now() - interval '1 hour', now() - interval '1 hour','boom')`,
  );

  return {
    rawWh,
    production,
    supply,
    central,
    storeA,
    storeB,
    flour,
    cake,
    pm,
    rawManager,
    prodManager,
    supplyManager,
    centralManager,
    storeAManager,
  };
}

// ===========================================================================
// /api/dashboard/raw
// ===========================================================================

describe('GET /api/dashboard/raw', () => {
  it('returns the chain-wide raw warehouse detail for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/raw?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.kpis.raw_product_types).toBe(1); // flour
    expect(body.kpis.below_min_count).toBe(1);
    expect(body.kpis.open_purchase_orders).toBe(1);
    expect(Array.isArray(body.kpis.total_stock_by_unit)).toBe(true);
    expect(body.below_min_items).toHaveLength(1);
    expect(body.below_min_items[0]).toMatchObject({
      product_id: w.flour,
      unit: 'kg',
      qty: 2,
      min_level: 10,
      location_id: w.rawWh,
    });
    expect(body.pending_purchase_orders).toHaveLength(1);
    expect(body.pending_purchase_orders[0]).toMatchObject({
      product_id: w.flour,
      qty: 25,
    });
    expect(Array.isArray(body.daily_movements)).toBe(true);
  });

  it('scopes a raw_warehouse_manager to its own warehouse', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/raw')
      .set('Authorization', `Bearer ${w.rawManager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.below_min_items[0].location_id).toBe(w.rawWh);
  });

  it('rejects a non-raw scoped role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/raw')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/raw');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// /api/dashboard/production
// ===========================================================================

describe('GET /api/dashboard/production', () => {
  it('returns the production detail for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/production?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.kpis.active_orders).toBeGreaterThanOrEqual(1);
    expect(body.kpis.sex_count).toBe(1);
    expect(body.active_orders.length).toBeGreaterThanOrEqual(1);
    expect(body.active_orders[0]).toMatchObject({
      product_id: w.cake,
      location_id: w.production,
      status: 'in_progress',
    });
    expect(Array.isArray(body.top_produced_today)).toBe(true);
    expect(body.top_produced_today.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.daily_io)).toBe(true);
    expect(body.sex_load).toHaveLength(1);
    expect(body.sex_load[0]).toMatchObject({ location_id: w.production });
  });

  it('scopes a production_manager to its own sex', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/production')
      .set('Authorization', `Bearer ${w.prodManager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.sex_load.every((r: { location_id: number }) =>
      r.location_id === w.production,
    )).toBe(true);
  });

  it('rejects a wrong-layer scoped role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/production')
      .set('Authorization', `Bearer ${w.rawManager.token}`);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// /api/dashboard/supply
// ===========================================================================

describe('GET /api/dashboard/supply', () => {
  it('returns the supply detail for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/supply?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.kpis.current_stock_count).toBe(1); // cake@supply (qty>0)
    // 1 open request targets supply (cake for storeA).
    expect(body.kpis.open_requests).toBe(1);
    // Today: shipped 4 (transfer supply->storeA), received 10 (production_output -> supply).
    expect(body.kpis.shipped_today).toBe(4);
    expect(body.kpis.received_today).toBe(10);
    expect(body.open_request_items).toHaveLength(1);
    expect(body.open_request_items[0]).toMatchObject({
      target_location_id: w.supply,
      product_id: w.cake,
    });
    expect(Array.isArray(body.daily_flow)).toBe(true);
    expect(body.top_destinations_today).toHaveLength(1);
    expect(body.top_destinations_today[0]).toMatchObject({
      location_id: w.storeA,
      qty: 4,
    });
  });

  it('scopes a supply_manager to its own location', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/supply')
      .set('Authorization', `Bearer ${w.supplyManager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.kpis.received_today).toBe(10);
  });

  it('rejects a wrong-layer scoped role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/supply')
      .set('Authorization', `Bearer ${w.rawManager.token}`);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// /api/dashboard/central
// ===========================================================================

describe('GET /api/dashboard/central', () => {
  it('returns the central warehouse detail for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/central?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.kpis.block_count).toBe(1);
    expect(body.kpis.total_sku).toBe(1); // cake@central
    expect(body.kpis.sync_errors_24h).toBe(1);
    expect(body.kpis.last_sync_status).toBe('ok');
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({
      location_id: w.central,
      total_qty: 50,
    });
    expect(body.recent_sync_log.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.daily_sync_runs)).toBe(true);
  });

  it('scopes a central_warehouse_manager to its own block', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/central')
      .set('Authorization', `Bearer ${w.centralManager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.blocks.every((b: { location_id: number }) =>
      b.location_id === w.central,
    )).toBe(true);
  });

  it('rejects a wrong-layer scoped role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/central')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// /api/dashboard/stores
// ===========================================================================

describe('GET /api/dashboard/stores', () => {
  it('returns the stores detail for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/stores?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.kpis.store_count).toBe(2);
    // sales today: storeA 3 * 1000 + storeB 2 * 1500 = 6000
    expect(body.kpis.sales_today_sum).toBe(6000);
    expect(body.kpis.sales_today_count).toBe(2);
    expect(body.kpis.avg_receipt_today).toBe(3000);
    expect(body.store_breakdown).toHaveLength(2);
    const storeA = body.store_breakdown.find(
      (s: { location_id: number }) => s.location_id === w.storeA,
    );
    expect(storeA).toMatchObject({ sales_count: 1, below_min_count: 1 });
    expect(body.top_products_today.length).toBeGreaterThanOrEqual(1);
    expect(body.top_products_today[0].product_id).toBe(w.cake);
    expect(Array.isArray(body.hourly_heatmap)).toBe(true);
    expect(Array.isArray(body.daily_sales)).toBe(true);
  });

  it('scopes a store_manager to its own store', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/stores')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.store_breakdown).toHaveLength(1);
    expect(res.body.store_breakdown[0].location_id).toBe(w.storeA);
    expect(res.body.kpis.sales_today_sum).toBe(3000); // 3 * 1000 = 3000
  });

  it('rejects a wrong-layer scoped role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/stores')
      .set('Authorization', `Bearer ${w.rawManager.token}`);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// /api/dashboard/suppliers — PM-only chain-wide suppliers cluster.
// ===========================================================================

describe('GET /api/dashboard/suppliers', () => {
  it('returns the top suppliers for pm with traffic-light status', async () => {
    const w = await seedWorld();

    // Seed two suppliers: "Alpha" with 3 pending POs (danger) and "Beta"
    // with 1 pending + 1 received PO (warn). The base seedWorld() also
    // inserted one supplier-less PO targeting rawWh, which should appear as
    // the null-supplier_id bucket.
    const alpha = await ctx.db.query<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('Alpha Mills') RETURNING id`,
    );
    const beta = await ctx.db.query<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('Beta Sugar') RETURNING id`,
    );
    const alphaId = Number(alpha.rows[0].id);
    const betaId = Number(beta.rows[0].id);

    // 3 pending approved POs from Alpha (danger).
    for (let i = 0; i < 3; i++) {
      await ctx.db.query(
        `INSERT INTO purchase_orders
           (product_id, qty, supplier_id, target_location_id, status,
            manager_approved_by, manager_approved_at,
            keeper_approved_by, keeper_approved_at)
         VALUES ($1, 10, $2, $3, 'approved', $4, now(), $5, now())`,
        [w.flour, alphaId, w.rawWh, w.pm.id, w.pm.id],
      );
    }

    // 1 pending approved + 1 received (received_movement_id set) from Beta.
    await ctx.db.query(
      `INSERT INTO purchase_orders
         (product_id, qty, supplier_id, target_location_id, status,
          manager_approved_by, manager_approved_at,
          keeper_approved_by, keeper_approved_at)
       VALUES ($1, 7, $2, $3, 'approved', $4, now(), $5, now())`,
      [w.flour, betaId, w.rawWh, w.pm.id, w.pm.id],
    );
    const mv = await ctx.db.query<{ id: string }>(
      `INSERT INTO stock_movements
         (product_id, from_location_id, to_location_id, qty, reason, created_by)
       VALUES ($1, NULL, $2, 4, 'purchase', $3) RETURNING id`,
      [w.flour, w.rawWh, w.pm.id],
    );
    await ctx.db.query(
      `INSERT INTO purchase_orders
         (product_id, qty, supplier_id, target_location_id, status,
          manager_approved_by, manager_approved_at,
          keeper_approved_by, keeper_approved_at,
          received_movement_id)
       VALUES ($1, 4, $2, $3, 'received', $4, now(), $5, now(), $6)`,
      [w.flour, betaId, w.rawWh, w.pm.id, w.pm.id, Number(mv.rows[0].id)],
    );

    const res = await request(ctx.app)
      .get('/api/dashboard/suppliers?range=month')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suppliers)).toBe(true);
    // The seedWorld baseline PO has supplier_id=NULL — so we expect up to 3
    // groups (alpha, beta, null), all under the top-5 cap.
    expect(res.body.suppliers.length).toBeGreaterThanOrEqual(2);
    expect(res.body.suppliers.length).toBeLessThanOrEqual(5);

    const byId = new Map(
      res.body.suppliers.map((s: { supplier_id: number | null }) => [
        s.supplier_id,
        s,
      ]),
    );
    const alphaRow = byId.get(alphaId) as
      | (DashboardSuppliersRow & { status: string })
      | undefined;
    const betaRow = byId.get(betaId) as
      | (DashboardSuppliersRow & { status: string })
      | undefined;

    expect(alphaRow).toBeDefined();
    expect(alphaRow!.supplier_name).toBe('Alpha Mills');
    expect(alphaRow!.pending_pos).toBe(3);
    expect(alphaRow!.total_pos).toBe(3);
    expect(alphaRow!.received_qty).toBe(0);
    expect(alphaRow!.expected_qty).toBe(30);
    expect(alphaRow!.status).toBe('danger');

    expect(betaRow).toBeDefined();
    expect(betaRow!.pending_pos).toBe(1);
    expect(betaRow!.total_pos).toBe(2);
    expect(betaRow!.received_qty).toBe(4);
    expect(betaRow!.expected_qty).toBe(7);
    expect(betaRow!.status).toBe('warn');
  });

  it('returns an empty array when no purchase orders fall in range', async () => {
    await seedWorld();
    // Wipe POs so there's nothing in the window.
    await ctx.db.query('TRUNCATE TABLE purchase_orders CASCADE');
    const pm = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'pm' LIMIT 1`,
    );
    expect(pm.rows.length).toBe(1);

    // We still need a token — fetch from the original seed user.
    const w = await seedWorld();
    await ctx.db.query('TRUNCATE TABLE purchase_orders CASCADE');

    const res = await request(ctx.app)
      .get('/api/dashboard/suppliers?range=today')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suppliers: [] });
  });

  it('rejects a non-pm role with 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/suppliers')
      .set('Authorization', `Bearer ${w.rawManager.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/suppliers');
    expect(res.status).toBe(401);
  });
});

/** Row shape mirror — kept local so the test file doesn't import the route. */
type DashboardSuppliersRow = {
  supplier_id: number | null;
  supplier_name: string;
  pending_pos: number;
  total_pos: number;
  received_qty: number;
  expected_qty: number;
  status: 'ok' | 'warn' | 'danger';
};
