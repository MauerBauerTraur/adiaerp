/**
 * ADR-0016 / R3 — `advanceCheckProductionInput` reads the FINAL (decoration)
 * BOM only for a split recipe.
 *
 * When a finished cake's recipe is curated into base (hamir) + decoration
 * (krem + the semi zagatovka), the production-input check must:
 *   - transfer ONLY the decoration lines into production (krem + zagatovka),
 *   - NOT touch the base (hamir) raw materials — those belong to a separate
 *     zagatovka sub-order. Reading base here would double-count the hamir.
 *
 * A legacy flat recipe (all `base`, no decoration) keeps reading every line.
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

async function chainWithSexStorage(): Promise<{
  rawWh: number;
  production: number;
  sexStorage: number;
  central: number;
  store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
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

async function addRecipe(
  productId: number,
  componentId: number,
  qtyPerUnit: number,
  stage: 'base' | 'decoration' | 'assembly',
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, $4::recipe_stage)`,
    [productId, componentId, qtyPerUnit, stage],
  );
}

describe('advanceCheckProductionInput — recipe stage (R3)', () => {
  it('split recipe: only decoration lines transfer; base (hamir) untouched', async () => {
    const { rawWh, production, sexStorage, central, store } = await chainWithSexStorage();

    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs' });
    const krem = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const hamir = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // decoration: 1 cake = 1 zagatovka + 2kg krem.
    await addRecipe(cake, zagatovka, 1, 'decoration');
    await addRecipe(cake, krem, 2, 'decoration');
    // base: the zagatovka's hamir — must NOT be read for the FINAL order.
    await addRecipe(cake, hamir, 5, 'base');

    // sex_storage holds the zagatovka + krem; raw_wh holds hamir (must be left alone).
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 50 });
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
    await setStock(ctx.db, { locationId: rawWh, productId: hamir, qty: 999 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, {
      locationId: store, productId: cake, qty: 0, minLevel: 0, maxLevel: 0,
    });

    // need 4 cakes -> 4 zagatovka + 8kg krem; hamir NOT requested.
    const created = await createRequest({
      productId: cake, requesterLocationId: store, qtyNeeded: 4, actorUserId: null,
    });
    await advance(created.id, null); // NEW -> CHECK_STORE_SUPPLIER
    await advance(created.id, null); // -> CHECK_PRODUCTION_INPUT
    await advance(created.id, null); // -> CREATE_PRODUCTION_ORDER

    // Decoration consumed from sex_storage; hamir raw warehouse untouched.
    expect(await getQty(ctx.db, sexStorage, zagatovka)).toBe(46);
    expect(await getQty(ctx.db, sexStorage, krem)).toBe(92);
    expect(await getQty(ctx.db, production, zagatovka)).toBe(4);
    expect(await getQty(ctx.db, production, krem)).toBe(8);
    // R3 — hamir (base) was NEVER read, so raw_wh stays full and production has none.
    expect(await getQty(ctx.db, rawWh, hamir)).toBe(999);
    expect(await getQty(ctx.db, production, hamir)).toBe(null);
  });

  it('legacy flat recipe (all base, no decoration): every line is read', async () => {
    const { rawWh, production, sexStorage, central, store } = await chainWithSexStorage();
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // No stage given -> defaults to 'base'. No decoration line exists.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, 0.5)`,
      [finished, flour],
    );
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

    // need = 4 * 0.5 = 2kg flour pulled from raw_wh (legacy behaviour intact).
    expect(await getQty(ctx.db, rawWh, flour)).toBe(18);
    expect(await getQty(ctx.db, production, flour)).toBe(2);
    expect(await getQty(ctx.db, sexStorage, flour)).toBe(null);
  });
});
