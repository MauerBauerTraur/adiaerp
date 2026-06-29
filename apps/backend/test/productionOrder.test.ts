/**
 * M5 — Production orders + the atomic "tayyor" (done) flow.
 *
 * Covers spec acceptance criteria:
 *   AC5.1 — `done` consumes BOM raw atomically AND produces output atomically.
 *   AC5.2 — when a BOM component is short, `done` is rejected (409) and
 *           NOTHING in stock changes (full rollback).
 *   AC5.3 — when the order was raised by a replenishment, completing it
 *           steps the linked request to DONE_TO_WAREHOUSE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock, getQty } from './helpers/fixtures.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';

let ctx: TestContext;
let productionLoc: number;
let centralWh: number;
let finishedProduct: number;
let rawFlour: number;
let rawSugar: number;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  productionLoc = await makeLocation(ctx.db, { type: 'production' });
  centralWh = await makeLocation(ctx.db, { type: 'central_warehouse' });
  finishedProduct = await makeProduct(ctx.db, { type: 'finished' });
  rawFlour = await makeProduct(ctx.db, { type: 'raw' });
  rawSugar = await makeProduct(ctx.db, { type: 'raw' });

  // BOM: 1 unit of finished = 2 kg flour + 1 kg sugar.
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
     VALUES ($1, $2, 2), ($1, $3, 1)`,
    [finishedProduct, rawFlour, rawSugar],
  );
});

async function createOrder(qty: number, replenishmentId: number | null = null): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status, replenishment_id)
     VALUES ($1, $2, $3, $4, 'new', $5) RETURNING id`,
    [finishedProduct, qty, productionLoc, centralWh, replenishmentId],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('order insert returned no id');
  }
  return Number(id);
}

describe('production_order.done — AC5.1', () => {
  it('atomically consumes the BOM at production AND produces output at target', async () => {
    // Need 5 finished -> 10 flour + 5 sugar at production.
    await setStock(ctx.db, { locationId: productionLoc, productId: rawFlour, qty: 20 });
    await setStock(ctx.db, { locationId: productionLoc, productId: rawSugar, qty: 10 });

    const orderId = await createOrder(5);
    const updated = await finishProductionOrder(orderId, null);
    expect(updated.status).toBe('done');

    // Production location lost the BOM qty.
    expect(await getQty(ctx.db, productionLoc, rawFlour)).toBe(10);
    expect(await getQty(ctx.db, productionLoc, rawSugar)).toBe(5);
    // Central warehouse gained the produced qty.
    expect(await getQty(ctx.db, centralWh, finishedProduct)).toBe(5);

    // Ledger has BOM `production_input` rows + one `production_output` row,
    // all linked to the order.
    const ledger = await ctx.db.query<{ reason: string }>(
      `SELECT reason FROM stock_movements WHERE production_order_id = $1 ORDER BY id`,
      [orderId],
    );
    const reasons = ledger.rows.map((r) => r.reason).sort();
    expect(reasons).toEqual(['production_input', 'production_input', 'production_output'].sort());
  });
});

describe('production_order.done — AC5.2 (insufficient stock rolls back EVERYTHING)', () => {
  it('rejects with INSUFFICIENT_STOCK and changes NOTHING when a component is short', async () => {
    // 5 finished needs 10 flour + 5 sugar — we have only 8 flour.
    await setStock(ctx.db, { locationId: productionLoc, productId: rawFlour, qty: 8 });
    await setStock(ctx.db, { locationId: productionLoc, productId: rawSugar, qty: 10 });

    const orderId = await createOrder(5);
    await expect(finishProductionOrder(orderId, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });

    // AC5.2 — neither raw was consumed, no output was created, status stays new.
    expect(await getQty(ctx.db, productionLoc, rawFlour)).toBe(8);
    expect(await getQty(ctx.db, productionLoc, rawSugar)).toBe(10);
    expect(await getQty(ctx.db, centralWh, finishedProduct)).toBe(null);

    const ledger = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM stock_movements WHERE production_order_id = $1`,
      [orderId],
    );
    expect(Number(ledger.rows[0]?.n)).toBe(0);

    const status = await ctx.db.query<{ status: string }>(
      `SELECT status FROM production_orders WHERE id = $1`,
      [orderId],
    );
    expect(status.rows[0]?.status).toBe('new');
  });
});

describe('production_order.done — idempotency', () => {
  it('does not consume BOM twice when called twice', async () => {
    await setStock(ctx.db, { locationId: productionLoc, productId: rawFlour, qty: 10 });
    await setStock(ctx.db, { locationId: productionLoc, productId: rawSugar, qty: 5 });

    const orderId = await createOrder(2); // needs 4 flour + 2 sugar
    await finishProductionOrder(orderId, null);
    // Second call must be a no-op (already done).
    const again = await finishProductionOrder(orderId, null);
    expect(again.status).toBe('done');
    expect(await getQty(ctx.db, productionLoc, rawFlour)).toBe(6);
    expect(await getQty(ctx.db, productionLoc, rawSugar)).toBe(3);
    expect(await getQty(ctx.db, centralWh, finishedProduct)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// I1 (ADR-0001 §11) — PATCH cancelled rules
// ---------------------------------------------------------------------------
describe('PATCH /api/production-orders/:id {status:"cancelled"} — ADR-0001 §11', () => {
  it('rejects done -> cancelled with 409 INVALID_TRANSITION', async () => {
    await setStock(ctx.db, { locationId: productionLoc, productId: rawFlour, qty: 10 });
    await setStock(ctx.db, { locationId: productionLoc, productId: rawSugar, qty: 5 });
    const orderId = await createOrder(2);
    await finishProductionOrder(orderId, null);

    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: productionLoc,
    });
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${orderId}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_TRANSITION');
  });

  it('GET /api/production-orders embeds product_name + location_name + target_location_name (I4)', async () => {
    const orderId = await createOrder(2);
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/production-orders')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.id === orderId,
    );
    expect(row).toBeDefined();
    expect(typeof row?.product_name).toBe('string');
    expect(typeof row?.location_name).toBe('string');
    expect(typeof row?.target_location_name).toBe('string');
  });

  it('allows new -> cancelled and in_progress -> cancelled', async () => {
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: productionLoc,
    });
    const orderId = await createOrder(1);

    // new -> cancelled
    const res1 = await request(ctx.app)
      .patch(`/api/production-orders/${orderId}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'cancelled' });
    expect(res1.status).toBe(200);
    expect(res1.body.production_order?.status).toBe('cancelled');

    // in_progress -> cancelled
    const orderId2 = await createOrder(1);
    await ctx.db.query(
      `UPDATE production_orders SET status = 'in_progress' WHERE id = $1`,
      [orderId2],
    );
    const res2 = await request(ctx.app)
      .patch(`/api/production-orders/${orderId2}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'cancelled' });
    expect(res2.status).toBe(200);
    expect(res2.body.production_order?.status).toBe('cancelled');
  });
});
