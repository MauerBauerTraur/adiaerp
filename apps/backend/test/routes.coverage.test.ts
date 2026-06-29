/**
 * Route-level coverage gap-fillers (M4/M5/M6).
 *
 * QA flagged three areas under-tested:
 *   - replenishment.ts — RBAC `touchesOwn` branches on `POST /:id/advance`
 *     (production_order / purchase_order linkage), plus a detail-embed assert;
 *   - purchaseOrders.ts — `POST /:id/approve` role gating (403), invalid `step`
 *     (422), and same-step idempotency;
 *   - productionOrders.ts — PATCH invalid status (422), done -> cancelled (409).
 *
 * Each test drives the public HTTP boundary so the express router + middleware
 * are exercised end-to-end (not just the service).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../src/services/purchaseOrder.js';
import { createRequest } from '../src/services/replenishment.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// purchaseOrders.ts — POST /:id/approve
// ---------------------------------------------------------------------------
describe('POST /api/purchase-orders/:id/approve — role gating + validation', () => {
  /** Create a draft PO directly in the DB and return its id. */
  async function makeDraftPO(productId: number, targetLocationId: number): Promise<number> {
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
       VALUES ($1, 10, $2, 'draft') RETURNING id`,
      [productId, targetLocationId],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('insert returned no id');
    }
    return Number(id);
  }

  it('rejects step="manager" from a raw_warehouse_manager (403)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const orderId = await makeDraftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${rawMgr.token}`)
      .send({ step: 'manager' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects step="keeper" from a supply_manager (403)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const orderId = await makeDraftPO(product, rawWh);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ step: 'keeper' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects an invalid step value (422)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    // The PO must be created by the operator so the manager step guard
    // does not short-circuit before validation.
    const { rows: poRow } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 10, $2, 'draft', $3) RETURNING id`,
      [product, rawWh, supplyMgr.id],
    );
    const orderId = Number(poRow[0]?.id);

    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ step: 'invalid' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('idempotently records the same step twice (no duplicate approver)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const supplyMgrA = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    // The PO is raised by supplyMgrA — the IDOR guard requires the approver
    // to be the same user that created the order (only its author may
    // collect the manager-side signature).
    const { rows: poRow } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 10, $2, 'draft', $3) RETURNING id`,
      [product, rawWh, supplyMgrA.id],
    );
    const orderId = Number(poRow[0]?.id);

    const first = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${supplyMgrA.token}`)
      .send({ step: 'manager' });
    expect(first.status).toBe(200);
    expect(first.body.purchase_order?.manager_approved_by).toBe(supplyMgrA.id);
    expect(first.body.purchase_order?.status).toBe('draft');

    // The same supply_manager re-taking the same step is a no-op — the
    // existing approver row stays on file (idempotency on (step, order)).
    const second = await request(ctx.app)
      .post(`/api/purchase-orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${supplyMgrA.token}`)
      .send({ step: 'manager' });
    expect(second.status).toBe(200);
    expect(second.body.purchase_order?.manager_approved_by).toBe(supplyMgrA.id);
    expect(second.body.purchase_order?.status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// productionOrders.ts — PATCH transitions
// ---------------------------------------------------------------------------
describe('PATCH /api/production-orders/:id — status validation', () => {
  it('rejects an invalid status value (422)', async () => {
    const productionLoc = await makeLocation(ctx.db, { type: 'production' });
    const centralWh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: productionLoc,
    });

    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 1, $2, $3, 'new') RETURNING id`,
      [finished, productionLoc, centralWh],
    );
    const orderId = Number(rows[0]?.id);

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${orderId}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'banana' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects done -> cancelled with 409 INVALID_TRANSITION', async () => {
    // Stand up a BOM + raw so we can take the order to done first.
    const productionLoc = await makeLocation(ctx.db, { type: 'production' });
    const centralWh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [finished, raw],
    );
    await setStock(ctx.db, { locationId: productionLoc, productId: raw, qty: 5 });
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: productionLoc,
    });
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 1, $2, $3, 'new') RETURNING id`,
      [finished, productionLoc, centralWh],
    );
    const orderId = Number(rows[0]?.id);
    await finishProductionOrder(orderId, prodMgr.id);

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${orderId}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// replenishment.ts — POST /:id/advance RBAC + GET /:id detail embed
// ---------------------------------------------------------------------------
describe('POST /api/replenishment/:id/advance — RBAC location scoping', () => {
  /** Build the chain the engine assumes. */
  async function chain(): Promise<{
    rawWh: number; production: number; supply: number; central: number; store: number;
  }> {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    return { rawWh, production, supply, central, store };
  }

  it('rejects a store_manager whose location does not touch the request (403)', async () => {
    const { store } = await chain();
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });
    // The intruder belongs to an unrelated store — must be 403.
    const intruder = await makeUser(ctx.db, { role: 'store_manager', locationId: otherStore });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/advance`)
      .set('Authorization', `Bearer ${intruder.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('accepts a central_warehouse_manager bound to the request target (200)', async () => {
    // The request's target_location_id is set to the requester's parent
    // (= central warehouse) by the engine on the NEW -> CHECK_STORE_SUPPLIER
    // hop, so the central_warehouse_manager touches the request via target.
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    // Central has stock so the next hop after CHECK_STORE_SUPPLIER picks the
    // direct-ship branch; both intermediate hops keep RBAC satisfied.
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });
    await setStock(ctx.db, {
      locationId: store, productId: product, qty: 0, minLevel: 1, maxLevel: 4,
    });

    const { runEngineCycle } = await import('../src/services/replenishment.js');
    await runEngineCycle(); // creates + advances NEW -> CHECK_STORE_SUPPLIER

    const { rows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests WHERE product_id = $1 AND requester_location_id = $2`,
      [product, store],
    );
    const reqId = Number(rows[0]?.id);

    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: central,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/advance`)
      .set('Authorization', `Bearer ${centralMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.advanced).toBe(true);
  });

  it('grants raw_warehouse_manager access via the linked purchase_order', async () => {
    // Build a request that has reached CREATE_PURCHASE_ORDER (linked PO present),
    // then assert the raw_warehouse_manager bound to the PO's target can advance.
    const { rawWh, store } = await chain();
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [finished, raw],
    );
    // Store below min, central empty, raw warehouse SHORT — engine raises a PO.
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 4, maxLevel: 6,
    });
    await setStock(ctx.db, { locationId: rawWh, productId: raw, qty: 1 });

    const { runEngineCycle, advance } = await import('../src/services/replenishment.js');
    await runEngineCycle();
    // Drive the request to CREATE_PURCHASE_ORDER.
    const { rows: idRows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests WHERE product_id = $1 AND requester_location_id = $2`,
      [finished, store],
    );
    const reqId = Number(idRows[0]?.id);
    await advance(reqId, null); // -> CHECK_PRODUCTION_INPUT
    await advance(reqId, null); // -> CREATE_PURCHASE_ORDER

    const { rows: poRows } = await ctx.db.query<{
      purchase_order_id: number | null; status: string;
    }>(
      `SELECT purchase_order_id, status FROM replenishment_requests WHERE id = $1`,
      [reqId],
    );
    expect(poRows[0]?.status).toBe('CREATE_PURCHASE_ORDER');
    const purchaseOrderId = poRows[0]?.purchase_order_id ?? null;
    expect(purchaseOrderId).not.toBe(null);

    // Approve and receive — once received, advance() can step the request.
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    await approvePurchaseOrder(purchaseOrderId as number, 'manager', supplyMgr.id);
    await approvePurchaseOrder(purchaseOrderId as number, 'keeper', rawMgr.id);
    await receivePurchaseOrder(purchaseOrderId as number, rawMgr.id);

    // The raw_warehouse_manager calls advance via HTTP — RBAC must see the
    // linkage via the linked purchase_order's target_location_id (= rawWh).
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/advance`)
      .set('Authorization', `Bearer ${rawMgr.token}`);
    expect(res.status).toBe(200);
  });

  it('returns 404 when the request id does not exist', async () => {
    // Owner-approved 2026-05-28: PM is read-only on advance, so we use a
    // scoped operator. The handler reads the row before applying the
    // touch-check, so an unknown id raises NOT_FOUND (not FORBIDDEN).
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: central,
    });
    const res = await request(ctx.app)
      .post('/api/replenishment/999999999/advance')
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/replenishment/:id — embed parity with the list', () => {
  it('embeds product_name, product_unit and location names on the detail payload', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Madlen', unit: 'pcs' });
    const creator = await makeUser(ctx.db, { role: 'pm' });
    const created = await createRequest({
      productId: product,
      requesterLocationId: store,
      qtyNeeded: 4,
      actorUserId: creator.id,
    });

    const res = await request(ctx.app)
      .get(`/api/replenishment/${created.id}`)
      .set('Authorization', `Bearer ${creator.token}`);
    expect(res.status).toBe(200);
    const r = res.body.request as Record<string, unknown>;
    expect(r).toBeDefined();
    expect(r.product_name).toBe('Madlen');
    expect(r.product_unit).toBe('pcs');
    expect(typeof r.requester_location_name).toBe('string');
    // target_location_name may be null until the engine sets a target — that
    // is the LEFT JOIN contract.
    expect(r.target_location_name === null || typeof r.target_location_name === 'string').toBe(true);
  });
});
