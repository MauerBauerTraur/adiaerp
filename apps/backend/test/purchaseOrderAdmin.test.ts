/**
 * EPIC 6.1 — Admin-initiated purchase orders (admin → skladchi).
 *
 * Covers:
 *   - POST /api/purchase-orders/admin — pm creates, manager step pre-filled,
 *     status stays draft awaiting the keeper (skladchi);
 *   - RBAC: only pm may use the admin endpoint;
 *   - validation: target must be a raw warehouse;
 *   - the keeper (raw_warehouse_manager) confirms via the existing approve
 *     endpoint → status flips to `approved` (two-step approval preserved);
 *   - the skladchi receives a notification.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('POST /api/purchase-orders/admin', () => {
  it('lets pm place an order routed to the skladchi with the manager step pre-filled', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });

    const res = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 25, target_location_id: rawWh });

    expect(res.status).toBe(201);
    const po = res.body.purchase_order;
    expect(po.status).toBe('draft');
    expect(po.initiated_by_admin).toBe(true);
    expect(Number(po.manager_approved_by)).toBe(pm.id);
    expect(po.keeper_approved_by).toBeNull();
  });

  it('notifies the skladchi (raw_warehouse_manager) of the admin order', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const skladchi = await makeUser(ctx.db, {
      role: 'raw_warehouse_manager',
      locationId: rawWh,
    });
    const product = await makeProduct(ctx.db, { type: 'raw' });

    const res = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 10, target_location_id: rawWh });
    expect(res.status).toBe(201);

    const { rows } = await ctx.db.query<{ type: string }>(
      `SELECT type FROM notifications WHERE recipient_user_id = $1`,
      [skladchi.id],
    );
    expect(rows.some((r) => r.type === 'purchase_request_created')).toBe(true);
  });

  it('flips to approved once the skladchi confirms the keeper step', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const skladchi = await makeUser(ctx.db, {
      role: 'raw_warehouse_manager',
      locationId: rawWh,
    });
    const product = await makeProduct(ctx.db, { type: 'raw' });

    const createRes = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 5, target_location_id: rawWh });
    const poId = createRes.body.purchase_order.id;

    const approveRes = await request(ctx.app)
      .post(`/api/purchase-orders/${poId}/approve`)
      .set('Authorization', `Bearer ${skladchi.token}`)
      .send({ step: 'keeper' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.purchase_order.status).toBe('approved');
    expect(Number(approveRes.body.purchase_order.keeper_approved_by)).toBe(skladchi.id);
  });

  it('rejects a non-pm caller with 403', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const supply = await makeUser(ctx.db, { role: 'supply_manager', locationId: rawWh });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${supply.token}`)
      .send({ product_id: product, qty: 5, target_location_id: rawWh });
    expect(res.status).toBe(403);
  });

  it('rejects a non-raw-warehouse target with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, qty: 5, target_location_id: store });
    expect(res.status).toBe(422);
  });

  it('rejects a missing qty with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .post('/api/purchase-orders/admin')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, target_location_id: rawWh });
    expect(res.status).toBe(422);
  });
});
