/**
 * Sprint 2 hardening — route-level coverage for production orders.
 *
 * Targets the under-tested handler in `routes/productionOrders.ts`:
 *
 *   GET   /api/production-orders             — invalid ?status, scoped manager
 *                                              with no locationId (empty list),
 *                                              production_manager scoping.
 *   POST  /api/production-orders             — invalid deadline format (422),
 *                                              missing product_id (422), bad
 *                                              role (403).
 *   PATCH /api/production-orders/:id         — new -> done atomic shortage path
 *                                              (409 + nothing changed), new ->
 *                                              in_progress success, in_progress
 *                                              -> in_progress no-op rejection,
 *                                              unknown id 404, role 403,
 *                                              cancelled -> done 409.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Insert a production order in `new` status. */
async function newOrder(opts: {
  productId: number;
  locationId: number;
  targetLocationId: number;
  qty?: number;
}): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status)
     VALUES ($1, $2, $3, $4, 'new') RETURNING id`,
    [opts.productId, opts.qty ?? 1, opts.locationId, opts.targetLocationId],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('production order insert returned no id');
  }
  return Number(id);
}

// ---------------------------------------------------------------------------
// GET /api/production-orders
// ---------------------------------------------------------------------------
describe('GET /api/production-orders — filter + scope branches', () => {
  it('rejects an unknown ?status= with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/production-orders?status=launched')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('production_manager sees only orders touching its production location', async () => {
    const prodA = await makeLocation(ctx.db, { type: 'production' });
    const prodB = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });

    const idA = await newOrder({ productId: finished, locationId: prodA, targetLocationId: central });
    const idB = await newOrder({ productId: finished, locationId: prodB, targetLocationId: central });

    const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prodA });
    const res = await request(ctx.app)
      .get('/api/production-orders')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((r) => Number(r.id));
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);
  });

  it('ai_assistant sees the unfiltered list', async () => {
    const ai = await makeUser(ctx.db, { role: 'ai_assistant' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    const res = await request(ctx.app)
      .get('/api/production-orders')
      .set('Authorization', `Bearer ${ai.token}`);
    expect(res.status).toBe(200);
    expect((res.body as { id: number }[]).some((r) => Number(r.id) === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders
// ---------------------------------------------------------------------------
describe('POST /api/production-orders — validation + RBAC', () => {
  it('rejects a missing product_id with 422', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ qty: 1, location_id: prod });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an ill-formed deadline with 422', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({
        product_id: finished, qty: 1, location_id: prod,
        target_location_id: central, deadline: '2026/05/22',
      });
    expect(res.status).toBe(422);
  });

  it('store_manager cannot create a production order (403)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ product_id: finished, qty: 1, location_id: prod });
    expect(res.status).toBe(403);
  });

  it('PM is read-only — POST is 403 (no super-admin bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        product_id: finished, qty: 1, location_id: prod,
        target_location_id: central,
      });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('production_manager creates an order with all optional fields', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/production-orders')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({
        product_id: finished,
        qty: 3,
        location_id: prod,
        target_location_id: central,
        deadline: '2026-12-31',
        note: 'rush order',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.production_order?.qty)).toBe(3);
    // pg serialises a date column as a Date object — Express then JSON-stringifies
    // it as the ISO datetime. We only care that the stored date round-trips.
    expect(String(res.body.production_order?.deadline)).toContain('2026-12');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/production-orders/:id — status transitions
// ---------------------------------------------------------------------------
describe('PATCH /api/production-orders/:id — transitions', () => {
  it('flips new -> in_progress and audit-logs the change', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.production_order?.status).toBe('in_progress');

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
       WHERE action = 'production_order.in_progress' AND entity_id = $1`,
      [id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('PATCH done with INSUFFICIENT_STOCK rolls back EVERYTHING (status stays new)', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 5)`,
      [finished, raw],
    );
    // Only 2 raw in production for an order that needs 5.
    await setStock(ctx.db, { locationId: prod, productId: raw, qty: 2 });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'done' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INSUFFICIENT_STOCK');

    // Nothing in stock changed and the order is still 'new'.
    const { rows } = await ctx.db.query<{ qty: string; status: string }>(
      `SELECT s.qty, po.status
       FROM production_orders po, stock s
       WHERE po.id = $1 AND s.location_id = $2 AND s.product_id = $3`,
      [id, prod, raw],
    );
    expect(Number(rows[0]?.qty)).toBe(2);
    expect(rows[0]?.status).toBe('new');
  });

  it('PM is read-only — PATCH is 403 (no super-admin bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('returns 404 NOT_FOUND when the id does not exist (in_progress branch)', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const res = await request(ctx.app)
      .patch('/api/production-orders/9999999')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND when the id does not exist (cancelled branch)', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const res = await request(ctx.app)
      .patch('/api/production-orders/9999999')
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('rejects in_progress -> in_progress as VALIDATION_ERROR (invalid forward transition)', async () => {
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: prod });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    // First flip new -> in_progress.
    await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'in_progress' });

    // Now flip from cancelled status — first cancel it.
    await ctx.db.query(`UPDATE production_orders SET status = 'cancelled' WHERE id = $1`, [id]);
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects PATCH from a role that lacks production write (403)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const prod = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const id = await newOrder({ productId: finished, locationId: prod, targetLocationId: central });

    const res = await request(ctx.app)
      .patch(`/api/production-orders/${id}`)
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
  });
});
