/**
 * RBAC matrix — owner-approved 2026-05-28 hardening.
 *
 * Top-level invariants:
 *
 *   1. PM × any business write endpoint = 403 FORBIDDEN.
 *      Configuration endpoints (users, locations, products, /api/admin/*,
 *      /api/stock/minmax) are exempt and exercised separately — PM keeps
 *      access there.
 *
 *   2. A scoped operator may only act on data for its own location
 *      (M:N — ADR-0012). Foreign-location writes return 403 FORBIDDEN.
 *
 *   3. A scoped operator on its own location succeeds (control).
 *
 * These tests pin the new policy across the five write modules touched
 * by the hardening pass: replenishment, productionOrders, purchaseOrders,
 * stock, delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
} from './helpers/fixtures.js';
import { createRequest } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// PM × every business write endpoint = 403
// ---------------------------------------------------------------------------
describe('PM_WRITE_BLOCKED — PM hits 403 on every business write', () => {
  it('POST /api/replenishment — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, requester_location_id: store, qty_needed: 1 });
    expect(res.status).toBe(403);
  });

  it('POST /api/replenishment/:id/advance — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 1, actorUserId: null,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/advance`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/replenishment/:id/cancel — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 1, actorUserId: null,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/production-orders — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        product_id: finished, qty: 1,
        location_id: prod, target_location_id: central,
      });
    expect(res.status).toBe(403);
  });

  it('PATCH /api/production-orders/:id — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 1, $2, $3, 'new') RETURNING id`,
      [finished, prod, central],
    );
    const id = Number(rows[0]?.id);
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
  });

  it('POST /api/purchase-orders — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 5, target_location_id: rawWh });
    expect(res.status).toBe(403);
  });

  it('POST /api/purchase-orders/:id/approve — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 5, $2, 'draft', NULL) RETURNING id`,
      [product, rawWh],
    );
    const id = Number(rows[0]?.id);
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/approve`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ step: 'manager' });
    expect(res.status).toBe(403);
  });

  it('POST /api/purchase-orders/:id/receive — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 5, $2, 'draft', NULL) RETURNING id`,
      [product, rawWh],
    );
    const id = Number(rows[0]?.id);
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/purchase-orders/:id/reject — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 5, $2, 'draft', NULL) RETURNING id`,
      [product, rawWh],
    );
    const id = Number(rows[0]?.id);
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/reject`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/stock/movement — 403', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, to_location_id: loc, qty: 1 });
    expect(res.status).toBe(403);
  });

});

// ---------------------------------------------------------------------------
// PM configuration exemption — PM keeps write access on admin / minmax
// ---------------------------------------------------------------------------
describe('PM configuration exemption — PM may still configure', () => {
  it('PATCH /api/stock/minmax — 200', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: loc, product_id: product, min_level: 1, max_level: 5 });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Operator-side hardening — own vs foreign location
// ---------------------------------------------------------------------------
describe('Operator scope — own location succeeds, foreign location 403', () => {
  it('production_manager on its own production location — 201', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: prod,
    });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({
        product_id: finished, qty: 1,
        location_id: prod, target_location_id: central,
      });
    expect(res.status).toBe(201);
  });

  it('production_manager on a FOREIGN production location — 403', async () => {
    const ownProd = await makeLocation(ctx.db, { type: 'production' });
    const foreignProd = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: ownProd,
    });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({
        product_id: finished, qty: 1,
        location_id: foreignProd, target_location_id: central,
      });
    expect(res.status).toBe(403);
  });

  it('central_warehouse_manager moving stock involving its location — 201', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: product, qty: 5 });
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product, from_location_id: from, to_location_id: to,
        qty: 1, reason: 'transfer',
      });
    expect(res.status).toBe(201);
  });

  it('central_warehouse_manager moving FOREIGN stock — 403', async () => {
    const ownWh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const foreignWh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: ownWh,
    });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: foreignWh, productId: product, qty: 5 });
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: product, from_location_id: foreignWh, to_location_id: to,
        qty: 1, reason: 'transfer',
      });
    expect(res.status).toBe(403);
  });
});
