/**
 * M8 — GET /api/dashboard/overview integration tests (spec section 2.8, 4.8).
 *
 * Coverage:
 *   - PM (chain-wide) sees everything across locations.
 *   - store_manager sees only its own store (RBAC scope, AC8.2).
 *   - raw_warehouse_manager sees only its own warehouse.
 *   - `below_min[i].open_request_id` joins to the one open
 *     replenishment_request (invariant 2).
 *   - `open_requests.by_status` matches the seeded distribution and
 *     terminal statuses (CLOSED/CANCELLED) are excluded.
 *   - KPI counts (total_open_requests, below_min_count,
 *     active_production_orders, pending_approvals) are correct.
 *   - `recent_movements` returns the latest 20 in DESC order.
 *   - Response time on a seeded fixture is under the AC8.1 budget (1 s).
 *   - Unauthenticated -> 401, wrong role gate impossible (every role
 *     listed in spec is allowed) so we exercise the empty-scope branch
 *     for a scoped principal with `locationId=null` via a manually-signed
 *     token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signToken } from '../src/auth/jwt.js';
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

// ---------------------------------------------------------------------------
// World-builder — seeds a small but realistic supply chain into a fresh
// snapshot, so each `describe` block gets independent data.
// ---------------------------------------------------------------------------

type World = {
  rawWh: number;
  centralWh: number;
  storeA: number;
  storeB: number;
  production: number;
  productFlour: number; // raw
  productCake: number; // finished
  productPretzel: number; // finished (used at storeA only)
  pm: SeededUser;
  storeAManager: SeededUser;
  rawWhManager: SeededUser;
};

async function seedWorld(): Promise<World> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'Raw WH' });
  const centralWh = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: 'Central WH',
  });
  const production = await makeLocation(ctx.db, { type: 'production', name: 'Prod' });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Store B' });

  const productFlour = await makeProduct(ctx.db, { name: 'Flour', type: 'raw', unit: 'kg' });
  const productCake = await makeProduct(ctx.db, {
    name: 'Cake',
    type: 'finished',
    unit: 'pcs',
  });
  const productPretzel = await makeProduct(ctx.db, {
    name: 'Pretzel',
    type: 'finished',
    unit: 'pcs',
  });

  // Stock — below min at storeA (cake) and at rawWh (flour). storeB healthy.
  await setStock(ctx.db, {
    locationId: storeA,
    productId: productCake,
    qty: 1,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: storeA,
    productId: productPretzel,
    qty: 10,
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
    locationId: centralWh,
    productId: productCake,
    qty: 50,
    minLevel: 10,
    maxLevel: 100,
  });

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });
  const rawWhManager = await makeUser(ctx.db, {
    role: 'raw_warehouse_manager',
    locationId: rawWh,
  });

  // An OPEN replenishment_request for (cake, storeA) — should be joined.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'NEW', $5)`,
    [productCake, storeA, centralWh, 19, pm.id],
  );
  // Another OPEN for (flour, rawWh) but in SHIP_TO_REQUESTER state.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'SHIP_TO_REQUESTER', $5)`,
    [productFlour, rawWh, centralWh, 48, pm.id],
  );
  // A CLOSED one — must NOT appear in by_status.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed,
        status, created_by, closed_at)
     VALUES ($1, $2, $3, $4, 'CLOSED', $5, now())`,
    [productPretzel, storeA, centralWh, 5, pm.id],
  );

  // A draft purchase_order (pending approvals) targeting rawWh — should
  // bump pending_approvals for pm AND for the rawWhManager scope.
  await ctx.db.query(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4)`,
    [productFlour, 30, rawWh, pm.id],
  );

  // An active production order — qty 10 cake at production->centralWh,
  // deadline=today so it appears in production_plan.
  await ctx.db.query(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, deadline, status, created_by)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'in_progress', $5)`,
    [productCake, 10, production, centralWh, pm.id],
  );
  // A done production order — should NOT appear in plan.
  await ctx.db.query(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, deadline, status, created_by, done_at)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'done', $5, now())`,
    [productCake, 5, production, centralWh, pm.id],
  );

  // Some stock movements — seed >20 to assert the LIMIT.
  for (let i = 0; i < 25; i++) {
    await ctx.db.query(
      `INSERT INTO stock_movements
         (product_id, from_location_id, to_location_id, qty, reason, created_by, note)
       VALUES ($1, $2, $3, $4, 'transfer', $5, $6)`,
      [productCake, centralWh, storeA, 1, pm.id, `mv-${i}`],
    );
  }

  return {
    rawWh,
    centralWh,
    storeA,
    storeB,
    production,
    productFlour,
    productCake,
    productPretzel,
    pm,
    storeAManager,
    rawWhManager,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/overview — RBAC + payload shape', () => {
  it('returns the whole-chain snapshot for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // below_min: cake@storeA and flour@rawWh -> 2 rows
    const belowKeys = body.below_min.map(
      (r: { location_id: number; product_id: number }) => `${r.location_id}:${r.product_id}`,
    );
    expect(belowKeys).toContain(`${w.storeA}:${w.productCake}`);
    expect(belowKeys).toContain(`${w.rawWh}:${w.productFlour}`);
    expect(body.below_min).toHaveLength(2);

    // open_request_id is wired for cake@storeA, NEW status.
    const cakeRow = body.below_min.find(
      (r: { location_id: number; product_id: number }) =>
        r.location_id === w.storeA && r.product_id === w.productCake,
    );
    expect(cakeRow.open_request_id).toEqual(expect.any(Number));
    expect(cakeRow.open_request_status).toBe('NEW');

    // open_requests.by_status — terminal CLOSED is excluded.
    expect(body.open_requests.by_status).toEqual({
      NEW: 1,
      SHIP_TO_REQUESTER: 1,
    });
    expect(body.open_requests.total).toBe(2);
    expect(typeof body.open_requests.oldest_created_at).toBe('string');

    // production_plan: only the in_progress one.
    expect(body.production_plan).toHaveLength(1);
    expect(body.production_plan[0]).toMatchObject({
      product_id: w.productCake,
      qty: 10,
      status: 'in_progress',
      location_id: w.production,
      target_location_id: w.centralWh,
    });

    // recent_movements — capped at 20, sorted DESC.
    expect(body.recent_movements).toHaveLength(20);
    const created = body.recent_movements.map(
      (m: { created_at: string }) => m.created_at,
    );
    const sorted = [...created].sort((a: string, b: string) => (a < b ? 1 : -1));
    expect(created).toEqual(sorted);

    // KPIs.
    expect(body.kpis).toEqual({
      total_open_requests: 2,
      below_min_count: 2,
      active_production_orders: 1,
      pending_approvals: 1,
    });
  });

  it('scopes a store_manager to its own store (AC8.2)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // Only the storeA below-min row (cake) — flour@rawWh hidden.
    expect(body.below_min).toHaveLength(1);
    expect(body.below_min[0]).toMatchObject({
      location_id: w.storeA,
      product_id: w.productCake,
    });

    // Only the open replenishment that touches storeA — NEW one.
    expect(body.open_requests.by_status).toEqual({ NEW: 1 });
    expect(body.open_requests.total).toBe(1);

    // No production orders touch storeA -> empty plan.
    expect(body.production_plan).toEqual([]);

    // recent_movements: all 25 seeded movements went into storeA, so the
    // store manager sees 20 of them (still under the LIMIT cap).
    expect(body.recent_movements.length).toBe(20);
    // Every movement has either from or to = storeA.
    for (const m of body.recent_movements as Array<{
      from_location_id: number | null;
      to_location_id: number | null;
    }>) {
      expect(m.from_location_id === w.storeA || m.to_location_id === w.storeA).toBe(true);
    }

    // pending_approvals: PO targets rawWh, not storeA -> 0.
    expect(body.kpis).toEqual({
      total_open_requests: 1,
      below_min_count: 1,
      active_production_orders: 0,
      pending_approvals: 0,
    });
  });

  it('scopes a raw_warehouse_manager to its own warehouse', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.rawWhManager.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // Only flour@rawWh below min.
    expect(body.below_min).toHaveLength(1);
    expect(body.below_min[0]).toMatchObject({
      location_id: w.rawWh,
      product_id: w.productFlour,
    });

    // Only the flour shipment request touches rawWh.
    expect(body.open_requests.by_status).toEqual({ SHIP_TO_REQUESTER: 1 });

    // PO targeted at rawWh -> pending_approvals = 1.
    expect(body.kpis.pending_approvals).toBe(1);
    expect(body.kpis.below_min_count).toBe(1);
    expect(body.kpis.total_open_requests).toBe(1);
  });

  it('responds well under the 1s budget on a seeded fixture (AC8.1)', async () => {
    const w = await seedWorld();
    const t0 = Date.now();
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns an empty snapshot for a scoped principal with locationId=null', async () => {
    // Hand-craft a token that pretends to be a store_manager with no
    // location. This is an unusual state (the DB CHECK forbids it for
    // real users) but the route must still degrade safely.
    const ghostToken = signToken({
      userId: 999_999,
      role: 'store_manager',
      locationId: null,
    });
    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${ghostToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      below_min: [],
      open_requests: { by_status: {}, total: 0, oldest_created_at: null },
      production_plan: [],
      recent_movements: [],
      kpis: {
        total_open_requests: 0,
        below_min_count: 0,
        active_production_orders: 0,
        pending_approvals: 0,
      },
    });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/overview');
    expect(res.status).toBe(401);
  });

  // C6 (Sprint 3 audit) — `pending_approvals` is role-aware. supply_manager
  // is the chain-wide draft-approver and their `location_id` is the supply
  // hub, NOT the raw warehouse a PO targets — the old `target_location_id =
  // principal.locationId` filter therefore always returned 0 for them. We
  // count the rows BEFORE seedWorld() so prior tests' fixtures (no
  // beforeEach reset here) do not pollute the assertion.
  it('shows draft purchase orders to a supply_manager (C6)', async () => {
    const baseline = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM purchase_orders
        WHERE status = 'draft'
          AND (manager_approved_by IS NULL OR keeper_approved_by IS NULL)`,
    );
    const baseCount = Number(baseline.rows[0]?.n ?? 0);

    await seedWorld(); // adds ONE more draft PO
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply', name: 'Supply C6' });
    const supplyMgr = await makeUser(ctx.db, {
      role: 'supply_manager',
      locationId: supplyLoc,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${supplyMgr.token}`);

    expect(res.status).toBe(200);
    // The supply_manager is chain-wide draft-approver; they must see EVERY
    // draft missing manager approval. The +1 is the row this test seeded.
    expect(res.body.kpis.pending_approvals).toBe(baseCount + 1);
  });

  it('hides pending_approvals from store_manager and production_manager (C6)', async () => {
    const w = await seedWorld();
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: w.production,
    });
    const r1 = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(r1.status).toBe(200);
    expect(r1.body.kpis.pending_approvals).toBe(0);

    const r2 = await request(ctx.app)
      .get('/api/dashboard/overview')
      .set('Authorization', `Bearer ${prodMgr.token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.kpis.pending_approvals).toBe(0);
  });
});
