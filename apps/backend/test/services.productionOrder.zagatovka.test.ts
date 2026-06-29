/**
 * EPIC 5 / ADR-0016 §2.4 — the zagatovka sub-order "done" flow.
 *
 * A production order with stage_role='zagatovka' consumes the BASE (hamir) BOM
 * out of the production floor and outputs the semi zagatovka INTO sex_storage
 * (its target). The FINAL (decoration) lines are NOT touched by a zagatovka
 * order. This is the second half of ADR-0016: the dialog raises the sub-order,
 * the production manager finishes it, and the half-finished cake lands in the
 * sex skladi where the final ukrasheniye order later consumes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock, getQty } from './helpers/fixtures.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('finishProductionOrder — stage_role=zagatovka', () => {
  it('consumes the BASE BOM and outputs the semi into sex_storage', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, parent_id)
         VALUES ($1, 'sex_storage'::location_type, $2) RETURNING id`,
      ['Tort skladi', production],
    );
    const sexStorage = Number(rows[0]?.id);

    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs' });
    const hamir = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const krem = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // decoration (final): the cake = zagatovka + krem.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
         VALUES ($1,$2,1,'decoration'::recipe_stage), ($1,$3,2,'decoration'::recipe_stage)`,
      [cake, zagatovka, krem],
    );
    // base: the zagatovka's hamir.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
         VALUES ($1,$2,5,'base'::recipe_stage)`,
      [zagatovka, hamir],
    );

    // Hamir is staged at the production floor (transferred in by the engine).
    await setStock(ctx.db, { locationId: production, productId: hamir, qty: 100 });

    // A zagatovka sub-order: make 8 zagatovka, output into sex_storage.
    const { rows: oRows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, status, stage_role)
       VALUES ($1, 8, $2, $3, 'new', 'zagatovka') RETURNING id`,
      [zagatovka, production, sexStorage],
    );
    const orderId = Number(oRows[0]?.id);

    const done = await finishProductionOrder(orderId, null);
    expect(done.status).toBe('done');
    expect(done.stage_role).toBe('zagatovka');

    // base hamir consumed: 8 * 5 = 40 out of 100.
    expect(await getQty(ctx.db, production, hamir)).toBe(60);
    // semi zagatovka produced into sex_storage.
    expect(await getQty(ctx.db, sexStorage, zagatovka)).toBe(8);
    // krem (a decoration line) was NEVER touched by the zagatovka order.
    expect(await getQty(ctx.db, production, krem)).toBe(null);
  });
});
