/**
 * EPIC 8.4 — nakladnoy generation acceptance tests.
 *
 * Owner scenario: "10 Napoleon sotildi" -> one nakladnoy with a hamir section,
 * a krem section, and an ITOGO grand total per raw component.
 *
 * Coverage:
 *   - flat (legacy, all-base) recipe -> single hamir section + itogo;
 *   - sectioned recipe (base hamir + decoration krem with a `semi` zagatovka)
 *     -> the zagatovka semi is NOT double-counted; itogo sums un/shakar across
 *     both sections; multiplier scales with qty;
 *   - persistence: header + lines stored, audit row written;
 *   - validation: bad qty / bad product rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct } from './helpers/fixtures.js';
import { createNakladnoy, getNakladnoy } from '../src/services/nakladnoy.js';
import { poolRunner } from '../src/lib/audit.js';
import { AppError } from '../src/errors/index.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

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

function lineQty(
  lines: ReadonlyArray<{ section: string; component_product_id: number | null; qty: number }>,
  section: string,
  componentId: number,
): number | undefined {
  return lines.find(
    (l) => l.section === section && l.component_product_id === componentId,
  )?.qty;
}

describe('nakladnoy — flat (legacy) recipe', () => {
  it('produces a single hamir section + itogo equal to it', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Oddiy tort' });
    await addRecipe(cake, flour, 0.5, 'base');
    await addRecipe(cake, sugar, 0.2, 'base');

    const { lines } = await createNakladnoy(
      { source: 'sale', productId: cake, qty: 10, locationId: loc, actorUserId: null },
      undefined,
    );

    // hamir = 10 * per-unit.
    expect(lineQty(lines, 'hamir', flour)).toBe(5);
    expect(lineQty(lines, 'hamir', sugar)).toBe(2);
    // no krem/bezak lines.
    expect(lines.filter((l) => l.section === 'krem')).toHaveLength(0);
    // itogo mirrors hamir (no other section contributes).
    expect(lineQty(lines, 'itogo', flour)).toBe(5);
    expect(lineQty(lines, 'itogo', sugar)).toBe(2);
  });
});

describe('nakladnoy — sectioned recipe (hamir + krem) with semi zagatovka', () => {
  it('does not double-count the zagatovka semi and sums itogo across sections', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar' });
    const milk = await makeProduct(ctx.db, { type: 'raw', unit: 'l', name: 'Sut' });

    // Zagatovka (semi) — the base dough; its recipe is flour + sugar.
    const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs', name: 'Napoleon zagatovka' });
    await addRecipe(zagatovka, flour, 0.4, 'base');
    await addRecipe(zagatovka, sugar, 0.1, 'base');

    // Cream (semi) — its recipe is sugar + milk.
    const cream = await makeProduct(ctx.db, { type: 'semi', unit: 'kg', name: 'Krem' });
    await addRecipe(cream, sugar, 0.3, 'base');
    await addRecipe(cream, milk, 0.5, 'base');

    // Finished Napoleon (sectioned model — the hamir comes from the zagatovka
    // semi, NOT duplicate base lines on the finished product):
    //   decoration stage -> the zagatovka semi (1) + cream (0.2).
    const napoleon = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Napoleon' });
    await addRecipe(napoleon, zagatovka, 1, 'decoration'); // the semi zagatovka itself
    await addRecipe(napoleon, cream, 0.2, 'decoration');

    const qty = 10;
    const { lines } = await createNakladnoy(
      { source: 'sale', productId: napoleon, qty, locationId: loc, actorUserId: null },
      undefined,
    );

    // HAMIR = base lines * qty: flour 0.4*10=4, sugar 0.1*10=1.
    expect(lineQty(lines, 'hamir', flour)).toBe(4);
    expect(lineQty(lines, 'hamir', sugar)).toBe(1);

    // KREM = decoration lines * qty, with the zagatovka semi SKIPPED (no
    // double-count). Only cream expands: cream 0.2*10=2 ->
    //   sugar 2*0.3 = 0.6, milk 2*0.5 = 1.0.
    expect(lineQty(lines, 'krem', sugar)).toBe(0.6);
    expect(lineQty(lines, 'krem', milk)).toBe(1);
    // The zagatovka's flour must NOT appear in krem (it would be the
    // double-count bug).
    expect(lineQty(lines, 'krem', flour)).toBeUndefined();

    // ITOGO = sum across hamir + krem:
    //   flour: 4 (hamir only).
    //   sugar: 1 (hamir) + 0.6 (krem) = 1.6.
    //   milk:  1 (krem only).
    expect(lineQty(lines, 'itogo', flour)).toBe(4);
    expect(lineQty(lines, 'itogo', sugar)).toBeCloseTo(1.6, 4);
    expect(lineQty(lines, 'itogo', milk)).toBe(1);
  });
});

describe('nakladnoy — persistence + audit', () => {
  it('stores header + lines and writes an audit row', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un-p' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort-p' });
    await addRecipe(cake, flour, 1, 'base');

    const { header } = await createNakladnoy(
      { source: 'manual', productId: cake, qty: 3, locationId: loc, actorUserId: null, note: 'test' },
      undefined,
    );
    expect(header.id).toBeGreaterThan(0);
    expect(header.source).toBe('manual');
    expect(header.qty).toBe(3);

    const reread = await getNakladnoy(header.id, poolRunner);
    expect(reread).not.toBeNull();
    expect(lineQty(reread!.lines, 'hamir', flour)).toBe(3);

    const { rows } = await ctx.db.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_log
        WHERE action = 'nakladnoy.create' AND entity_id = $1`,
      [header.id],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });
});

describe('nakladnoy — validation', () => {
  it('rejects non-positive qty', async () => {
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await expect(
      createNakladnoy({ source: 'manual', productId: cake, qty: 0, actorUserId: null }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an invalid product_id', async () => {
    await expect(
      createNakladnoy({ source: 'manual', productId: 0, qty: 1, actorUserId: null }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
