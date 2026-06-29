/**
 * Phase-2 F2.3 — `replenishment_purchase_orders` M:N dual-write.
 *
 * `createPurchaseOrderRow` inside the replenishment service writes BOTH:
 *   - the legacy single FK `replenishment_requests.purchase_order_id`
 *     (Phase-3 removes it), and
 *   - one row in the new M:N join table `replenishment_purchase_orders`.
 *
 * The drive path is `CHECK_PRODUCTION_INPUT` with a raw shortage: the
 * engine creates one PO for the missing component. After purchase_received
 * + re-advance, if the BOM still has another shortage, a second PO is
 * created. We expect both POs to be visible in the M:N table even though
 * the legacy single column only tracks the latest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { advance, createRequest } from '../src/services/replenishment.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../src/services/purchaseOrder.js';
import { makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('replenishment_purchase_orders M:N dual-write', () => {
  it('writes one M:N row per purchase order created from a multi-shortage chain', async () => {
    // Topology: store -> central -> supply -> production -> raw.
    const raw = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const prod = await makeLocation(ctx.db, { type: 'production', parentId: raw });
    const sup = await makeLocation(ctx.db, { type: 'supply', parentId: prod });
    const cen = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: sup });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: cen });

    // Finished product with TWO raw components.
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const raw1 = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const raw2 = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
       VALUES ($1, $2, 1), ($1, $3, 1)`,
      [finished, raw1, raw2],
    );

    // No stock anywhere — both raws are short.
    await setStock(ctx.db, { locationId: store, productId: finished, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: raw, productId: raw1, qty: 0, minLevel: 0, maxLevel: 0 });
    await setStock(ctx.db, { locationId: raw, productId: raw2, qty: 0, minLevel: 0, maxLevel: 0 });

    // Create + advance: scan resolution path creates the request and steps.
    const req = await createRequest({
      productId: finished, requesterLocationId: store, qtyNeeded: 5, actorUserId: null,
    });
    await advance(req.id, null); // NEW -> CHECK_STORE_SUPPLIER
    await advance(req.id, null); // CHECK_STORE_SUPPLIER -> CHECK_PRODUCTION_INPUT
    await advance(req.id, null); // CHECK_PRODUCTION_INPUT -> CREATE_PURCHASE_ORDER (raw1 short)

    const { rows: mn1 } = await ctx.db.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id FROM replenishment_purchase_orders
        WHERE replenishment_id = $1
        ORDER BY purchase_order_id`,
      [req.id],
    );
    expect(mn1).toHaveLength(1);

    // Operator approves + receives PO1 (raw1 now in warehouse, raw2 still short).
    const supMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: sup });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: raw });
    const po1Id = Number(mn1[0]!.purchase_order_id);
    await approvePurchaseOrder(po1Id, 'manager', supMgr.id);
    await approvePurchaseOrder(po1Id, 'keeper', rawMgr.id);
    await receivePurchaseOrder(po1Id, rawMgr.id);

    // Advance again — raw1 is now there but raw2 is still missing → PO2 created.
    await advance(req.id, null);

    const { rows: mn2 } = await ctx.db.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id FROM replenishment_purchase_orders
        WHERE replenishment_id = $1
        ORDER BY purchase_order_id`,
      [req.id],
    );
    expect(mn2.length).toBeGreaterThanOrEqual(2);

    // Legacy column tracks the latest PO id (the second one).
    const { rows: legacy } = await ctx.db.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id FROM replenishment_requests WHERE id = $1`,
      [req.id],
    );
    const latest = Number(legacy[0]!.purchase_order_id);
    expect(latest).toBe(Number(mn2[mn2.length - 1]!.purchase_order_id));

    // First PO is still in the M:N table — the dual-write keeps the full history.
    const ids = mn2.map((r) => Number(r.purchase_order_id));
    expect(ids).toContain(po1Id);
  });
});
