/**
 * Sprint 1+2 audit fixes — IDOR (Insecure Direct Object Reference) coverage.
 *
 * Before the fix:
 *   - a `production_manager` could POST/PATCH production orders that belong
 *     to ANOTHER production location;
 *   - a `supply_manager` could approve another supply_manager's PO;
 *   - a `raw_warehouse_manager` could approve/receive a PO targeting another
 *     raw warehouse.
 *
 * These tests pin those behaviours to 403 (FORBIDDEN). The pm super-admin
 * still bypasses every guard, exercised in the existing happy-path suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { approvePurchaseOrder } from '../src/services/purchaseOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// C1 — production_manager IDOR on production orders
// ---------------------------------------------------------------------------
describe('production_manager IDOR — production orders are scoped to own location', () => {
  it('POST /api/production-orders — another production location is 403', async () => {
    const prodA = await makeLocation(ctx.db, { type: 'production' });
    const prodB = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });

    // A production_manager pinned to prodA tries to create an order for prodB.
    const mgrA = await makeUser(ctx.db, { role: 'production_manager', locationId: prodA });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${mgrA.token}`)
      .send({
        product_id: finished, qty: 1,
        location_id: prodB,
        target_location_id: central,
      });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('POST /api/production-orders — own location is 201 (control)', async () => {
    const prodA = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const mgrA = await makeUser(ctx.db, { role: 'production_manager', locationId: prodA });

    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${mgrA.token}`)
      .send({
        product_id: finished, qty: 1,
        location_id: prodA,
        target_location_id: central,
      });
    expect(res.status).toBe(201);
  });

  it('PATCH /api/production-orders/:id — order in another prod loc is 403', async () => {
    const prodA = await makeLocation(ctx.db, { type: 'production' });
    const prodB = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    // Seed an order belonging to prodB.
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 1, $2, $3, 'new') RETURNING id`,
      [finished, prodB, central],
    );
    const orderId = Number(rows[0]?.id);

    const mgrA = await makeUser(ctx.db, { role: 'production_manager', locationId: prodA });
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${orderId}`)
      .set('Authorization', `Bearer ${mgrA.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');

    // The order's status must NOT have changed.
    const after = await ctx.db.query<{ status: string }>(
      'SELECT status FROM production_orders WHERE id = $1',
      [orderId],
    );
    expect(after.rows[0]?.status).toBe('new');
  });

  it('PATCH /api/production-orders/:id — unknown id surfaces as 404 (not 403)', async () => {
    const prodA = await makeLocation(ctx.db, { type: 'production' });
    const mgrA = await makeUser(ctx.db, { role: 'production_manager', locationId: prodA });
    const res = await request(ctx.app)
      .patch('/api/production-orders/9999999')
      .set('Authorization', `Bearer ${mgrA.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// C2 — supply_manager and raw_warehouse_manager IDOR on purchase orders
// ---------------------------------------------------------------------------
describe('supply_manager IDOR — approve manager step only on own POs', () => {
  it('approving another supply_manager\'s PO is 403', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });

    const author = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const intruder = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });

    // `author` raises a draft PO.
    const create = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ product_id: product, qty: 10, target_location_id: rawWh });
    expect(create.status).toBe(201);
    const orderId = Number(create.body.purchase_order?.id);

    // A different supply_manager tries to take the manager step.
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ step: 'manager' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');

    // Manager approval column must still be null.
    const after = await ctx.db.query<{ manager_approved_by: number | null }>(
      'SELECT manager_approved_by FROM purchase_orders WHERE id = $1',
      [orderId],
    );
    expect(after.rows[0]?.manager_approved_by).toBeNull();
  });

  it('PO with created_by = NULL is 403 for any supply_manager (legacy data guard)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 10, $2, 'draft', NULL) RETURNING id`,
      [product, rawWh],
    );
    const orderId = Number(rows[0]?.id);

    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ step: 'manager' });
    expect(res.status).toBe(403);
  });
});

describe('raw_warehouse_manager IDOR — keeper step + receive only on own raw wh', () => {
  it('approving keeper step on a PO targeting another raw wh is 403', async () => {
    const rawA = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawB = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });

    // PO targets rawA.
    const create = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ product_id: product, qty: 10, target_location_id: rawA });
    const orderId = Number(create.body.purchase_order?.id);

    // raw_warehouse_manager bound to rawB tries to keeper-approve.
    const intruder = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawB });
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ step: 'keeper' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('receiving a PO targeting another raw wh is 403', async () => {
    const rawA = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawB = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgrA = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawA });

    // PO targets rawA — drive it to approved using the service so it is
    // ready to receive.
    const create = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ product_id: product, qty: 10, target_location_id: rawA });
    const orderId = Number(create.body.purchase_order?.id);
    await approvePurchaseOrder(orderId, 'manager', supplyMgr.id);
    await approvePurchaseOrder(orderId, 'keeper', rawMgrA.id);

    // raw_warehouse_manager bound to rawB tries to receive.
    const intruder = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawB });
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/receive`)
      .set('Authorization', `Bearer ${intruder.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');

    // Status MUST still be 'approved' — nothing received.
    const after = await ctx.db.query<{ status: string }>(
      'SELECT status FROM purchase_orders WHERE id = $1',
      [orderId],
    );
    expect(after.rows[0]?.status).toBe('approved');
  });

  it('control — the keeper bound to the right raw wh succeeds', async () => {
    const rawA = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgrA = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawA });

    const create = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ product_id: product, qty: 10, target_location_id: rawA });
    const orderId = Number(create.body.purchase_order?.id);
    await approvePurchaseOrder(orderId, 'manager', supplyMgr.id);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${rawMgrA.token}`)
      .send({ step: 'keeper' });
    expect(res.status).toBe(200);
    expect(res.body.purchase_order?.status).toBe('approved');
  });
});
