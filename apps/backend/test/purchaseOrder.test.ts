/**
 * M6 — Purchase orders (two-step approval, D5/OS-5).
 *
 *   AC6.1 — a draft does NOT take effect until BOTH approvals are present.
 *   AC6.2 — `approved` requires both `*_approved_by` filled (DB CHECK + app).
 *   AC6.3 — `received` increases raw warehouse stock atomically.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, getQty } from './helpers/fixtures.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../src/services/purchaseOrder.js';

let ctx: TestContext;
let rawWh: number;
let rawProduct: number;
let managerId: number;
let keeperId: number;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  rawProduct = await makeProduct(ctx.db, { type: 'raw' });
  const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
  managerId = (await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc })).id;
  keeperId = (await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh })).id;
});

async function createDraft(qty: number): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [rawProduct, qty, rawWh],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('purchase order insert returned no id');
  }
  return Number(id);
}

describe('approvePurchaseOrder — AC6.1 & AC6.2', () => {
  it('first approval keeps the order in draft (does not take effect)', async () => {
    const orderId = await createDraft(50);
    const after = await approvePurchaseOrder(orderId, 'manager', managerId);
    expect(after.status).toBe('draft');
    expect(after.manager_approved_by).toBe(managerId);
    expect(after.keeper_approved_by).toBe(null);
  });

  it('second approval flips status to approved (both *_approved_by set)', async () => {
    const orderId = await createDraft(50);
    await approvePurchaseOrder(orderId, 'manager', managerId);
    const after = await approvePurchaseOrder(orderId, 'keeper', keeperId);
    expect(after.status).toBe('approved');
    expect(after.manager_approved_by).toBe(managerId);
    expect(after.keeper_approved_by).toBe(keeperId);
  });

  it('approval order does not matter — keeper-then-manager also works', async () => {
    const orderId = await createDraft(50);
    await approvePurchaseOrder(orderId, 'keeper', keeperId);
    const after = await approvePurchaseOrder(orderId, 'manager', managerId);
    expect(after.status).toBe('approved');
  });

  it('re-applying the same step is a no-op (idempotent)', async () => {
    const orderId = await createDraft(50);
    await approvePurchaseOrder(orderId, 'manager', managerId);
    const again = await approvePurchaseOrder(orderId, 'manager', keeperId);
    // Idempotent — the second manager call did not overwrite the approver.
    expect(again.manager_approved_by).toBe(managerId);
    expect(again.status).toBe('draft');
  });

  it('DB CHECK rejects setting approved without both approvals', async () => {
    const orderId = await createDraft(50);
    // Trying to bypass the service and set approved directly with no approvers
    // must trip the chk_po_approved_consistency CHECK constraint.
    await expect(
      ctx.db.query(
        `UPDATE purchase_orders SET status = 'approved' WHERE id = $1`,
        [orderId],
      ),
    ).rejects.toThrow();
  });
});

describe('receivePurchaseOrder — AC6.3', () => {
  it('flips approved -> received and atomically increases raw stock', async () => {
    const orderId = await createDraft(40);
    await approvePurchaseOrder(orderId, 'manager', managerId);
    await approvePurchaseOrder(orderId, 'keeper', keeperId);

    expect(await getQty(ctx.db, rawWh, rawProduct)).toBe(null);

    const received = await receivePurchaseOrder(orderId, keeperId);
    expect(received.status).toBe('received');
    expect(received.received_movement_id).not.toBe(null);

    expect(await getQty(ctx.db, rawWh, rawProduct)).toBe(40);
    const ledger = await ctx.db.query<{ reason: string; qty: string }>(
      `SELECT reason, qty FROM stock_movements WHERE purchase_order_id = $1`,
      [orderId],
    );
    expect(ledger.rows[0]?.reason).toBe('purchase');
    expect(Number(ledger.rows[0]?.qty)).toBe(40);
  });

  it('cannot be received without both approvals', async () => {
    const orderId = await createDraft(40);
    await approvePurchaseOrder(orderId, 'manager', managerId);
    // Still draft — keeper not approved.
    await expect(receivePurchaseOrder(orderId, keeperId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await getQty(ctx.db, rawWh, rawProduct)).toBe(null);
  });

  it('re-receiving an already-received order is a no-op', async () => {
    const orderId = await createDraft(40);
    await approvePurchaseOrder(orderId, 'manager', managerId);
    await approvePurchaseOrder(orderId, 'keeper', keeperId);
    await receivePurchaseOrder(orderId, keeperId);
    const again = await receivePurchaseOrder(orderId, keeperId);
    expect(again.status).toBe('received');
    // Stock did not double.
    expect(await getQty(ctx.db, rawWh, rawProduct)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// I5 — GET /api/purchase-orders RBAC location scoping
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders — I5 location scoping (spec §6)', () => {
  it('raw_warehouse_manager sees only POs targeting their raw warehouse', async () => {
    // PO #1 targets `rawWh` (the keeper's location); PO #2 targets another.
    const otherRawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const { rows: r1 } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [rawProduct, 10, rawWh],
    );
    const { rows: r2 } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [rawProduct, 20, otherRawWh],
    );
    const id1 = Number(r1[0]?.id);
    const id2 = Number(r2[0]?.id);

    const keeper = await makeUser(ctx.db, {
      role: 'raw_warehouse_manager', locationId: rawWh,
    });
    const res = await request(ctx.app)
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${keeper.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });

  it('supply_manager sees only POs they created', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgrA = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const supplyMgrB = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });

    const { rows: r1 } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
      [rawProduct, 10, rawWh, supplyMgrA.id],
    );
    const { rows: r2 } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
      [rawProduct, 20, rawWh, supplyMgrB.id],
    );
    const idA = Number(r1[0]?.id);
    const idB = Number(r2[0]?.id);

    const res = await request(ctx.app)
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${supplyMgrA.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);
  });

  it('embeds product_name + target_location_name + supplier_name (I4)', async () => {
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [rawProduct, 10, rawWh],
    );
    const id = Number(rows[0]?.id);
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/purchase-orders`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(typeof row?.product_name).toBe('string');
    expect(typeof row?.target_location_name).toBe('string');
    // supplier_name is null when no supplier_id is set.
    expect(row?.supplier_name).toBe(null);
  });
});
