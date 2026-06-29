/**
 * EPIC 5 / ADR-0016 §6.5 — production dialog service acceptance tests.
 *
 * Covers the channel-agnostic dialog state machine + conditional BOM
 * expansion:
 *   - zagatovka sufficient -> "tayyordan" -> base BOM NOT requested, no doc;
 *   - zagatovka absent -> "0dan" -> base raw sufficient -> zagatovka sub-order
 *     (stage_role='zagatovka', target=sex_storage);
 *   - zagatovka absent -> "0dan" -> base raw short -> purchase request raised;
 *   - decoration (krem) short -> Q2 -> material request;
 *   - invalid option -> INVALID_OPTION; expired -> SESSION_EXPIRED;
 *   - debounce: a second open dialog for the same order is reused;
 *   - cancel + expireStaleDialogs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import {
  answerDialog,
  cancelDialog,
  createDialogForOrder,
  expireStaleDialogs,
  getDialog,
  listOpenDialogs,
} from '../src/services/productionDialog.js';
import { AppError } from '../src/errors/index.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

type Chain = {
  rawWh: number;
  production: number;
  sexStorage: number;
  central: number;
};

async function chain(): Promise<Chain> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id)
       VALUES ($1, 'sex_storage'::location_type, $2) RETURNING id`,
    [`Tort skladi ${Math.random().toString(36).slice(2, 8)}`, production],
  );
  const sexStorage = Number(rows[0]?.id);
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: production });
  return { rawWh, production, sexStorage, central };
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

/** A finished cake whose decoration BOM = zagatovka(semi) + krem; base = hamir. */
async function cakeModel(creamType: 'raw' | 'semi' = 'raw'): Promise<{
  cake: number;
  zagatovka: number;
  krem: number;
  hamir: number;
}> {
  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs' });
  const krem = await makeProduct(ctx.db, { type: creamType, unit: 'kg' });
  const hamir = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  await addRecipe(cake, zagatovka, 1, 'decoration');
  await addRecipe(cake, krem, 2, 'decoration');
  await addRecipe(zagatovka, hamir, 5, 'base');
  return { cake, zagatovka, krem, hamir };
}

describe('productionDialog — create + question', () => {
  it('opens Q1 with "tayyordan/0dan" when zagatovka is sufficient', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka, krem } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });

    const session = await createDialogForOrder({
      productId: cake,
      locationId: production,
      qtyOrdered: 10,
      actorUserId: null,
    });
    expect(session).not.toBeNull();
    expect(session!.state).toBe('AWAITING_SOURCE_DECISION');
    const open = await listOpenDialogs({ allLocations: true });
    const q = open.find((s) => s.id === session!.id)?.question;
    expect(q?.options.map((o) => o.id)).toEqual(['ready', 'zero']);
  });

  it('returns null when the finished product has no semi zagatovka (legacy)', async () => {
    const { production } = await chain();
    const finished = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1,$2,0.5)`,
      [finished, flour],
    );
    const session = await createDialogForOrder({
      productId: finished,
      locationId: production,
      qtyOrdered: 4,
      actorUserId: null,
    });
    expect(session).toBeNull();
  });

  it('debounces: a second create reuses the open dialog', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    const a = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    const b = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    expect(a!.id).toBe(b!.id);
  });
});

describe('productionDialog — answer / conditional BOM expansion', () => {
  it('"tayyordan" with enough cream -> resolves, NO documents, base untouched', async () => {
    const { sexStorage, rawWh, production } = await chain();
    const { cake, zagatovka, krem, hamir } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
    await setStock(ctx.db, { locationId: rawWh, productId: hamir, qty: 999 });

    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 10, actorUserId: null,
    });
    const res = await answerDialog({ dialogId: session!.id, optionId: 'ready', actorUserId: null });
    expect(res.resolved).toBe(true);
    expect(res.created_requests).toHaveLength(0);
    expect(res.session.state).toBe('RESOLVED');
    expect(res.session.decision?.source).toBe('ready');
  });

  it('"0dan" with base raw on hand -> zagatovka sub-order into sex_storage', async () => {
    const { sexStorage, rawWh, production } = await chain();
    const { cake, zagatovka, krem, hamir } = await cakeModel();
    // no zagatovka on hand -> Q1 offers only "zero"
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
    await setStock(ctx.db, { locationId: rawWh, productId: hamir, qty: 999 });

    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 8, actorUserId: null,
    });
    const res = await answerDialog({ dialogId: session!.id, optionId: 'zero', actorUserId: null });
    expect(res.resolved).toBe(true);
    const prod = res.created_requests.find((d) => d.type === 'production');
    expect(prod).toBeDefined();
    expect(prod!.product_id).toBe(zagatovka);
    expect(prod!.qty).toBe(8);

    // The sub-order is a zagatovka targeting sex_storage.
    const { rows } = await ctx.db.query<{
      stage_role: string;
      target_location_id: string;
      qty: string;
    }>(
      `SELECT stage_role, target_location_id, qty FROM production_orders WHERE id = $1`,
      [prod!.id],
    );
    expect(rows[0]?.stage_role).toBe('zagatovka');
    expect(Number(rows[0]?.target_location_id)).toBe(sexStorage);
    expect(Number(rows[0]?.qty)).toBe(8);
  });

  it('"0dan" with base raw SHORT -> purchase request for the shortfall, no sub-order', async () => {
    const { sexStorage, rawWh, production } = await chain();
    const { cake, krem, hamir } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
    await setStock(ctx.db, { locationId: rawWh, productId: hamir, qty: 3 }); // need 8*5=40

    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 8, actorUserId: null,
    });
    const res = await answerDialog({ dialogId: session!.id, optionId: 'zero', actorUserId: null });
    expect(res.resolved).toBe(true);
    expect(res.created_requests.some((d) => d.type === 'production')).toBe(false);
    const purchase = res.created_requests.find((d) => d.type === 'purchase');
    expect(purchase).toBeDefined();
    expect(purchase!.product_id).toBe(hamir);
    expect(purchase!.qty).toBe(40 - 3);

    // It is a real NEW replenishment_request.
    const { rows } = await ctx.db.query<{ status: string; product_id: string }>(
      `SELECT status, product_id FROM replenishment_requests WHERE id = $1`,
      [purchase!.id],
    );
    expect(rows[0]?.status).toBe('NEW');
    expect(Number(rows[0]?.product_id)).toBe(hamir);
  });

  it('cream short -> Q2 -> "buy" raises a material request, then resolves', async () => {
    const { sexStorage, rawWh, production } = await chain();
    const { cake, zagatovka, krem } = await cakeModel('raw');
    // zagatovka sufficient (so "ready" closes phase 1), cream short everywhere.
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 1 });
    await setStock(ctx.db, { locationId: rawWh, productId: krem, qty: 1 }); // need 10*2=20

    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 10, actorUserId: null,
    });
    const q1 = await answerDialog({ dialogId: session!.id, optionId: 'ready', actorUserId: null });
    expect(q1.resolved).toBe(false);
    expect(q1.session.state).toBe('AWAITING_CREAM_CONFIRM');
    // raw cream -> only "buy" offered
    expect(q1.next_question?.options.map((o) => o.id)).toEqual(['buy']);

    const q2 = await answerDialog({ dialogId: session!.id, optionId: 'buy', actorUserId: null });
    expect(q2.resolved).toBe(true);
    const req = q2.created_requests.find((d) => d.product_id === krem);
    expect(req).toBeDefined();
    expect(req!.qty).toBe(20 - 2);
  });

  it('semi cream + "make" -> production sub-request at the sex floor', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka, krem } = await cakeModel('semi');
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 0 });

    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 10, actorUserId: null,
    });
    const q1 = await answerDialog({ dialogId: session!.id, optionId: 'ready', actorUserId: null });
    expect(q1.session.state).toBe('AWAITING_CREAM_CONFIRM');
    expect(q1.next_question?.options.map((o) => o.id)).toEqual(['make', 'buy']);

    const q2 = await answerDialog({ dialogId: session!.id, optionId: 'make', actorUserId: null });
    expect(q2.resolved).toBe(true);
    const req = q2.created_requests.find((d) => d.product_id === krem);
    expect(req).toBeDefined();
    // requested at the sex floor (production location) so it routes via production.
    const { rows } = await ctx.db.query<{ requester_location_id: string }>(
      `SELECT requester_location_id FROM replenishment_requests WHERE id = $1`,
      [req!.id],
    );
    expect(Number(rows[0]?.requester_location_id)).toBe(production);
  });
});

describe('productionDialog — guards + lifecycle', () => {
  it('rejects an invalid option with INVALID_OPTION', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    await expect(
      answerDialog({ dialogId: session!.id, optionId: 'nope', actorUserId: null }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('answering an expired dialog throws SESSION_EXPIRED', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    await ctx.db.query(
      `UPDATE production_dialog_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [session!.id],
    );
    await expect(
      answerDialog({ dialogId: session!.id, optionId: 'ready', actorUserId: null }),
    ).rejects.toBeInstanceOf(AppError);
    const after = await getDialog(session!.id);
    expect(after?.state).toBe('EXPIRED');
  });

  it('cancel flips an open dialog to CANCELLED (idempotent)', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    const c1 = await cancelDialog({ dialogId: session!.id, actorUserId: null });
    expect(c1.state).toBe('CANCELLED');
    const c2 = await cancelDialog({ dialogId: session!.id, actorUserId: null });
    expect(c2.state).toBe('CANCELLED');
  });

  it('expireStaleDialogs stamps EXPIRED on overdue open dialogs', async () => {
    const { sexStorage, production } = await chain();
    const { cake, zagatovka } = await cakeModel();
    await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
    const session = await createDialogForOrder({
      productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
    });
    await ctx.db.query(
      `UPDATE production_dialog_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [session!.id],
    );
    const n = await expireStaleDialogs();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await getDialog(session!.id);
    expect(after?.state).toBe('EXPIRED');
  });
});
