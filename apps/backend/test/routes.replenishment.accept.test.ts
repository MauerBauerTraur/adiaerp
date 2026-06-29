/**
 * 0024 — Recipient-side closure endpoints (accept / reject / return /
 * cancel-by-fulfiller).
 *
 * Coverage matrix:
 *   accept_full      — store kept 100% of shipQty; no counter-movement.
 *   accept_partial   — store kept some; remainder counter-shipped to target;
 *                       closure_reason = 'accepted_partial'.
 *   reject           — store refused; full qty counter-shipped to target;
 *                       closure_reason = 'rejected'.
 *   return           — store accepted earlier, returns part later;
 *                       closure_reason rolls accepted_partial -> 'returned'
 *                       when accepted reaches zero.
 *   cancel-by-fulfiller — fulfiller bekor qiladi while still pre-ship;
 *                          closure_reason = 'cancelled_by_fulfiller'.
 *   RBAC             — only the requester operator may accept/reject/return;
 *                       only the target/fulfiller operator may
 *                       cancel-by-fulfiller.
 *
 * The tests drive the engine through `runEngineCycle` so the request
 * starts in `CLOSED` (status) before the recipient acts — mirroring
 * the live data flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  acceptShipment,
  advance,
  createRequest,
  rejectShipment,
  returnShipment,
  runEngineCycle,
} from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Build the chain: raw_wh -> production -> supply -> central -> store. */
async function chain(): Promise<{
  rawWh: number;
  production: number;
  supply: number;
  central: number;
  store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { rawWh, production, supply, central, store };
}

/**
 * Drive a fresh request through to CLOSED via the engine + manual
 * advances. Returns the request id, the central/store ids, and the
 * product id so the caller can assert stock + envelope.
 */
async function makeClosedRequest(opts: {
  initialQtyStore: number;
  qtyNeeded: number;
  centralStock: number;
}): Promise<{
  reqId: number;
  central: number;
  store: number;
  product: number;
}> {
  const { central, store } = await chain();
  const product = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  // The engine raises a request with `qty_needed = max_level - qty`. We want
  // that to equal `opts.qtyNeeded`, so set max = initialQty + qtyNeeded and
  // min anywhere strictly above initialQty so the scan triggers.
  await setStock(ctx.db, {
    locationId: store,
    productId: product,
    qty: opts.initialQtyStore,
    minLevel: opts.initialQtyStore + 1,
    maxLevel: opts.initialQtyStore + opts.qtyNeeded,
  });
  await setStock(ctx.db, { locationId: central, productId: product, qty: opts.centralStock });

  // Engine creates + transitions NEW -> CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER
  await runEngineCycle();
  const { rows } = await ctx.db.query<{ id: number; status: string }>(
    `SELECT id, status FROM replenishment_requests
       WHERE product_id = $1 AND requester_location_id = $2`,
    [product, store],
  );
  const reqId = Number(rows[0]?.id);
  // Drive to CLOSED.
  for (let i = 0; i < 6; i++) {
    const result = await advance(reqId, null);
    if (result.request.status === 'CLOSED' || result.request.status === 'CANCELLED') break;
    if (!result.advanced) break;
  }
  return { reqId, central, store, product };
}

// ---------------------------------------------------------------------------
// accept — full / partial / validation
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/:id/accept', () => {
  it('accept full -> closure_reason=accepted_full, no counter-movement', async () => {
    const { reqId, store, product } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    // The auto-engine moved 5 into the store; we use the requester operator.
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const storeBefore = await getQty(ctx.db, store, product);
    expect(storeBefore).toBe(5);

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_accepted: 5, note: 'all good' });
    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('accepted_full');
    expect(Number(res.body.request.qty_accepted)).toBe(5);
    expect(res.body.request.qty_returned).toBeNull();
    // No counter-movement -> store still holds 5.
    expect(await getQty(ctx.db, store, product)).toBe(5);
  });

  it('accept partial -> remainder counter-shipped to target', async () => {
    const { reqId, central, store, product } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 10,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralBefore = await getQty(ctx.db, central, product);
    // SHIP took 10 out of 50 -> central = 40, store = 10.
    expect(centralBefore).toBe(40);

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_accepted: 7, note: '3 spoiled in transit' });
    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('accepted_partial');
    expect(Number(res.body.request.qty_accepted)).toBe(7);
    expect(Number(res.body.request.qty_returned)).toBe(3);
    // 3 counter-shipped back: store=7, central=43.
    expect(await getQty(ctx.db, store, product)).toBe(7);
    expect(await getQty(ctx.db, central, product)).toBe(43);
  });

  it('qty_accepted > qty_needed -> 422', async () => {
    const { reqId, store } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_accepted: 999 });
    expect(res.status).toBe(422);
  });

  it('PM cannot accept (403)', async () => {
    const { reqId } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ qty_accepted: 5 });
    expect(res.status).toBe(403);
  });

  it('a foreign store_manager cannot accept (403)', async () => {
    const { reqId } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const intruder = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: otherStore,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ qty_accepted: 5 });
    expect(res.status).toBe(403);
  });

  it('idempotent: second accept after closure is a no-op', async () => {
    const { reqId, store } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 4,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const first = await acceptShipment({
      requestId: reqId,
      qtyAccepted: 4,
      note: 'ok',
      actorUserId: storeMgr.id,
    });
    expect(first.closure_reason).toBe('accepted_full');

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_accepted: 2 }); // would otherwise be a partial, but is a no-op
    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('accepted_full');
    expect(Number(res.body.request.qty_accepted)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// reject — full counter-movement back
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/:id/reject', () => {
  it('reject -> closure_reason=rejected + full counter-movement back', async () => {
    const { reqId, central, store, product } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 8,
      centralStock: 50,
    });
    expect(await getQty(ctx.db, store, product)).toBe(8);
    expect(await getQty(ctx.db, central, product)).toBe(42);

    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ reason: 'wrong product' });
    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('rejected');
    expect(res.body.request.reject_reason).toBe('wrong product');
    expect(Number(res.body.request.qty_returned)).toBe(8);
    expect(await getQty(ctx.db, store, product)).toBe(0);
    expect(await getQty(ctx.db, central, product)).toBe(50);
  });

  it('reject requires reason (422)', async () => {
    const { reqId, store } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('PM cannot reject (403)', async () => {
    const { reqId } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ reason: 'try' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// return — post-accept counter-movement
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/:id/return', () => {
  it('return after accept -> closure_reason flips to returned when accepted hits 0', async () => {
    const { reqId, central, store, product } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 10,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    await acceptShipment({
      requestId: reqId,
      qtyAccepted: 10,
      note: null,
      actorUserId: storeMgr.id,
    });
    expect(await getQty(ctx.db, store, product)).toBe(10);

    // Return all 10.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/return`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_returned: 10, reason: 'damaged later' });
    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('returned');
    expect(Number(res.body.request.qty_accepted)).toBe(0);
    expect(Number(res.body.request.qty_returned)).toBe(10);
    expect(await getQty(ctx.db, store, product)).toBe(0);
    expect(await getQty(ctx.db, central, product)).toBe(50);
  });

  it('partial return keeps closure_reason as accepted_partial', async () => {
    const { reqId, central, store, product } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 10,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    await acceptShipment({
      requestId: reqId,
      qtyAccepted: 10,
      note: null,
      actorUserId: storeMgr.id,
    });

    // Return 3 of 10.
    const updated = await returnShipment({
      requestId: reqId,
      qtyReturned: 3,
      reason: 'one box spoiled',
      actorUserId: storeMgr.id,
    });
    expect(updated.closure_reason).toBe('accepted_partial');
    expect(Number(updated.qty_accepted)).toBe(7);
    expect(Number(updated.qty_returned)).toBe(3);
    expect(await getQty(ctx.db, store, product)).toBe(7);
    expect(await getQty(ctx.db, central, product)).toBe(43);
  });

  it('return on a not-yet-accepted request is rejected (409)', async () => {
    const { reqId, store } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/return`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ qty_returned: 1, reason: 'try' });
    // The service throws INVALID_TRANSITION (409).
    expect([409, 422]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// cancel-by-fulfiller
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/:id/cancel-by-fulfiller', () => {
  it('fulfiller (central wh) cancels a pre-ship request -> CANCELLED', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });
    // Advance once: NEW -> CHECK_STORE_SUPPLIER (resolves target_location_id
    // to the central warehouse). Now the fulfiller (central wh manager) is
    // the target operator and may cancel-by-fulfiller.
    await advance(created.id, null);
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel-by-fulfiller`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ reason: 'central out of capacity' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.closure_reason).toBe('cancelled_by_fulfiller');
  });

  it('cancel-by-fulfiller after CLOSED is refused (uses reject instead)', async () => {
    const { reqId, central } = await makeClosedRequest({
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 50,
    });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/cancel-by-fulfiller`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ reason: 'too late' });
    // CLOSED is terminal — cancel returns the row unchanged (200, idempotent).
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CLOSED');
  });

  it('a store_manager (requester side) cannot cancel-by-fulfiller', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 0,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });
    await runEngineCycle(); // -> CHECK_STORE_SUPPLIER (target resolved)
    const { rows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests
         WHERE product_id = $1 AND requester_location_id = $2`,
      [product, store],
    );
    const reqId = Number(rows[0]?.id);

    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/cancel-by-fulfiller`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ reason: 'wrong role' });
    // store_manager is not in the route's authorize set.
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// /cancel — closure_reason stamped on the existing endpoint
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/:id/cancel — stamps closure_reason', () => {
  it('requester cancel stamps closure_reason=cancelled_by_requester', async () => {
    const { store } = await chain();
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: storeMgr.id,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ reason: 'changed our mind' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.closure_reason).toBe('cancelled_by_requester');
  });
});

// silence unused-import warnings if the linter complains
void rejectShipment;
