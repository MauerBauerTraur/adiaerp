/**
 * ADR-0015 / sub-task #4 — sex_storage check-first in
 * `advanceCheckProductionInput`.
 *
 * Before this change, the production-input check (CHECK_PRODUCTION_INPUT
 * -> CREATE_PRODUCTION_ORDER) only ever read from the raw warehouse.
 * Now it FIRST consumes whatever sits in the production sex's own
 * sex_storage (the buffer of half-finished goods between the sex floor
 * and the central warehouse), then only requests the shortfall from
 * the raw warehouse.
 *
 * Three cases:
 *   1. sex_storage covers the FULL BOM   -> raw_warehouse untouched.
 *   2. sex_storage covers PART of BOM    -> raw_warehouse covers the rest.
 *   3. sex_storage has NONE of the BOM   -> raw_warehouse covers it all
 *                                           (legacy behaviour).
 *
 * The assertions check stock_movement rows (sources + destinations) and
 * the resulting on-hand qty on each location.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { advance, createRequest } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * Build a chain that has a `sex_storage` child under the production
 * sex (per migration 0022 topology):
 *
 *   raw_wh -> production -> central -> store
 *                       \-> sex_storage  (child of production)
 *
 * Note `sex_storage.parent_id = production` (NOT supply layer): the
 * sex_storage hangs off the production sex floor.
 */
async function chainWithSexStorage(): Promise<{
  rawWh: number;
  production: number;
  sexStorage: number;
  central: number;
  store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  // sex_storage is parented to the production sex (D7 / migration 0022).
  // The fixtures helper's `type` is typed to legacy values; insert directly.
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id)
       VALUES ($1, 'sex_storage'::location_type, $2) RETURNING id`,
    [`Tort skladi ${Math.random().toString(36).slice(2, 8)}`, production],
  );
  const sexStorage = Number(rows[0]?.id);
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: production });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { rawWh, production, sexStorage, central, store };
}

/** Helper: read the count of `transfer` movements between two locations. */
async function countMovements(
  fromId: number | null,
  toId: number,
  productId: number,
): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stock_movements
       WHERE from_location_id IS NOT DISTINCT FROM $1
         AND to_location_id = $2
         AND product_id = $3`,
    [fromId, toId, productId],
  );
  return Number(rows[0]?.n ?? 0);
}

describe('advanceCheckProductionInput — sex_storage check-first', () => {
  it('case 1: sex_storage fully covers BOM — raw_warehouse untouched', async () => {
    const { rawWh, production, sexStorage, central, store } =
      await chainWithSexStorage();
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const krem = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // 1 finished = 2kg krem.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, 2)`,
      [finished, krem],
    );
    // Sex skladi has plenty of krem; raw_wh is loaded BUT must not be touched.
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
    await setStock(ctx.db, { locationId: rawWh, productId: krem, qty: 999 });
    // Central is empty so the request will route through production.
    await setStock(ctx.db, { locationId: central, productId: finished, qty: 0 });
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 0, maxLevel: 0,
    });

    // qty_needed = 5 -> need 10kg krem.
    const created = await createRequest({
      productId: finished, requesterLocationId: store, qtyNeeded: 5, actorUserId: null,
    });
    await advance(created.id, null); // NEW -> CHECK_STORE_SUPPLIER
    await advance(created.id, null); // CHECK_STORE_SUPPLIER (empty) -> CHECK_PRODUCTION_INPUT
    await advance(created.id, null); // CHECK_PRODUCTION_INPUT -> CREATE_PRODUCTION_ORDER

    // 10kg moved from sex_storage to production; 0 from raw_wh.
    expect(await getQty(ctx.db, sexStorage, krem)).toBe(90);
    expect(await getQty(ctx.db, production, krem)).toBe(10);
    expect(await getQty(ctx.db, rawWh, krem)).toBe(999);
    expect(await countMovements(sexStorage, production, krem)).toBe(1);
    expect(await countMovements(rawWh, production, krem)).toBe(0);
  });

  it('case 2: sex_storage partially covers — raw_warehouse covers the rest', async () => {
    const { rawWh, production, sexStorage, central, store } =
      await chainWithSexStorage();
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const hamr = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, 1)`,
      [finished, hamr],
    );
    // Sex skladi has 3kg; need is 5kg; raw_wh covers the 2kg shortfall.
    await setStock(ctx.db, { locationId: sexStorage, productId: hamr, qty: 3 });
    await setStock(ctx.db, { locationId: rawWh, productId: hamr, qty: 10 });
    await setStock(ctx.db, { locationId: central, productId: finished, qty: 0 });
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 0, maxLevel: 0,
    });

    const created = await createRequest({
      productId: finished, requesterLocationId: store, qtyNeeded: 5, actorUserId: null,
    });
    await advance(created.id, null);
    await advance(created.id, null);
    await advance(created.id, null);

    // 3kg from sex_storage, 2kg from raw_wh -> production now holds 5kg.
    expect(await getQty(ctx.db, sexStorage, hamr)).toBe(0);
    expect(await getQty(ctx.db, rawWh, hamr)).toBe(8);
    expect(await getQty(ctx.db, production, hamr)).toBe(5);
    expect(await countMovements(sexStorage, production, hamr)).toBe(1);
    expect(await countMovements(rawWh, production, hamr)).toBe(1);
  });

  it('case 3: sex_storage empty — raw_warehouse covers the full BOM', async () => {
    const { rawWh, production, sexStorage, central, store } =
      await chainWithSexStorage();
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, 0.5)`,
      [finished, flour],
    );
    // sex_storage has NO flour at all — no row, not even zero.
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 20 });
    await setStock(ctx.db, { locationId: central, productId: finished, qty: 0 });
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 0, maxLevel: 0,
    });

    const created = await createRequest({
      productId: finished, requesterLocationId: store, qtyNeeded: 4, actorUserId: null,
    });
    await advance(created.id, null);
    await advance(created.id, null);
    await advance(created.id, null);

    // need = 4 * 0.5 = 2kg from raw_wh; sex_storage untouched (no row).
    expect(await getQty(ctx.db, sexStorage, flour)).toBe(null);
    expect(await getQty(ctx.db, rawWh, flour)).toBe(18);
    expect(await getQty(ctx.db, production, flour)).toBe(2);
    expect(await countMovements(sexStorage, production, flour)).toBe(0);
    expect(await countMovements(rawWh, production, flour)).toBe(1);
  });
});
