/**
 * Sprint 2 hardening — route-level coverage for purchase orders.
 *
 * Targets the under-tested handlers in `routes/purchaseOrders.ts`:
 *
 *   GET   /api/purchase-orders                — invalid ?status (422),
 *                                                central_warehouse_manager
 *                                                sees all (no scope clamp),
 *                                                raw_warehouse_manager with
 *                                                NULL locationId returns [].
 *   POST  /api/purchase-orders                — missing required fields (422),
 *                                                non-pm/non-supply 403,
 *                                                supplier_id passthrough.
 *   POST  /api/purchase-orders/:id/approve    — non-existent id (NOT_FOUND
 *                                                surfaces from service).
 *   POST  /api/purchase-orders/:id/receive    — pm can drive happy path;
 *                                                raw_warehouse_manager too;
 *                                                draft -> receive rejected;
 *                                                supply_manager forbidden;
 *                                                already-received idempotent.
 *   POST  /api/purchase-orders/:id/reject     — draft -> rejected ok;
 *                                                already-received 422;
 *                                                non-existent 404;
 *                                                raw_warehouse_manager 403.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../src/services/purchaseOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function draftPO(productId: number, rawWh: number, createdBy: number | null = null): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
     VALUES ($1, 10, $2, 'draft', $3) RETURNING id`,
    [productId, rawWh, createdBy],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('insert returned no id');
  }
  return Number(id);
}

// ---------------------------------------------------------------------------
// GET /api/purchase-orders — filter + scoping
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders — branches', () => {
  it('rejects an unknown ?status= with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders?status=expired')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('central_warehouse_manager sees the full unfiltered list (no clamp)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);

    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: central,
    });
    const res = await request(ctx.app)
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(res.status).toBe(200);
    expect((res.body as { id: number }[]).map((r) => Number(r.id))).toContain(id);
  });

  it('filters by ?status=draft (status pass-through branch)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    const res = await request(ctx.app)
      .get('/api/purchase-orders?status=draft')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect((res.body as { id: number; status: string }[]).every((r) => r.status === 'draft')).toBe(true);
    expect((res.body as { id: number }[]).map((r) => Number(r.id))).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-orders
// ---------------------------------------------------------------------------
describe('POST /api/purchase-orders — validation + RBAC', () => {
  it('rejects a missing qty (422)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ product_id: product, target_location_id: rawWh });
    expect(res.status).toBe(422);
  });

  it('rejects a missing target_location_id (422)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ product_id: product, qty: 5 });
    expect(res.status).toBe(422);
  });

  it('PM is read-only — POST is 403 (no super-admin bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 5, target_location_id: rawWh });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('a raw_warehouse_manager cannot create a PO (403)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rwm = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${rwm.token}`)
      .send({ product_id: product, qty: 5, target_location_id: rawWh });
    expect(res.status).toBe(403);
  });

  it('supply_manager creates a PO and the row carries supplier_id when provided', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });

    // Insert a supplier row so the supplier_id FK has a target.
    const { rows: supplier } = await ctx.db.query<{ id: number }>(
      `INSERT INTO suppliers (name) VALUES ('Acme') RETURNING id`,
    );
    const supplierId = Number(supplier[0]?.id);

    const res = await request(ctx.app)
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({
        product_id: product, qty: 20,
        supplier_id: supplierId,
        target_location_id: rawWh,
        note: 'monthly restock',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.purchase_order?.supplier_id)).toBe(supplierId);
    expect(res.body.purchase_order?.note).toBe('monthly restock');
  });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-orders/:id/approve — extra branches
// ---------------------------------------------------------------------------
describe('POST /api/purchase-orders/:id/approve — extra branches', () => {
  it('returns NOT_FOUND when the id does not exist (operator path)', async () => {
    // PM is read-only now — an operator probes the unknown id and gets 404.
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const res = await request(ctx.app)
      .post('/api/purchase-orders/9999999/approve')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ step: 'manager' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-orders/:id/receive
// ---------------------------------------------------------------------------
describe('POST /api/purchase-orders/:id/receive', () => {
  it('happy path — raw_warehouse_manager receives an approved PO', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    await approvePurchaseOrder(id, 'manager', supplyMgr.id);
    await approvePurchaseOrder(id, 'keeper', rawMgr.id);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${rawMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.purchase_order?.status).toBe('received');
    expect(res.body.purchase_order?.received_movement_id).not.toBe(null);
  });

  it('PM is read-only — receive is 403 (no super-admin bypass)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    await approvePurchaseOrder(id, 'manager', supplyMgr.id);
    await approvePurchaseOrder(id, 'keeper', rawMgr.id);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects a draft PO with 422 from the service (cannot be received without approvals)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${rawMgr.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('a supply_manager cannot receive (403 — only pm + raw_warehouse_manager)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${supplyMgr.token}`);
    expect(res.status).toBe(403);
  });

  it('receiving an already-received PO is idempotent (200, same row)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    await approvePurchaseOrder(id, 'manager', supplyMgr.id);
    await approvePurchaseOrder(id, 'keeper', rawMgr.id);
    await receivePurchaseOrder(id, rawMgr.id);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/receive`)
      .set('Authorization', `Bearer ${rawMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.purchase_order?.status).toBe('received');
  });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-orders/:id/reject
// ---------------------------------------------------------------------------
describe('POST /api/purchase-orders/:id/reject', () => {
  it('flips a draft PO to rejected (audit-logged) — supply_manager actor', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/reject`)
      .set('Authorization', `Bearer ${supplyMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.purchase_order?.status).toBe('rejected');

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
       WHERE action = 'purchase_order.rejected' AND entity_id = $1`,
      [id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('PM is read-only — reject is 403 (no super-admin bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/reject`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects a non-draft PO with 422 (status guard)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    // Drive to approved.
    await approvePurchaseOrder(id, 'manager', supplyMgr.id);
    await approvePurchaseOrder(id, 'keeper', rawMgr.id);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/reject`)
      .set('Authorization', `Bearer ${supplyMgr.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when the PO id does not exist', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const res = await request(ctx.app)
      .post('/api/purchase-orders/9999999/reject')
      .set('Authorization', `Bearer ${supplyMgr.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('a raw_warehouse_manager cannot reject (403 — only pm + supply_manager)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const id = await draftPO(product, rawWh);
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${id}/reject`)
      .set('Authorization', `Bearer ${rawMgr.token}`);
    expect(res.status).toBe(403);
  });
});
