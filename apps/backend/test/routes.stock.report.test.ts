/**
 * GET /api/stock/report — the "Ostatka hisoboti" Harakat view.
 *
 * Regression cover for three defects that only showed up once a single
 * location was picked in the filter sheet:
 *
 *   1. "Ishlab chiqarishda" was hard-wired to the unfiltered report — the
 *      `prod` CTE carried `AND $1 IS NULL`, so every location-scoped report
 *      printed an em dash however many orders were open. It also counted only
 *      `new`, dropping an order the moment work started on it.
 *   2. Stock issued OUT of the location on an internal `transfer`
 *      ("Xomashyo berish") was in no column at all. Because `opening_qty` is
 *      derived backwards from the closing balance, the missing term silently
 *      understated the opening figure and the row stopped adding up.
 *   3. `opening_qty` was clamped with `GREATEST(0, …)`. Stock may legitimately
 *      go negative since migration 0043, so the clamp printed 0 against a real
 *      negative balance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

let pmToken: string;
let rawWh: number;
let sex: number;
let central: number;
let flour: number;
let cake: number;
let sugar: number;

/** Insert a movement dated inside the current month. */
async function move(opts: {
  productId: number;
  from?: number | null;
  to?: number | null;
  qty: number;
  reason: string;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, qty, reason)
     VALUES ($1, $2, $3, $4, $5::movement_reason)`,
    [opts.productId, opts.from ?? null, opts.to ?? null, opts.qty, opts.reason],
  );
}

type ReportRow = {
  product_id: number;
  opening_qty: string;
  in_qty: string;
  used_qty: string;
  sold_qty: string;
  transfer_out_qty: string;
  closing_qty: string;
  in_production_qty: string;
};

async function report(locationId?: number): Promise<ReportRow[]> {
  const qs = locationId === undefined ? '' : `&location_id=${locationId}`;
  const res = await request(ctx.app)
    .get(`/api/stock/report?period=oy${qs}`)
    .set('Authorization', `Bearer ${pmToken}`);
  expect(res.status).toBe(200);
  return res.body as ReportRow[];
}

function rowFor(rows: ReportRow[], productId: number): ReportRow {
  const row = rows.find((r) => Number(r.product_id) === productId);
  if (row === undefined) throw new Error(`product ${productId} missing from report`);
  return row;
}

beforeAll(async () => {
  ctx = await createTestContext();

  const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
  pmToken = pm.token;

  rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'Asosiy ombor' });
  sex = await makeLocation(ctx.db, { type: 'production', name: 'Tort sexi' });
  central = await makeLocation(ctx.db, { type: 'central_warehouse', name: 'Markaziy' });

  flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
  sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar' });
  cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort' });

  // Un: opened the month on 50, bought 100 more into the raw warehouse, then
  // issued 30 on to the sex — 120 left on the shelf.
  await move({ productId: flour, to: rawWh, qty: 100, reason: 'purchase' });
  await move({ productId: flour, from: rawWh, to: sex, qty: 30, reason: 'transfer' });
  await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 120 });
  await setStock(ctx.db, { locationId: sex, productId: flour, qty: 30 });

  // Shakar: 50 bought in but the warehouse only holds 20 — an opening balance
  // of -30 that the old GREATEST(0, …) clamp hid.
  await move({ productId: sugar, to: rawWh, qty: 50, reason: 'purchase' });
  await setStock(ctx.db, { locationId: rawWh, productId: sugar, qty: 20 });

  // Two open orders for Tort, produced in the sex, destined for Markaziy.
  await ctx.db.query(
    `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
     VALUES ($1, 5, $2, $3, 'new'), ($1, 3, $2, $3, 'in_progress')`,
    [cake, sex, central],
  );
});

afterAll(async () => {
  await ctx.dispose();
});

describe('GET /api/stock/report — "Ishlab chiqarishda"', () => {
  it('counts open orders at the warehouse the output is destined for', async () => {
    const row = rowFor(await report(central), cake);
    expect(Number(row.in_production_qty)).toBe(8);
  });

  it('counts the same orders at the sex that produces them', async () => {
    const row = rowFor(await report(sex), cake);
    expect(Number(row.in_production_qty)).toBe(8);
  });

  it('counts them once in the unfiltered report', async () => {
    const row = rowFor(await report(), cake);
    expect(Number(row.in_production_qty)).toBe(8);
  });

  it('leaves it at zero for a location the order never touches', async () => {
    const rows = await report(rawWh);
    const row = rows.find((r) => Number(r.product_id) === cake);
    // No stock and no order here — the product drops out of the report.
    expect(row).toBeUndefined();
  });
});

describe('GET /api/stock/report — raw material reserved for an open order', () => {
  it('shows raw still awaiting issue from the warehouse it sits in', async () => {
    // An open order for Tort in the sex, with 12 kg of Un still to be issued
    // from the raw warehouse ("Xomashyo berish" pending).
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, 4, $2, $3, 'new') RETURNING id`,
      [cake, sex, central],
    );
    const orderId = Number(rows[0]?.id);
    await ctx.db.query(
      `INSERT INTO production_dispatches
         (production_order_id, product_id, product_name, product_unit,
          qty_needed, status, from_location_id, to_location_id)
       VALUES ($1, $2, 'Un', 'kg', 12, 'pending', $3, $4)`,
      [orderId, flour, rawWh, sex],
    );

    const atRaw = rowFor(await report(rawWh), flour);
    expect(Number(atRaw.in_production_qty)).toBe(12);

    // It is only reserved where it physically sits — not at the sex.
    const atSex = rowFor(await report(sex), flour);
    expect(Number(atSex.in_production_qty)).toBe(0);

    // Reserving it does not move stock: the balance is untouched.
    expect(Number(atRaw.closing_qty)).toBe(120);
  });

  it('drops the reservation once the material is issued', async () => {
    await ctx.db.query(
      `UPDATE production_dispatches SET status = 'dispatched' WHERE product_id = $1`,
      [flour],
    );
    const atRaw = rowFor(await report(rawWh), flour);
    expect(Number(atRaw.in_production_qty)).toBe(0);
  });
});

describe('GET /api/stock/report — internal transfers out', () => {
  it('reports what left the location and keeps the row balanced', async () => {
    const row = rowFor(await report(rawWh), flour);

    expect(Number(row.in_qty)).toBe(100);
    expect(Number(row.transfer_out_qty)).toBe(30);
    expect(Number(row.closing_qty)).toBe(120);
    // opening + in - out = closing: 50 + 100 - 30. Drop the transfer term and
    // the derived opening comes out as 20.
    expect(Number(row.opening_qty)).toBe(50);
  });

  it('stays zero in the unfiltered report — an internal move is not a company flow', async () => {
    const row = rowFor(await report(), flour);
    expect(Number(row.transfer_out_qty)).toBe(0);
    // Both halves of the transfer are still on hand company-wide.
    expect(Number(row.closing_qty)).toBe(150);
    expect(Number(row.opening_qty)).toBe(50);
  });
});

describe('GET /api/stock/report — negative opening balance', () => {
  it('reports a negative opening instead of clamping it to zero', async () => {
    const row = rowFor(await report(rawWh), sugar);
    expect(Number(row.closing_qty)).toBe(20);
    expect(Number(row.in_qty)).toBe(50);
    expect(Number(row.opening_qty)).toBe(-30);
  });
});
