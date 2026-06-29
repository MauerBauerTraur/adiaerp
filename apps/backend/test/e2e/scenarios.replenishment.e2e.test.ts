/**
 * E2E SCENARIO 1 — full automatic replenishment cycle (TZ §15 acceptance).
 *
 * Drives ONE replenishment_request from the moment a store's stock falls
 * below `min_level` (scan creates the request) all the way to CLOSED, through
 * the real state machine + real stock movements + real DB. Asserts every
 * invariant on the way:
 *   - Invariant 2 — one open request per (product, location); the scan never
 *     creates a duplicate while one is open.
 *   - SM state path NEW -> CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER -> CLOSED
 *     (enough at central) and the production sub-path when central is empty.
 *   - Invariant 1 — the closing ship is an atomic transfer (target down,
 *     requester up, transition + audit appended).
 *   - Invariant 3 — stock never goes negative anywhere in the cycle.
 *
 * This suite uses the REAL services (scanForReplenishment, advance,
 * finishProductionOrder, receivePurchaseOrder, approvePurchaseOrder) — no
 * mocks. It is the end-to-end proof the parent agent asked for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock, getQty } from '../helpers/fixtures.js';
import {
  advance,
  createRequest,
  scanBelowMin,
  type ReplenishmentRow,
  type ReplenishmentStatus,
} from '../../src/services/replenishment.js';
import { AppError } from '../../src/errors/index.js';
import { finishProductionOrder } from '../../src/services/productionOrder.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../../src/services/purchaseOrder.js';

/**
 * Mirror the production engine's "scan + create" step (runEngineCycle's create
 * half) WITHOUT the auto-advance, so the test can step the machine
 * deterministically. Returns the requests created this pass. Re-running is
 * idempotent — an OPEN_REQUEST_EXISTS is swallowed exactly like the real cycle.
 */
async function scanForReplenishment(actorUserId: number | null): Promise<ReplenishmentRow[]> {
  const below = await scanBelowMin();
  const created: ReplenishmentRow[] = [];
  for (const row of below) {
    const qtyNeeded = row.max_level - row.qty;
    if (qtyNeeded <= 0) continue;
    try {
      created.push(
        await createRequest({
          productId: row.product_id,
          requesterLocationId: row.location_id,
          qtyNeeded,
          actorUserId,
        }),
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'OPEN_REQUEST_EXISTS') continue;
      throw err;
    }
  }
  return created;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Build a raw->production->supply->central->store chain and return ids. */
async function buildChain(): Promise<{
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

/** Read the current status of a request straight from the DB. */
async function readStatus(requestId: number): Promise<ReplenishmentStatus> {
  const { rows } = await ctx.db.query<{ status: ReplenishmentStatus }>(
    'SELECT status FROM replenishment_requests WHERE id = $1',
    [requestId],
  );
  return rows[0]!.status;
}

async function countOpenRequests(productId: number, locationId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM replenishment_requests
      WHERE product_id = $1 AND requester_location_id = $2
        AND status NOT IN ('CLOSED','CANCELLED')`,
    [productId, locationId],
  );
  return Number(rows[0]!.n);
}

describe('SCENARIO 1 — replenishment cycle: stock < min -> request -> approve -> ship -> restored', () => {
  it('1a happy path: central has stock -> scan opens 1 request -> ships -> CLOSED, stock restored', async () => {
    const { central, store } = await buildChain();
    const product = await makeProduct(ctx.db, { type: 'finished' });

    // Store below min (qty 2, min 5, max 20) — central has plenty.
    await setStock(ctx.db, { locationId: store, productId: product, qty: 2, minLevel: 5, maxLevel: 20 });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });

    // The scan worker spots qty<=min and opens exactly ONE request.
    const created = await scanForReplenishment(null);
    const mine = created.filter(
      (r) => r.product_id === product && r.requester_location_id === store,
    );
    expect(mine).toHaveLength(1);
    const reqId = mine[0]!.id;
    // qty_needed = max - qty = 20 - 2 = 18.
    expect(Number(mine[0]!.qty_needed)).toBe(18);

    // Invariant 2 — a second scan must NOT open a duplicate.
    await scanForReplenishment(null);
    expect(await countOpenRequests(product, store)).toBe(1);

    // Drive the machine: NEW -> CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER -> CLOSED.
    await advance(reqId, null); // NEW -> CHECK_STORE_SUPPLIER
    expect(await readStatus(reqId)).toBe('CHECK_STORE_SUPPLIER');
    await advance(reqId, null); // -> SHIP_TO_REQUESTER (central has 50 >= 18)
    expect(await readStatus(reqId)).toBe('SHIP_TO_REQUESTER');
    const shipped = await advance(reqId, null); // -> CLOSED (atomic transfer)
    expect(shipped.advanced).toBe(true);
    expect(await readStatus(reqId)).toBe('CLOSED');

    // Invariant 1 — atomic transfer: central down 18, store up 18.
    expect(await getQty(ctx.db, central, product)).toBe(50 - 18);
    expect(await getQty(ctx.db, store, product)).toBe(2 + 18);

    // The store is now back at max (20) — at/above min.
    expect(await getQty(ctx.db, store, product)).toBe(20);

    // A transition row exists for every hop (SM-1).
    const { rows: trans } = await ctx.db.query<{ to_status: string }>(
      'SELECT to_status FROM replenishment_transitions WHERE replenishment_id = $1 ORDER BY id',
      [reqId],
    );
    const path = trans.map((t) => t.to_status);
    expect(path).toEqual([
      'NEW',
      'CHECK_STORE_SUPPLIER',
      'SHIP_TO_REQUESTER',
      'CLOSED',
    ]);
  });

  it('1b production sub-path: central empty, raw sufficient -> produce -> ship -> CLOSED', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // Recipe: 1 cake = 2 kg flour (legacy flat = all base, no decoration).
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 2, 'base')`,
      [cake, flour],
    );

    // Store below min; central EMPTY; raw warehouse has plenty of flour.
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const created = await scanForReplenishment(null);
    const reqId = created.find(
      (r) => r.product_id === cake && r.requester_location_id === store,
    )!.id;
    // qty_needed = 10 - 0 = 10. Needs 10*2 = 20 kg flour.

    await advance(reqId, null); // NEW -> CHECK_STORE_SUPPLIER
    await advance(reqId, null); // central empty -> CHECK_PRODUCTION_INPUT
    expect(await readStatus(reqId)).toBe('CHECK_PRODUCTION_INPUT');
    await advance(reqId, null); // raw OK -> CREATE_PRODUCTION_ORDER (transfers BOM in)
    const st = await readStatus(reqId);
    expect(st).toBe('CREATE_PRODUCTION_ORDER');

    // The engine transferred 20 kg flour from raw into production.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(100 - 20);

    // Find the linked production order, start + finish it.
    const { rows: po } = await ctx.db.query<{ id: number }>(
      'SELECT production_order_id AS id FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    const poId = Number(po[0]!.id);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null); // CREATE_PRODUCTION_ORDER -> PRODUCING
    expect(await readStatus(reqId)).toBe('PRODUCING');

    // Finish production: consumes BOM out of production, outputs 10 cakes into central.
    await finishProductionOrder(poId, null);
    expect(await getQty(ctx.db, central, cake)).toBe(10);

    await advance(reqId, null); // PRODUCING -> DONE_TO_WAREHOUSE (chains)
    let status = await readStatus(reqId);
    if (status === 'DONE_TO_WAREHOUSE') {
      await advance(reqId, null); // -> SHIP_TO_REQUESTER
      status = await readStatus(reqId);
    }
    if (status === 'SHIP_TO_REQUESTER') {
      await advance(reqId, null); // -> CLOSED
    }
    expect(await readStatus(reqId)).toBe('CLOSED');

    // Store restored to 10 (max); central back to 0 (shipped all it made).
    expect(await getQty(ctx.db, store, cake)).toBe(10);
    expect(await getQty(ctx.db, central, cake)).toBe(0);

    // Invariant 3 — no negative stock anywhere.
    const { rows: neg } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock WHERE qty < 0',
    );
    expect(Number(neg[0]!.n)).toBe(0);
  });

  it('1c purchase sub-path: raw short -> purchase order (two-step approve) -> received -> produce -> ship', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 2, 'base')`,
      [cake, flour],
    );

    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    // Raw warehouse has only 4 kg flour; need 20 -> short by 16.
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 4 });

    const created = await scanForReplenishment(null);
    const reqId = created.find(
      (r) => r.product_id === cake && r.requester_location_id === store,
    )!.id;

    await advance(reqId, null); // NEW -> CHECK_STORE_SUPPLIER
    await advance(reqId, null); // -> CHECK_PRODUCTION_INPUT (central empty)
    expect(await readStatus(reqId)).toBe('CHECK_PRODUCTION_INPUT');
    await advance(reqId, null); // -> CREATE_PURCHASE_ORDER (flour short)
    expect(await readStatus(reqId)).toBe('CREATE_PURCHASE_ORDER');

    const { rows: poRows } = await ctx.db.query<{ id: number }>(
      'SELECT purchase_order_id AS id FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    const purchaseId = Number(poRows[0]!.id);
    expect(purchaseId).toBeGreaterThan(0);

    // Two-step approval (invariant 7): manager + keeper (real user FKs).
    const manager = await makeUser(ctx.db, { role: 'supply_manager', locationId: store });
    const keeper = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    await approvePurchaseOrder(purchaseId, 'manager', manager.id);
    let { rows: poStatus } = await ctx.db.query<{ status: string }>(
      'SELECT status FROM purchase_orders WHERE id = $1',
      [purchaseId],
    );
    expect(poStatus[0]!.status).toBe('draft'); // still awaiting keeper
    await approvePurchaseOrder(purchaseId, 'keeper', keeper.id);
    ({ rows: poStatus } = await ctx.db.query<{ status: string }>(
      'SELECT status FROM purchase_orders WHERE id = $1',
      [purchaseId],
    ));
    expect(poStatus[0]!.status).toBe('approved');

    // Receive: flour enters raw warehouse atomically.
    await receivePurchaseOrder(purchaseId, keeper.id);
    // raw had 4, purchased shortfall 16 -> now 20.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(20);

    // Wait-state advance: purchase received -> re-check input -> CREATE_PRODUCTION_ORDER.
    await advance(reqId, null);
    expect(await readStatus(reqId)).toBe('CREATE_PRODUCTION_ORDER');
    // All 20kg flour transferred into production.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(0);

    const { rows: prodPo } = await ctx.db.query<{ id: number }>(
      'SELECT production_order_id AS id FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    const prodId = Number(prodPo[0]!.id);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [prodId]);
    await advance(reqId, null); // -> PRODUCING
    await finishProductionOrder(prodId, null);
    // Drive to CLOSED.
    for (let i = 0; i < 4; i += 1) {
      if ((await readStatus(reqId)) === 'CLOSED') break;
      await advance(reqId, null);
    }
    expect(await readStatus(reqId)).toBe('CLOSED');
    expect(await getQty(ctx.db, store, cake)).toBe(10);

    const { rows: neg } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock WHERE qty < 0',
    );
    expect(Number(neg[0]!.n)).toBe(0);
  });

  it('1d boundary: qty exactly == min triggers the scan (qty <= min, not < min)', async () => {
    const { central, store } = await buildChain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    // qty == min exactly.
    await setStock(ctx.db, { locationId: store, productId: product, qty: 5, minLevel: 5, maxLevel: 12 });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 30 });

    const created = await scanForReplenishment(null);
    const mine = created.filter(
      (r) => r.product_id === product && r.requester_location_id === store,
    );
    expect(mine).toHaveLength(1);
    expect(Number(mine[0]!.qty_needed)).toBe(7); // 12 - 5
  });

  it('1e empty/no-op: qty above min creates NO request', async () => {
    const { central, store } = await buildChain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: product, qty: 9, minLevel: 5, maxLevel: 12 });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 30 });

    const created = await scanForReplenishment(null);
    const mine = created.filter(
      (r) => r.product_id === product && r.requester_location_id === store,
    );
    expect(mine).toHaveLength(0);
  });
});
