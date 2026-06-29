/**
 * E2E SCENARIO 2 + 5 — EPIC 5: production zagatovka -> ukrasheniye + AI dialog.
 *
 * The most important scenario. A finished cake (tort) is ordered. Its recipe is
 * split into stages (migration 0029):
 *   - base (hamir)        — flour etc, becomes the SEMI zagatovka;
 *   - decoration (krem +  — the zagatovka semi component + cream; this is the
 *     the zagatovka itself)  ukrasheniye pass that yields the FINISHED cake.
 *
 * When the order arrives the AI dialog (production_dialog_sessions, ADR-0016)
 * asks the sex user Q1: "N ta buyurtma, M zagatovka bor — tayyordan yoki 0dan?".
 * We drive all three answer branches end-to-end through the REAL service:
 *
 *   (a) "tayyordan" (ready)  — enough zagatovka on hand. NO hamir/base material
 *       request is raised; only the decoration (krem) is evaluated. Resolves.
 *   (b) "0dan" (zero), base raw sufficient — a zagatovka sub-production-order
 *       is created targeting sex_storage (stage_role='zagatovka'); finishing it
 *       atomically consumes base raw and outputs the semi into sex_storage.
 *   (c) "0dan", base raw SHORT — only the missing base material becomes a
 *       supply (purchase) request; no zagatovka sub-order yet.
 *
 * Invariants asserted:
 *   - 1 atomic: dialog resolve + document creation in one tx;
 *   - 3 no negative stock after finishing the zagatovka sub-order;
 *   - 5 finishing a production order decrements BOM and increments target
 *       atomically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { makeProduct, setStock, getQty } from '../helpers/fixtures.js';
import {
  answerDialog,
  buildQuestion,
  createDialogForOrder,
  getDialog,
} from '../../src/services/productionDialog.js';
import { finishProductionOrder } from '../../src/services/productionOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Insert a location of any type (raw SQL — makeLocation lacks sex_storage). */
async function makeLoc(type: string, parentId: number | null = null): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id) VALUES ($1, $2::location_type, $3) RETURNING id`,
    [`${type} ${Math.random().toString(36).slice(2, 7)}`, type, parentId],
  );
  return Number(rows[0]!.id);
}

async function addRecipe(
  productId: number,
  componentId: number,
  qtyPerUnit: number,
  stage: 'base' | 'decoration' | 'assembly',
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
     VALUES ($1, $2, $3, $4)`,
    [productId, componentId, qtyPerUnit, stage],
  );
}

/**
 * Build the EPIC-5 cake topology:
 *   raw_warehouse -> production(sex) ; sex_storage is a CHILD of production.
 *   central_warehouse is an ancestor of production.
 * Returns ids + the products: cake(finished), zagatovka(semi), flour(raw, base
 * material of the zagatovka), cream(raw, decoration material).
 */
async function buildCakeWorld(): Promise<{
  rawWh: number;
  production: number;
  sexStorage: number;
  central: number;
  cake: number;
  zagatovka: number;
  flour: number;
  cream: number;
}> {
  const rawWh = await makeLoc('raw_warehouse');
  const central = await makeLoc('central_warehouse', rawWh);
  const production = await makeLoc('production', central);
  const sexStorage = await makeLoc('sex_storage', production);

  const cake = await makeProduct(ctx.db, { type: 'finished', name: 'Tort' });
  const zagatovka = await makeProduct(ctx.db, { type: 'semi', name: 'Tort zagatovka' });
  const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
  const cream = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Krem' });

  // Zagatovka (semi) base recipe: 1 zagatovka = 2 kg flour.
  await addRecipe(zagatovka, flour, 2, 'base');
  // Cake decoration recipe: 1 cake = 1 zagatovka (semi) + 0.5 kg cream.
  await addRecipe(cake, zagatovka, 1, 'decoration');
  await addRecipe(cake, cream, 0.5, 'decoration');

  return { rawWh, production, sexStorage, central, cake, zagatovka, flour, cream };
}

describe('SCENARIO 2/5 — AI production dialog: zagatovka -> ukrasheniye', () => {
  it('2a "tayyordan": enough zagatovka on hand -> NO base material request, resolves', async () => {
    const w = await buildCakeWorld();
    // 10 cakes ordered. 20 zagatovka on hand in sex_storage (>= 10 needed).
    await setStock(ctx.db, { locationId: w.sexStorage, productId: w.zagatovka, qty: 20 });
    // Cream on hand so Q2 is not triggered (need 10*0.5 = 5).
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.cream, qty: 50 });

    const dialog = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });
    expect(dialog).not.toBeNull();
    expect(dialog!.state).toBe('AWAITING_SOURCE_DECISION');

    // Q1 must offer a "ready" (tayyordan) option since 20 >= 10.
    const q1 = buildQuestion(dialog!);
    expect(q1!.options.map((o) => o.id)).toContain('ready');

    const res = await answerDialog({ dialogId: dialog!.id, optionId: 'ready', actorUserId: null });
    expect(res.resolved).toBe(true);
    // "tayyordan" + cream sufficient => NO documents (no zagatovka sub-order,
    // no base material request). The hamir BOM is NOT requested.
    expect(res.created_requests).toHaveLength(0);

    // No replenishment request for flour (the base/hamir material).
    const { rows: flourReqs } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM replenishment_requests WHERE product_id = $1',
      [w.flour],
    );
    expect(Number(flourReqs[0]!.n)).toBe(0);

    const after = await getDialog(dialog!.id);
    expect(after!.state).toBe('RESOLVED');
    expect(after!.decision?.source).toBe('ready');
  });

  it('2b "0dan", base raw sufficient -> zagatovka sub-order into sex_storage; finishing it is atomic', async () => {
    const w = await buildCakeWorld();
    // No zagatovka on hand -> must make from zero.
    await setStock(ctx.db, { locationId: w.sexStorage, productId: w.zagatovka, qty: 0 });
    // Flour sufficient: need 10 zagatovka * 2 kg = 20 kg; have 100.
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.flour, qty: 100 });
    // Cream sufficient so the dialog resolves at Q1.
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.cream, qty: 50 });

    const dialog = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });
    expect(dialog!.state).toBe('AWAITING_SOURCE_DECISION');

    const res = await answerDialog({ dialogId: dialog!.id, optionId: 'zero', actorUserId: null });
    expect(res.resolved).toBe(true);

    // A zagatovka sub-production-order was created (type 'production').
    const prod = res.created_requests.filter((d) => d.type === 'production');
    expect(prod).toHaveLength(1);
    expect(prod[0]!.product_id).toBe(w.zagatovka);
    expect(prod[0]!.qty).toBe(10);

    // The DB row is stage_role='zagatovka', target = sex_storage.
    const subOrderId = prod[0]!.id;
    const { rows: po } = await ctx.db.query<{
      stage_role: string;
      target_location_id: string;
      location_id: string;
      status: string;
    }>(
      'SELECT stage_role, target_location_id, location_id, status FROM production_orders WHERE id = $1',
      [subOrderId],
    );
    expect(po[0]!.stage_role).toBe('zagatovka');
    expect(Number(po[0]!.target_location_id)).toBe(w.sexStorage);
    expect(Number(po[0]!.location_id)).toBe(w.production);

    // Stage the base material into the production floor (the replenishment
    // engine normally does this; here we emulate the BOM-in for the sub-order)
    // then FINISH it: invariant 5 — consume base BOM out of production, output
    // the semi zagatovka into sex_storage, atomically.
    await setStock(ctx.db, { locationId: w.production, productId: w.flour, qty: 20 });
    await finishProductionOrder(subOrderId, null);

    // 20 kg flour consumed out of production; 10 zagatovka now in sex_storage.
    expect(await getQty(ctx.db, w.production, w.flour)).toBe(0);
    expect(await getQty(ctx.db, w.sexStorage, w.zagatovka)).toBe(10);

    // Invariant 3 — no negative stock anywhere.
    const { rows: neg } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM stock WHERE qty < 0');
    expect(Number(neg[0]!.n)).toBe(0);
  });

  it('2c "0dan", base raw SHORT -> only the missing base material is requested (no zagatovka sub-order)', async () => {
    const w = await buildCakeWorld();
    await setStock(ctx.db, { locationId: w.sexStorage, productId: w.zagatovka, qty: 0 });
    // Flour SHORT: need 20 kg, have only 5 -> short 15.
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.flour, qty: 5 });
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.cream, qty: 50 });

    const dialog = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });

    const res = await answerDialog({ dialogId: dialog!.id, optionId: 'zero', actorUserId: null });

    // No zagatovka sub-order — base raw is short, so only a purchase/supply
    // request for the FIRST short base material (flour) is raised.
    const prod = res.created_requests.filter((d) => d.type === 'production');
    expect(prod).toHaveLength(0);

    // A replenishment request for flour exists for the shortfall (15 kg).
    const { rows: flourReqs } = await ctx.db.query<{ qty_needed: string }>(
      `SELECT qty_needed FROM replenishment_requests
        WHERE product_id = $1 AND status NOT IN ('CLOSED','CANCELLED')`,
      [w.flour],
    );
    expect(flourReqs).toHaveLength(1);
    expect(Number(flourReqs[0]!.qty_needed)).toBe(15);

    // No zagatovka production order was created.
    const { rows: zagOrders } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM production_orders WHERE product_id = $1`,
      [w.zagatovka],
    );
    expect(Number(zagOrders[0]!.n)).toBe(0);
  });

  it('2d Q2 cream confirm: zagatovka ready BUT cream short -> asks Q2 -> "buy" raises a supply request', async () => {
    const w = await buildCakeWorld();
    await setStock(ctx.db, { locationId: w.sexStorage, productId: w.zagatovka, qty: 20 }); // ready
    // Cream SHORT: need 10*0.5 = 5, have only 1 (sex_storage + raw both checked).
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.cream, qty: 1 });

    const dialog = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });

    const r1 = await answerDialog({ dialogId: dialog!.id, optionId: 'ready', actorUserId: null });
    // Not resolved yet — Q2 (cream confirm) is asked because cream is short.
    expect(r1.resolved).toBe(false);
    expect(r1.next_question).not.toBeNull();
    expect(r1.session.state).toBe('AWAITING_CREAM_CONFIRM');

    const r2 = await answerDialog({ dialogId: dialog!.id, optionId: 'buy', actorUserId: null });
    expect(r2.resolved).toBe(true);
    // A supply request for the cream shortfall (4 kg) was raised.
    const creamDocs = r2.created_requests.filter((d) => d.product_id === w.cream);
    expect(creamDocs).toHaveLength(1);
    expect(creamDocs[0]!.qty).toBe(4);
  });

  it('2e idempotency / debounce: re-creating a dialog for the same order returns the SAME open session', async () => {
    const w = await buildCakeWorld();
    await setStock(ctx.db, { locationId: w.sexStorage, productId: w.zagatovka, qty: 20 });
    await setStock(ctx.db, { locationId: w.rawWh, productId: w.cream, qty: 50 });

    const d1 = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });
    const d2 = await createDialogForOrder({
      productId: w.cake,
      locationId: w.production,
      qtyOrdered: 10,
      actorUserId: null,
    });
    expect(d2!.id).toBe(d1!.id);
  });
});
