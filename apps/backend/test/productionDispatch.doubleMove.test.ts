/**
 * Regression tests for the two stock double-move bugs in ADR-0019 §11.1.
 *
 * P1 — a production_dispatch's stock transfer must happen EXACTLY ONCE,
 *      whichever channel acts first: web "Berildi" (dispatch), web "Qabul
 *      qilindi" (receive, single or batch) or the Telegram `rcv:dsp` button.
 *      Telegram used to transfer again after a web dispatch had already moved
 *      the stock.
 * P2 — the finished-product ("output") dispatch: on `done` the output is
 *      already written into the target location (production_output), so the
 *      later "Qabul qilindi" must not transfer it again (that left the
 *      production location negative). The status flip still works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { dispatchCallback } from '../src/integrations/telegram/dispatch.js';
import { withTransaction } from '../src/db/index.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function newOrder(opts: { productId: number; locationId: number; targetLocationId: number | null; qty: number }): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
     VALUES ($1, $2, $3, $4, 'new') RETURNING id`,
    [opts.productId, opts.qty, opts.locationId, opts.targetLocationId],
  );
  return Number(rows[0]!.id);
}

async function newDispatch(opts: {
  orderId: number; productId: number; qty: number; from: number; to: number;
}): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO production_dispatches
       (production_order_id, product_id, product_name, product_unit, qty_needed, from_location_id, to_location_id)
     VALUES ($1, $2, 'p', 'kg', $3, $4, $5) RETURNING id`,
    [opts.orderId, opts.productId, opts.qty, opts.from, opts.to],
  );
  return Number(rows[0]!.id);
}

/** Stock movements booked against an order for one product. */
async function movements(orderId: number, productId: number): Promise<Array<{ reason: string; qty: number; from: number | null; to: number | null }>> {
  const { rows } = await ctx.db.query<{ reason: string; qty: string; from_location_id: string | null; to_location_id: string | null }>(
    `SELECT reason::text AS reason, qty::text AS qty, from_location_id, to_location_id
       FROM stock_movements
      WHERE production_order_id = $1 AND product_id = $2
      ORDER BY id`,
    [orderId, productId],
  );
  return rows.map((r) => ({
    reason: r.reason,
    qty: Number(r.qty),
    from: r.from_location_id === null ? null : Number(r.from_location_id),
    to: r.to_location_id === null ? null : Number(r.to_location_id),
  }));
}

async function qtyAt(locationId: number, productId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ qty: string }>(
    'SELECT qty::text AS qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  return rows[0] === undefined ? 0 : Number(rows[0].qty);
}

async function dispatchRow(id: number): Promise<{ status: string; movement_id: number | null }> {
  const { rows } = await ctx.db.query<{ status: string; movement_id: string | null }>(
    'SELECT status, movement_id FROM production_dispatches WHERE id = $1',
    [id],
  );
  return { status: rows[0]!.status, movement_id: rows[0]!.movement_id === null ? null : Number(rows[0]!.movement_id) };
}

/** A raw-material dispatch: raw warehouse -> production, 3 of 10 on hand. */
async function rawSetup() {
  const raw = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const prod = await makeLocation(ctx.db, { type: 'production' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  await setStock(ctx.db, { locationId: raw, productId: flour, qty: 10 });
  const orderId = await newOrder({ productId: cake, locationId: prod, targetLocationId: central, qty: 1 });
  const dispatchId = await newDispatch({ orderId, productId: flour, qty: 3, from: raw, to: prod });
  const warehouse = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: raw });
  const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
  return { raw, prod, central, flour, cake, orderId, dispatchId, warehouse, prodMgr };
}

const rcv = (id: number, p: { id: number; role: 'production_manager' | 'pm'; locationId: number | null }) =>
  dispatchCallback({ verb: 'rcv', entity: 'dsp', id } as never, { userId: p.id, role: p.role, locationId: p.locationId });
const snd = (id: number, p: { id: number; role: 'raw_warehouse_manager' | 'pm'; locationId: number | null }) =>
  dispatchCallback({ verb: 'snd', entity: 'dsp', id } as never, { userId: p.id, role: p.role, locationId: p.locationId });

describe('P1 — a dispatch moves stock exactly once, whichever channel acts first', () => {
  it('web "Berildi" then Telegram "Qabul qilindi" -> ONE transfer', async () => {
    const s = await rawSetup();
    const web = await request(ctx.app)
      .patch(`/api/production-orders/dispatches/${s.dispatchId}/dispatch`)
      .set('Authorization', `Bearer ${s.warehouse.token}`)
      .send({});
    expect(web.status).toBe(200);
    const webMovement = web.body.movement_id as number;
    expect(typeof webMovement).toBe('number');

    const tg = await rcv(s.dispatchId, { id: s.prodMgr.id, role: 'production_manager', locationId: s.prod });
    expect(tg.kind).toBe('ok');

    expect(await movements(s.orderId, s.flour)).toEqual([{ reason: 'transfer', qty: 3, from: s.raw, to: s.prod }]);
    expect(await qtyAt(s.raw, s.flour)).toBe(7);
    expect(await qtyAt(s.prod, s.flour)).toBe(3);
    expect(await dispatchRow(s.dispatchId)).toEqual({ status: 'received', movement_id: webMovement });
  });

  it('Telegram "Berildi" (no move) then web "Qabul qilindi" -> ONE transfer', async () => {
    const s = await rawSetup();
    expect((await snd(s.dispatchId, { id: s.warehouse.id, role: 'raw_warehouse_manager', locationId: s.raw })).kind).toBe('ok');
    const web = await request(ctx.app)
      .patch(`/api/production-orders/dispatches/${s.dispatchId}/receive`)
      .set('Authorization', `Bearer ${s.prodMgr.token}`)
      .send({});
    expect(web.status).toBe(200);
    expect(await movements(s.orderId, s.flour)).toHaveLength(1);
    expect(await qtyAt(s.prod, s.flour)).toBe(3);
  });

  it('Telegram "Berildi" then Telegram "Qabul qilindi" -> ONE transfer', async () => {
    const s = await rawSetup();
    await snd(s.dispatchId, { id: s.warehouse.id, role: 'raw_warehouse_manager', locationId: s.raw });
    expect((await rcv(s.dispatchId, { id: s.prodMgr.id, role: 'production_manager', locationId: s.prod })).kind).toBe('ok');
    expect(await movements(s.orderId, s.flour)).toHaveLength(1);
    expect(await dispatchRow(s.dispatchId)).toMatchObject({ status: 'received' });
  });

  it('web and Telegram "Qabul qilindi" at the same moment -> ONE transfer', async () => {
    const s = await rawSetup();
    await snd(s.dispatchId, { id: s.warehouse.id, role: 'raw_warehouse_manager', locationId: s.raw });
    // Hold the dispatch row so BOTH receives are in flight at once, then let go:
    // whatever reads the row without locking it would move the stock twice.
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    let free!: () => void;
    const freeP = new Promise<void>((r) => { free = r; });
    const holder = withTransaction(async (tx) => {
      await tx.query('SELECT id FROM production_dispatches WHERE id = $1 FOR UPDATE', [s.dispatchId]);
      locked();
      await freeP;
    });
    await lockedP;
    const both = Promise.all([
      request(ctx.app)
        .patch(`/api/production-orders/dispatches/${s.dispatchId}/receive`)
        .set('Authorization', `Bearer ${s.prodMgr.token}`)
        .send({})
        .then((r) => r),
      rcv(s.dispatchId, { id: s.prodMgr.id, role: 'production_manager', locationId: s.prod }),
    ]);
    await new Promise((r) => setTimeout(r, 300)); // both are now waiting on the row
    free();
    await holder;
    const [web, tg] = await both;
    // Exactly one of them receives; the other is told it is no longer 'dispatched'.
    expect([web.status === 200, tg.kind === 'ok'].filter(Boolean)).toHaveLength(1);
    expect(await movements(s.orderId, s.flour)).toHaveLength(1);
    expect(await qtyAt(s.raw, s.flour)).toBe(7);
  });
});

/** A finished-product order at `prod`, output dispatch prod -> `to`. */
async function outputSetup(opts: { withTarget: boolean }) {
  const prod = await makeLocation(ctx.db, { type: 'production' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const orderId = await newOrder({ productId: cake, locationId: prod, targetLocationId: opts.withTarget ? central : null, qty: 2 });
  const dispatchId = await newDispatch({ orderId, productId: cake, qty: 2, from: prod, to: central });
  const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
  const cwMgr = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
  const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
  return { prod, central, cake, orderId, dispatchId, prodMgr, cwMgr, pm };
}

async function markDone(s: { orderId: number; prodMgr: { token: string } }): Promise<void> {
  const res = await request(ctx.app)
    .patch(`/api/production-orders/${s.orderId}`)
    .set('Authorization', `Bearer ${s.prodMgr.token}`)
    .send({ status: 'done' });
  expect(res.status).toBe(200);
}

describe('P2 — done puts the output in the target; "Qabul qilindi" never moves it again', () => {
  it('done then web "Qabul qilindi" -> ONE output movement, production not negative, status received', async () => {
    const s = await outputSetup({ withTarget: true });
    await markDone(s);
    expect(await dispatchRow(s.dispatchId)).toMatchObject({ status: 'dispatched' });

    const res = await request(ctx.app)
      .patch(`/api/production-orders/dispatches/${s.dispatchId}/receive`)
      .set('Authorization', `Bearer ${s.cwMgr.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');

    expect(await movements(s.orderId, s.cake)).toEqual([{ reason: 'production_output', qty: 2, from: null, to: s.central }]);
    expect(await qtyAt(s.central, s.cake)).toBe(2);
    expect(await qtyAt(s.prod, s.cake)).toBe(0);
  });

  it('done then Telegram "Qabul qilindi" -> ONE output movement', async () => {
    const s = await outputSetup({ withTarget: true });
    await markDone(s);
    expect((await rcv(s.dispatchId, { id: s.pm.id, role: 'pm', locationId: null })).kind).toBe('ok');
    expect(await movements(s.orderId, s.cake)).toHaveLength(1);
    expect(await qtyAt(s.prod, s.cake)).toBe(0);
    expect(await dispatchRow(s.dispatchId)).toMatchObject({ status: 'received' });
  });

  it('done then batch "Qabul qilindi" -> ONE output movement', async () => {
    const s = await outputSetup({ withTarget: true });
    await markDone(s);
    const res = await request(ctx.app)
      .patch('/api/production-orders/dispatches/batch-receive')
      .set('Authorization', `Bearer ${s.cwMgr.token}`)
      .send({ ids: [s.dispatchId] });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(1);
    expect(await movements(s.orderId, s.cake)).toHaveLength(1);
    expect(await qtyAt(s.prod, s.cake)).toBe(0);
  });

  it('a batch "Berildi" BEFORE done does not move the not-yet-made output; done + receive -> ONE movement', async () => {
    const s = await outputSetup({ withTarget: true });
    const batch = await request(ctx.app)
      .patch('/api/production-orders/dispatches/batch-dispatch')
      .set('Authorization', `Bearer ${s.pm.token}`)
      .send({ ids: [s.dispatchId] });
    expect(batch.status).toBe(200);
    expect(await movements(s.orderId, s.cake)).toEqual([]);

    await markDone(s);
    const res = await request(ctx.app)
      .patch(`/api/production-orders/dispatches/${s.dispatchId}/receive`)
      .set('Authorization', `Bearer ${s.cwMgr.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(await movements(s.orderId, s.cake)).toHaveLength(1);
    expect(await qtyAt(s.central, s.cake)).toBe(2);
    expect(await qtyAt(s.prod, s.cake)).toBe(0);
  });

  it('no target: the output lands in production and "Qabul qilindi" moves it ONCE to the warehouse', async () => {
    const s = await outputSetup({ withTarget: false });
    await markDone(s);
    const res = await request(ctx.app)
      .patch(`/api/production-orders/dispatches/${s.dispatchId}/receive`)
      .set('Authorization', `Bearer ${s.cwMgr.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(await movements(s.orderId, s.cake)).toEqual([
      { reason: 'production_output', qty: 2, from: null, to: s.prod },
      { reason: 'transfer', qty: 2, from: s.prod, to: s.central },
    ]);
    expect(await qtyAt(s.prod, s.cake)).toBe(0);
    expect(await qtyAt(s.central, s.cake)).toBe(2);
  });
});
