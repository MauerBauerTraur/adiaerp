/**
 * F4.9 — GET /api/sales/receipts integration tests.
 *
 * Coverage:
 *   - Distinct receipts grouped by `poster_transaction_id` (line-level rows
 *     collapse into one receipt with its totals + top products embedded).
 *   - RBAC: store_manager sees only its own store; PM sees all stores.
 *   - `?range` clips the window (default today).
 *   - Top 5 products per receipt — extras don't leak.
 *   - Pagination (`limit`, `offset`, `total`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  type SeededUser,
} from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

type World = {
  storeA: number;
  storeB: number;
  pm: SeededUser;
  managerA: SeededUser;
  managerB: SeededUser;
  txnId1: number;
  txnId2: number;
  txnId3: number;
};

async function seedWorld(): Promise<World> {
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Store B' });

  // 7 distinct products so we can test the top-5 cap.
  const products: number[] = [];
  for (let i = 0; i < 7; i++) {
    products.push(await makeProduct(ctx.db, { type: 'finished', name: `P${i}` }));
  }

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const managerA = await makeUser(ctx.db, { role: 'store_manager', locationId: storeA });
  const managerB = await makeUser(ctx.db, { role: 'store_manager', locationId: storeB });

  // Use random transaction ids per test so suites accumulating into the
  // same isolated schema don't collide on the (txn_id, product_id, line_id)
  // unique index, and so receipt-count assertions stay local to one seed.
  const baseTxn = 100000 + Math.floor(Math.random() * 100000);
  // Receipt 1 — storeA, 7 line items (one per product), today.
  const txnId1 = baseTxn;
  for (let i = 0; i < 7; i++) {
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
         poster_transaction_id, poster_line_id)
       VALUES ($1, $2, $3, 100, now(), $4, $5)`,
      // qty descends so the top-5 ordering is deterministic.
      [storeA, products[i], 10 - i, txnId1, i + 1],
    );
  }
  // Receipt 2 — storeA, 2 lines (same product twice = same line item with 2 line_ids).
  const txnId2 = baseTxn + 1;
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 2, 200, now(), $3, 1)`,
    [storeA, products[0], txnId2],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 3, 200, now(), $3, 2)`,
    [storeA, products[1], txnId2],
  );
  // Receipt 3 — storeB.
  const txnId3 = baseTxn + 2;
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 5, 500, now(), $3, 1)`,
    [storeB, products[0], txnId3],
  );
  // Receipt 4 — storeA, 10 days ago, used for range filter test.
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, 1, 100, now() - interval '10 days', $3, 1)`,
    [storeA, products[0], baseTxn + 3],
  );

  return { storeA, storeB, pm, managerA, managerB, txnId1, txnId2, txnId3 };
}

describe('GET /api/sales/receipts — RBAC + shape', () => {
  it('PM sees every receipt today (3 grouped checks)', async () => {
    const w = await seedWorld();
    // limit high so we definitely include the three seeded ones.
    const res = await request(ctx.app)
      .get('/api/sales/receipts?limit=200')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const txnIds = res.body.items.map((r: { poster_transaction_id: number }) => r.poster_transaction_id);
    expect(txnIds).toEqual(expect.arrayContaining([w.txnId1, w.txnId2, w.txnId3]));
  });

  it('Receipt aggregates qty and revenue across all its lines', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/sales/receipts')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const r1 = res.body.items.find(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id === w.txnId1,
    );
    // qty = 10+9+8+7+6+5+4 = 49, revenue = 49 * 100 = 4900.
    expect(Number(r1.total_qty)).toBe(49);
    expect(Number(r1.total_revenue)).toBe(4900);
    expect(Number(r1.line_count)).toBe(7);
    // Top 5 by qty descending: products 0..4 (qty 10..6).
    expect(r1.products).toHaveLength(5);
    const qtys = r1.products.map((p: { qty: number }) => Number(p.qty));
    expect(qtys).toEqual([10, 9, 8, 7, 6]);
  });

  it('store_manager sees only its own store', async () => {
    const w = await seedWorld();
    const aRes = await request(ctx.app)
      .get('/api/sales/receipts?limit=200')
      .set('Authorization', `Bearer ${w.managerA.token}`);
    expect(aRes.status).toBe(200);
    // storeA-scoped — receipts 1 + 2 present, receipt 3 (storeB) hidden.
    const aIds = aRes.body.items.map((r: { poster_transaction_id: number }) => r.poster_transaction_id);
    expect(aIds).toEqual(expect.arrayContaining([w.txnId1, w.txnId2]));
    expect(aIds).not.toContain(w.txnId3);

    const bRes = await request(ctx.app)
      .get('/api/sales/receipts?limit=200')
      .set('Authorization', `Bearer ${w.managerB.token}`);
    expect(bRes.status).toBe(200);
    const bIds = bRes.body.items.map((r: { poster_transaction_id: number }) => r.poster_transaction_id);
    expect(bIds).toContain(w.txnId3);
    expect(bIds).not.toContain(w.txnId1);
    expect(bIds).not.toContain(w.txnId2);
  });

  it('store_manager requesting a foreign store_id gets 403', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get(`/api/sales/receipts?store_id=${w.storeB}`)
      .set('Authorization', `Bearer ${w.managerA.token}`);
    expect(res.status).toBe(403);
  });

  it('range=month pulls the 10-day-old receipt back in', async () => {
    const w = await seedWorld();
    const todayRes = await request(ctx.app)
      .get('/api/sales/receipts?limit=200')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const todayTxns = todayRes.body.items.map(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id,
    );
    // The 10-day-old receipt (txnId base + 3) is NOT in today's window.
    expect(todayTxns).not.toContain(w.txnId1 + 3);

    const monthRes = await request(ctx.app)
      .get('/api/sales/receipts?range=month&limit=200')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(monthRes.status).toBe(200);
    const monthTxns = monthRes.body.items.map(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id,
    );
    expect(monthTxns).toContain(w.txnId1 + 3);
  });

  it('limit + offset paginates', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/sales/receipts?limit=2&offset=0')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // total is global across the schema; just assert it covers >= 2.
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(0);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/sales/receipts');
    expect(res.status).toBe(401);
  });
});
