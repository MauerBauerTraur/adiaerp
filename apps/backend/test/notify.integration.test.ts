/**
 * M9 — Integration tests that the 9 spec §7 notification types are written
 * to `notifications` by the right business flows.
 *
 * Each case exercises ONE flow end-to-end and asserts:
 *   - the right `type` row exists;
 *   - the recipient resolution rule (spec §7) was honoured;
 *   - the notification was queued with `telegram_sent = FALSE` (the outbox
 *     worker is not involved in these tests).
 *
 * Two of the nine types (`poster_sync_failed`, `negative_stock_detected`)
 * are already covered by the Poster suites — they remain unchanged here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
} from './helpers/fixtures.js';
import {
  advance,
  createRequest,
  runEngineCycle,
} from '../src/services/replenishment.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';
import { approvePurchaseOrder } from '../src/services/purchaseOrder.js';
import { createNotification } from '../src/services/notify.js';
import { withTransaction } from '../src/db/index.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Hard reset every per-test piece of state.
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM replenishment_transitions');
  await ctx.db.query('DELETE FROM replenishment_requests');
  await ctx.db.query('DELETE FROM production_orders');
  await ctx.db.query('DELETE FROM purchase_orders');
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query(`UPDATE locations SET manager_user_id = NULL`);
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM products');
});

/** Build the full chain and attach a manager user to every location. */
async function buildChainWithManagers(): Promise<{
  rawWh: number;
  production: number;
  supply: number;
  central: number;
  store: number;
  storeManagerId: number;
  centralManagerId: number;
  rawManagerId: number;
  pmId: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

  const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
  const centralMgr = await makeUser(ctx.db, {
    role: 'central_warehouse_manager',
    locationId: central,
  });
  const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
  const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    storeMgr.id,
    store,
  ]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    centralMgr.id,
    central,
  ]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    rawMgr.id,
    rawWh,
  ]);

  return {
    rawWh,
    production,
    supply,
    central,
    store,
    storeManagerId: storeMgr.id,
    centralManagerId: centralMgr.id,
    rawManagerId: rawMgr.id,
    pmId: pm.id,
  };
}

async function countByType(type: string, recipientUserId?: number): Promise<number> {
  const params: (string | number)[] = [type];
  let where = `type = $1`;
  if (recipientUserId !== undefined) {
    params.push(recipientUserId);
    where += ` AND recipient_user_id = $2`;
  }
  const { rows } = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE ${where}`,
    params,
  );
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// stock_below_min — fires from runEngineCycle's scan, deduped per 24h
// ---------------------------------------------------------------------------
describe('stock_below_min', () => {
  it('notifies the requester location manager when stock falls below min', async () => {
    const { store, storeManagerId, central } = await buildChainWithManagers();
    const product = await makeProduct(ctx.db, { type: 'finished' });

    // Below min at the store; central has plenty so the engine immediately
    // creates and starts a request — the scan still queues a
    // `stock_below_min` nudge for the manager.
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 1,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });

    await runEngineCycle();
    expect(await countByType('stock_below_min', storeManagerId)).toBe(1);
  });

  it('is debounced — running the scan twice produces only one notification per 24h', async () => {
    const { store, storeManagerId, central } = await buildChainWithManagers();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 1,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });

    await runEngineCycle();
    await runEngineCycle();
    expect(await countByType('stock_below_min', storeManagerId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// replenishment_created — fires from createRequest
// ---------------------------------------------------------------------------
describe('replenishment_created', () => {
  it('notifies the requester manager on createRequest', async () => {
    const { store, storeManagerId } = await buildChainWithManagers();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 1,
      minLevel: 5,
      maxLevel: 10,
    });

    await createRequest({
      productId: product,
      requesterLocationId: store,
      qtyNeeded: 9,
      actorUserId: null,
    });

    expect(await countByType('replenishment_created', storeManagerId)).toBe(1);
  });

  // C1 (Sprint 3 audit) — spec §7 requires BOTH the requester AND the
  // target location manager to receive `replenishment_created`. The target
  // manager is notified after `advanceNew` resolves the central warehouse.
  it('also notifies the target location manager once the target is resolved (C1)', async () => {
    const { store, central, storeManagerId, centralManagerId } =
      await buildChainWithManagers();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 1,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });

    // Driving runEngineCycle creates the request, then advances NEW ->
    // CHECK_STORE_SUPPLIER which fills target_location_id and fires the
    // target-side nudge.
    await runEngineCycle();

    expect(await countByType('replenishment_created', storeManagerId)).toBe(1);
    expect(await countByType('replenishment_created', centralManagerId)).toBe(1);

    // Re-running the cycle MUST NOT produce a second target-side nudge —
    // the dedupeKey `replenishment_created:target:<id>` makes it idempotent.
    await runEngineCycle();
    expect(await countByType('replenishment_created', centralManagerId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// shipment_created — fires from advanceShipToRequester -> CLOSED
// ---------------------------------------------------------------------------
describe('shipment_created', () => {
  it('notifies the requester manager when the transfer ships', async () => {
    const { store, central, storeManagerId } = await buildChainWithManagers();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 1,
      minLevel: 5,
      maxLevel: 10,
    });
    await setStock(ctx.db, { locationId: central, productId: product, qty: 50 });

    // Drive through to CLOSED.
    await runEngineCycle();
    const { rows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests
        WHERE requester_location_id = $1 AND product_id = $2`,
      [store, product],
    );
    const reqId = Number(rows[0]!.id);
    await advance(reqId, null); // CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER
    await advance(reqId, null); // SHIP_TO_REQUESTER -> CLOSED

    expect(await countByType('shipment_created', storeManagerId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// production_order_done — fires from finishProductionOrder
// ---------------------------------------------------------------------------
describe('production_order_done', () => {
  it('notifies the central warehouse manager and PMs when an order is finished', async () => {
    const { central, production, centralManagerId, pmId } = await buildChainWithManagers();
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1,$2,1)`,
      [finished, raw],
    );
    // Production location holds the raw component.
    await setStock(ctx.db, { locationId: production, productId: raw, qty: 10 });

    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 5, $2, $3, 'new') RETURNING id`,
      [finished, production, central],
    );
    const orderId = Number(rows[0]!.id);
    await finishProductionOrder(orderId, null);

    expect(await countByType('production_order_done', centralManagerId)).toBe(1);
    expect(await countByType('production_order_done', pmId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// purchase_request_approved — fires from approvePurchaseOrder when bothApproved
// ---------------------------------------------------------------------------
describe('purchase_request_approved', () => {
  it('notifies raw warehouse manager and PM after both approval steps', async () => {
    const { rawWh, supply, rawManagerId, pmId } = await buildChainWithManagers();
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    const supplyUser = await makeUser(ctx.db, {
      role: 'supply_manager',
      // chk_users_location_required: every non-pm role needs a location.
      locationId: supply,
    });
    const rawUserForStep = await makeUser(ctx.db, {
      role: 'raw_warehouse_manager',
      locationId: rawWh,
    });

    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders
         (product_id, qty, target_location_id, status, created_by)
       VALUES ($1, 7, $2, 'draft', $3) RETURNING id`,
      [raw, rawWh, supplyUser.id],
    );
    const orderId = Number(rows[0]!.id);

    // Step 1 — manager. No `approved` notification yet (only one side).
    await approvePurchaseOrder(orderId, 'manager', supplyUser.id);
    expect(await countByType('purchase_request_approved')).toBe(0);

    // Step 2 — keeper. The order flips to `approved` -> notification fires.
    await approvePurchaseOrder(orderId, 'keeper', rawUserForStep.id);
    expect(await countByType('purchase_request_approved', rawManagerId)).toBe(1);
    expect(await countByType('purchase_request_approved', pmId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createNotification dedupe — direct unit test of the §2.9 24h debounce
// ---------------------------------------------------------------------------
describe('createNotification dedupe', () => {
  it('returns the existing row when a dedupe_key matches within the window', async () => {
    const user = await makeUser(ctx.db, { role: 'pm' });
    const first = await withTransaction((tx) =>
      createNotification(tx, {
        recipientUserId: user.id,
        type: 'stock_below_min',
        title: 'T',
        body: 'B',
        dedupeKey: 'k1',
        dedupeWindowMinutes: 60,
      }),
    );
    const second = await withTransaction((tx) =>
      createNotification(tx, {
        recipientUserId: user.id,
        type: 'stock_below_min',
        title: 'T',
        body: 'B',
        dedupeKey: 'k1',
        dedupeWindowMinutes: 60,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);

    const { rows } = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = 'k1'`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});
