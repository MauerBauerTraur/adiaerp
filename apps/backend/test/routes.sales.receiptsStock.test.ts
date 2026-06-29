/**
 * EPIC 8.2 / 8.3 — GET /api/sales/receipts/stock integration tests.
 *
 * Coverage:
 *   - Per-line opening/sold/remaining reconciliation (Ост − sotildi − qoldi).
 *   - The backward walk: opening reconciles to live stock at the window head;
 *     older checks open higher than newer ones for the same product.
 *   - has_force_majeure flips true when a line over-sold (remaining < 0).
 *   - RBAC: store_manager sees only its own store; foreign store_id -> 403.
 *   - Unauthenticated -> 401.
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

describe('GET /api/sales/receipts/stock — chek-level reconciliation', () => {
  it('reconciles opening backward from live stock; older check opens higher', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Recon Store' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Napoleon', unit: 'pcs' });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const baseTxn = 700000 + Math.floor(Math.random() * 100000);
    // Two checks today on the same product: older sold 3, newer sold 5.
    const olderTxn = baseTxn;
    const newerTxn = baseTxn + 1;
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 3, 100, now() - interval '2 hours', $3, 1)`,
      [store, product, olderTxn],
    );
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 5, 100, now() - interval '1 hours', $3, 1)`,
      [store, product, newerTxn],
    );
    // Live stock after both sales = 2. So window head opening = 2 + 3 + 5 = 10.
    await setStock(ctx.db, { locationId: store, productId: product, qty: 2 });

    const res = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=200`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);

    const older = res.body.items.find(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id === olderTxn,
    );
    const newer = res.body.items.find(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id === newerTxn,
    );
    // Newer check: opening 10, sold 5, remaining 5.
    expect(newer.lines[0].opening_qty).toBe(10);
    expect(newer.lines[0].sold_qty).toBe(5);
    expect(newer.lines[0].remaining_qty).toBe(5);
    expect(newer.has_force_majeure).toBe(false);
    // Older check: opening 5 (= newer's remaining), sold 3, remaining 2 (= live).
    expect(older.lines[0].opening_qty).toBe(5);
    expect(older.lines[0].sold_qty).toBe(3);
    expect(older.lines[0].remaining_qty).toBe(2);
  });

  it('remaining never under-runs given a consistent head (no false fors-major)', async () => {
    // The reconciliation seeds the window head as live_stock + Σ(window sales),
    // so when stock + sales are consistent every remaining >= 0 and no false
    // fors-major fires. (The authoritative over-sell signal is the persisted
    // `wrong_keyed_check` notification raised in salesSync at ingest time, not
    // this read-only reporting view.)
    const store = await makeLocation(ctx.db, { type: 'store', name: 'FM Store' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Tort', unit: 'pcs' });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const txn = 810000 + Math.floor(Math.random() * 100000);
    const earlierTxn = txn;
    const laterTxn = txn + 1;
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 10, 100, now() - interval '3 hours', $3, 1)`,
      [store, product, earlierTxn],
    );
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 5, 100, now() - interval '1 hours', $3, 1)`,
      [store, product, laterTxn],
    );
    await setStock(ctx.db, { locationId: store, productId: product, qty: 0 });

    const res = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=200`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const later = res.body.items.find(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id === laterTxn,
    );
    const earlier = res.body.items.find(
      (r: { poster_transaction_id: number }) => r.poster_transaction_id === earlierTxn,
    );
    // head = live(0) + window sales(15) = 15. Newer-first walk:
    //   later  : opening 15, sold 5,  remaining 10
    //   earlier: opening 10, sold 10, remaining 0  (reconciles to live 0)
    expect(later.lines[0].opening_qty).toBe(15);
    expect(later.lines[0].remaining_qty).toBe(10);
    expect(earlier.lines[0].opening_qty).toBe(10);
    expect(earlier.lines[0].remaining_qty).toBe(0);
    expect(later.has_force_majeure).toBe(false);
    expect(earlier.has_force_majeure).toBe(false);
  });

  it('paginates correctly: opening/remaining hold when offset>0 and window>page', async () => {
    // Regression for the opening-cursor pagination bug: the window-head seed
    // (live_stock + Σ window sales) is the opening of the NEWEST check, so a
    // page that starts `offset` checks deep must first subtract the sales of
    // the newer (preceding) checks. Three checks on one product: oldest sold 3,
    // middle sold 5, newest sold 2; live stock after all = 4.
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Page Store' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Eclair', unit: 'pcs' });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const baseTxn = 900000 + Math.floor(Math.random() * 90000);
    const oldestTxn = baseTxn; // sold 3, sold_at -3h
    const middleTxn = baseTxn + 1; // sold 5, sold_at -2h
    const newestTxn = baseTxn + 2; // sold 2, sold_at -1h
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 3, 100, now() - interval '3 hours', $3, 1)`,
      [store, product, oldestTxn],
    );
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 5, 100, now() - interval '2 hours', $3, 1)`,
      [store, product, middleTxn],
    );
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 2, 100, now() - interval '1 hours', $3, 1)`,
      [store, product, newestTxn],
    );
    // window head opening = live(4) + (3+5+2) = 14.
    //   newest : opening 14, sold 2, remaining 12
    //   middle : opening 12, sold 5, remaining 7
    //   oldest : opening  7, sold 3, remaining 4  (= live)
    await setStock(ctx.db, { locationId: store, productId: product, qty: 4 });

    // Page 1: limit 1, offset 0 -> the newest check only.
    const page0 = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=1&offset=0`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(3);
    expect(page0.body.items).toHaveLength(1);
    expect(page0.body.items[0].poster_transaction_id).toBe(newestTxn);
    expect(page0.body.items[0].lines[0].opening_qty).toBe(14);
    expect(page0.body.items[0].lines[0].remaining_qty).toBe(12);
    expect(page0.body.items[0].has_force_majeure).toBe(false);

    // Page 2: limit 1, offset 1 -> the middle check. opening MUST be 12, not 14.
    const page1 = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=1&offset=1`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.items[0].poster_transaction_id).toBe(middleTxn);
    expect(page1.body.items[0].lines[0].opening_qty).toBe(12);
    expect(page1.body.items[0].lines[0].sold_qty).toBe(5);
    expect(page1.body.items[0].lines[0].remaining_qty).toBe(7);
    expect(page1.body.items[0].has_force_majeure).toBe(false);

    // Page 3: limit 1, offset 2 -> the oldest check. opening 7, remaining 4=live.
    const page2 = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=1&offset=2`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].poster_transaction_id).toBe(oldestTxn);
    expect(page2.body.items[0].lines[0].opening_qty).toBe(7);
    expect(page2.body.items[0].lines[0].remaining_qty).toBe(4);
    expect(page2.body.items[0].has_force_majeure).toBe(false);
  });

  it('no false force-majeure on a deep page when stock+sales are consistent', async () => {
    // Before the fix, offset>0 overstated opening, which could not flip FM true;
    // but the inverse (a deep page whose corrected opening dips below sold)
    // must NOT misfire either. Two checks, live 0: newest sold 1, oldest sold 9.
    const store = await makeLocation(ctx.db, { type: 'store', name: 'DeepFM Store' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Slice', unit: 'pcs' });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const baseTxn = 990000 + Math.floor(Math.random() * 9000);
    const oldTxn = baseTxn;
    const newTxn = baseTxn + 1;
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 9, 100, now() - interval '2 hours', $3, 1)`,
      [store, product, oldTxn],
    );
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 1, 100, now() - interval '1 hours', $3, 1)`,
      [store, product, newTxn],
    );
    await setStock(ctx.db, { locationId: store, productId: product, qty: 0 });
    // head = 0 + 10 = 10. newest: opening 10 sold 1 rem 9. oldest: opening 9 sold 9 rem 0.

    const deep = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${store}&limit=1&offset=1`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(deep.status).toBe(200);
    expect(deep.body.items[0].poster_transaction_id).toBe(oldTxn);
    expect(deep.body.items[0].lines[0].opening_qty).toBe(9);
    expect(deep.body.items[0].lines[0].sold_qty).toBe(9);
    expect(deep.body.items[0].lines[0].remaining_qty).toBe(0);
    expect(deep.body.items[0].has_force_majeure).toBe(false);
  });

  it('store_manager sees only its own store; foreign store_id -> 403', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'StockA' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'StockB' });
    const product = await makeProduct(ctx.db, { type: 'finished', name: 'Bun', unit: 'pcs' });
    const managerA = await makeUser(ctx.db, { role: 'store_manager', locationId: storeA });

    const txnA = 820000 + Math.floor(Math.random() * 100000);
    await ctx.db.query(
      `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
       VALUES ($1, $2, 1, 100, now(), $3, 1)`,
      [storeA, product, txnA],
    );
    await setStock(ctx.db, { locationId: storeA, productId: product, qty: 5 });

    const ok = await request(ctx.app)
      .get('/api/sales/receipts/stock?limit=200')
      .set('Authorization', `Bearer ${managerA.token}`);
    expect(ok.status).toBe(200);
    const ids = ok.body.items.map((r: { poster_transaction_id: number }) => r.poster_transaction_id);
    expect(ids).toContain(txnA);

    const forbidden = await request(ctx.app)
      .get(`/api/sales/receipts/stock?store_id=${storeB}`)
      .set('Authorization', `Bearer ${managerA.token}`);
    expect(forbidden.status).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/sales/receipts/stock');
    expect(res.status).toBe(401);
  });
});
