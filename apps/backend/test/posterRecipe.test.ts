/**
 * Shared Poster recipe (BOM) helpers — `src/integrations/poster/posterRecipe.ts`.
 *
 * These cover the pieces the hourly sync, the preview endpoint and the
 * "re-sync from Poster" endpoint share:
 *   - normaliseName / normaliseQty (pure);
 *   - resolveComponentProduct — id-space priority + name verification (the
 *     fix for Poster product_id / ingredient_id collisions), one rule for
 *     every path; the fallback order depends on the tech-card SOURCE;
 *   - buildComponents — BRUTTO-based qty per unit of yield;
 *   - findPosterRecipe — prepack by product_id, ingredient_id, then name;
 *     menu by product_id, then name (type-aware);
 *   - writePosterRecipe — stage preservation only for an unchanged
 *     composition (review B3), judged by what production actually reads.
 *
 * Scenarios E1–E5 come from the code review's scratch experiments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import type { PosterClient, PosterMenuProductFull, PosterMenuProductRow, PosterPrepack } from '../src/integrations/poster/client.js';
import { withTransaction } from '../src/db/index.js';
import { findZagatovkaComponent, readFinalBom } from '../src/services/bom.js';
import {
  buildComponents,
  findPosterRecipe,
  normaliseName,
  normaliseQty,
  planRecipeRows,
  prepackYieldKg,
  round4,
  resolveComponentProduct,
  writePosterRecipe,
} from '../src/integrations/poster/posterRecipe.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM products');
});

async function mkProduct(
  name: string,
  opts: { type?: string; unit?: string; ppid?: number | null; ping?: number | null; active?: boolean } = {},
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, opts.type ?? 'semi', opts.unit ?? 'kg', opts.ppid ?? null, opts.ping ?? null, opts.active ?? true],
  );
  return Number(rows[0]!.id);
}

const PREPACK = { order: 'by-structure-type' } as const;
const MENU = { order: 'ingredient-first' } as const;

describe('normaliseName', () => {
  it('lowercases, trims, maps ё→е and collapses whitespace', () => {
    expect(normaliseName('  Медовик   Шок  КРЕМ ')).toBe('медовик шок крем');
    expect(normaliseName('Крем Ёлочный')).toBe('крем елочный');
  });

  it('strips a trailing п/ф marker, with or without brackets', () => {
    expect(normaliseName('Крем заварной (п/ф)')).toBe('крем заварной');
    expect(normaliseName('КРЕМ ЗАВАРНОЙ (П/Ф)')).toBe('крем заварной');
    expect(normaliseName('крем заварной п/ф')).toBe('крем заварной');
    expect(normaliseName('крем заварной(п/ф)')).toBe('крем заварной');
  });

  it('returns an empty string for missing input', () => {
    expect(normaliseName(undefined)).toBe('');
    expect(normaliseName(null)).toBe('');
    expect(normaliseName('   ')).toBe('');
  });
});

describe('normaliseQty / prepackYieldKg', () => {
  it('converts g→kg and ml→l, keeps same units, rejects non-positive values', () => {
    expect(normaliseQty('g', 'kg', 63.88)).toBeCloseTo(0.06388, 9);
    expect(normaliseQty('ml', 'l', '500')).toBeCloseTo(0.5, 9);
    expect(normaliseQty('kg', 'kg', 2)).toBe(2);
    expect(normaliseQty('kg', 'g', 0.5)).toBe(500);
    expect(normaliseQty('g', 'kg', 0)).toBe(0);
    expect(normaliseQty('g', 'kg', 'abc')).toBe(0);
    expect(normaliseQty('g', 'kg', undefined)).toBe(0);
  });

  it('reads Poster `out` as grams and falls back to a 1-unit batch', () => {
    expect(prepackYieldKg(1000)).toBe(1);
    expect(prepackYieldKg('2500')).toBe(2.5);
    expect(prepackYieldKg(0)).toBe(1);
    expect(prepackYieldKg(undefined)).toBe(1);
  });
});

describe('resolveComponentProduct — id spaces', () => {
  it('structure_type=2: prefers the poster_product_id row when its name matches', async () => {
    const p1 = await mkProduct('медовик шок крем', { ppid: 1102 });
    await mkProduct('медовик сметанный крем', { ping: 1102 });
    const r = await resolveComponentProduct(1102, 'Медовик шок крем', '2', PREPACK);
    expect(r?.id).toBe(p1);
    expect(r?.matchedBy).toBe('id+name');
    expect(r?.nameMismatch).toBe(false);
  });

  it('structure_type=2: takes the other id space when only it matches by name', async () => {
    await mkProduct('совсем другой крем', { ppid: 1103 });
    const p2 = await mkProduct('медовик шок крем', { ping: 1103 });
    const r = await resolveComponentProduct(1103, 'медовик шок крем', '2', PREPACK);
    expect(r?.id).toBe(p2);
    expect(r?.matchedBy).toBe('id+name');
  });

  it('structure_type=1 (mirror): ingredient_id row mismatches, product_id row matches by name', async () => {
    await mkProduct('сахар', { type: 'raw', ping: 55 });
    const other = await mkProduct('какао порошок', { type: 'raw', ppid: 55 });
    const r = await resolveComponentProduct(55, 'Какао порошок', '1', MENU);
    expect(r?.id).toBe(other);
    expect(r?.matchedBy).toBe('id+name');
  });

  it('E1: names match neither id space — prepack source falls back product-first', async () => {
    const a = await mkProduct('AAA product-space row', { ppid: 1102 });
    await mkProduct('BBB ingredient-space row', { ping: 1102 });
    const r = await resolveComponentProduct(1102, 'zzz poster name', '2', PREPACK);
    expect(r?.id).toBe(a);
    expect(r?.matchedBy).toBe('id');
    expect(r?.nameMismatch).toBe(true);
  });

  it('E1: names match neither id space — menu source keeps the OLD ingredient-first fallback', async () => {
    await mkProduct('AAA product-space row', { ppid: 1102 });
    const b = await mkProduct('BBB ingredient-space row', { ping: 1102 });
    const r = await resolveComponentProduct(1102, 'zzz poster name', '2', MENU);
    expect(r?.id).toBe(b);
    expect(r?.matchedBy).toBe('id');
    expect(r?.nameMismatch).toBe(true);
  });

  it('prefers a type-compatible row when both id candidates match by name', async () => {
    await mkProduct('крем', { type: 'finished', unit: 'pcs', ping: 77 });
    const semi = await mkProduct('крем', { type: 'semi', ppid: 77 });
    const r = await resolveComponentProduct(77, 'крем', '2', MENU);
    expect(r?.id).toBe(semi);
    expect(r?.matchedBy).toBe('id+name');
  });

  it('type-2 ids from the INGREDIENT space still resolve the медовик components', async () => {
    const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101, ping: 2501 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102, ping: 2502 });
    await mkProduct('бисквит ванильный', { ppid: 2502 }); // unrelated product-space row
    expect((await resolveComponentProduct(2501, 'медовик шок черный тесто', '2', PREPACK))?.id).toBe(testo);
    const k = await resolveComponentProduct(2502, 'медовик шок крем', '2', PREPACK);
    expect(k?.id).toBe(krem);
    expect(k?.matchedBy).toBe('id+name');
  });
});

describe('resolveComponentProduct — name fallback never overrides an id binding', () => {
  it('keeps the id candidate when its name differs and names the name candidate', async () => {
    const byId = await mkProduct('неверное имя', { type: 'raw', ping: 70 });
    const byName = await mkProduct('Сливки 33%', { type: 'raw' });
    const r = await resolveComponentProduct(70, 'сливки 33%', '1', MENU);
    expect(r?.id).toBe(byId);
    expect(r?.matchedBy).toBe('id');
    expect(r?.nameMismatch).toBe(true);
    expect(r?.nameCandidate).toEqual({ id: byName, name: 'Сливки 33%' });
  });

  it('E2: a finished product never wins by name over the semi id candidate', async () => {
    const semi = await mkProduct('Г/П МЕДОВИК', { ppid: 978, ping: 2402 });
    await mkProduct('Медовик', { type: 'finished', ppid: 50, unit: 'pcs' });
    const r = await resolveComponentProduct(978, 'медовик', '2', PREPACK);
    expect(r?.id).toBe(semi);
    expect(r?.matchedBy).toBe('id');
    expect(r?.nameMismatch).toBe(true);
    // The finished product is not type-compatible, so it is not even a candidate.
    expect(r?.nameCandidate).toBeNull();
  });

  it('binds by name only when no id candidate exists at all', async () => {
    const byName = await mkProduct('Ванилин', { type: 'raw' });
    const r = await resolveComponentProduct(9999, 'ванилин', '1', MENU);
    expect(r?.id).toBe(byName);
    expect(r?.matchedBy).toBe('name');
    expect(r?.nameMismatch).toBe(false);
  });

  it('a name-only binding accepts raw or semi for structure_type=1', async () => {
    const semi = await mkProduct('Крем заварной (п/ф)', { type: 'semi' });
    const r = await resolveComponentProduct(9999, 'крем заварной', '1', MENU);
    expect(r?.id).toBe(semi);
  });

  it('a name-only binding never takes finished / gp products', async () => {
    await mkProduct('Наполеон', { type: 'finished', unit: 'pcs' });
    await mkProduct('Медовик', { type: 'gp', unit: 'pcs' });
    expect(await resolveComponentProduct(9999, 'наполеон', '1', MENU)).toBeNull();
    expect(await resolveComponentProduct(9999, 'медовик', '2', PREPACK)).toBeNull();
  });

  it('structure_type=2 name-only takes semi only (raw with the same name is ignored)', async () => {
    await mkProduct('крем чиз', { type: 'raw' });
    const semi = await mkProduct('Крем чиз', { type: 'semi' });
    expect((await resolveComponentProduct(9999, 'крем чиз', '2', PREPACK))?.id).toBe(semi);
  });

  it('skips an ambiguous name match (two rows of the preferred type)', async () => {
    await mkProduct('крем чиз', { type: 'semi' });
    await mkProduct('Крем чиз', { type: 'semi' });
    expect(await resolveComponentProduct(9999, 'крем чиз', '2', PREPACK)).toBeNull();
  });

  it('ignores inactive products in the name lookup', async () => {
    await mkProduct('Ванилин', { type: 'raw', active: false });
    expect(await resolveComponentProduct(9999, 'ванилин', '1', MENU)).toBeNull();
  });

  it('an empty Poster name never counts as a mismatch', async () => {
    const raw = await mkProduct('мука', { type: 'raw', ping: 100 });
    const r = await resolveComponentProduct(100, '', '1', MENU);
    expect(r?.id).toBe(raw);
    expect(r?.matchedBy).toBe('id');
    expect(r?.nameMismatch).toBe(false);
  });

  it('returns null when nothing matches', async () => {
    expect(await resolveComponentProduct(12345, 'нет такого', '1', MENU)).toBeNull();
  });
});

/** The real prepack from the owner's screenshots (Г/П МЕДОВИК ШОК ЧЕРНЫЙ). */
const MEDOVIK_LINES = [
  {
    structure_id: '1',
    ingredient_id: '1101',
    structure_unit: 'g',
    structure_type: '2',
    structure_brutto: 115.3,
    structure_netto: 0,
    ingredient_name: 'медовик шок черный тесто',
    ingredient_unit: 'kg',
  },
  {
    structure_id: '2',
    ingredient_id: '1102',
    structure_unit: 'g',
    structure_type: '2',
    structure_brutto: 63.88,
    structure_netto: 1000,
    ingredient_name: 'медовик шок крем',
    ingredient_unit: 'kg',
  },
];

describe('buildComponents', () => {
  it('uses BRUTTO per unit of yield (the real медовик case: крем is 0.06388, not 1.0)', async () => {
    const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    const r = await buildComponents(MEDOVIK_LINES, 1, PREPACK);
    expect(r.notFound).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.components).toHaveLength(2);
    const t = r.components.find((c) => c.componentProductId === testo);
    const k = r.components.find((c) => c.componentProductId === krem);
    expect(t?.qtyPerUnit).toBeCloseTo(0.1153, 9);
    expect(t?.brutto).toBeCloseTo(0.1153, 9);
    expect(k?.qtyPerUnit).toBeCloseTo(0.06388, 9);
    expect(k?.brutto).toBeCloseTo(0.06388, 9);
    expect(k?.name).toBe('медовик шок крем');
    expect(k?.unit).toBe('kg');
  });

  it('divides by the batch yield and falls back to netto only when brutto is 0', async () => {
    const flour = await mkProduct('мука', { type: 'raw', ping: 100 });
    const r = await buildComponents(
      [
        { ingredient_id: '100', structure_unit: 'g', structure_type: '1', structure_brutto: 0, structure_netto: 500, ingredient_name: 'мука', ingredient_unit: 'kg' },
      ],
      2,
      PREPACK,
    );
    expect(r.components[0]?.componentProductId).toBe(flour);
    expect(r.components[0]?.qtyPerUnit).toBeCloseTo(0.25, 9);
  });

  it('skips ingredient_id <= 0, reports unresolved names, merges duplicates with a warning', async () => {
    const flour = await mkProduct('мука', { type: 'raw', ping: 100 });
    const r = await buildComponents(
      [
        { ingredient_id: '0', structure_unit: 'g', structure_type: '1', structure_brutto: 10, structure_netto: 10, ingredient_name: 'пустой', ingredient_unit: 'kg' },
        { ingredient_id: '100', structure_unit: 'g', structure_type: '1', structure_brutto: 100, structure_netto: 100, ingredient_name: 'мука', ingredient_unit: 'kg' },
        { ingredient_id: '100', structure_unit: 'g', structure_type: '1', structure_brutto: 50, structure_netto: 50, ingredient_name: 'мука', ingredient_unit: 'kg' },
        { ingredient_id: '404', structure_unit: 'g', structure_type: '1', structure_brutto: 5, structure_netto: 5, ingredient_name: 'Кардамон', ingredient_unit: 'kg' },
      ],
      1,
      MENU,
    );
    expect(r.notFound).toEqual(['Кардамон']);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.componentProductId).toBe(flour);
    expect(r.components[0]?.qtyPerUnit).toBeCloseTo(0.15, 9);
    expect(r.duplicates).toEqual([{ componentProductId: flour, name: 'мука', lines: 2 }]);
    expect(r.warnings).toEqual(["ERP: 'мука' Poster'da 2 ta qatorda keldi — miqdorlar qo'shildi"]);
  });

  it('reports a name mismatch as a warning but keeps the id candidate', async () => {
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    const r = await buildComponents(
      [{ ...MEDOVIK_LINES[1]!, ingredient_name: 'медовик крем шоколадный' }],
      1,
      PREPACK,
    );
    expect(r.components[0]?.componentProductId).toBe(krem);
    expect(r.components[0]?.nameMismatch).toBe(true);
    expect(r.warnings).toEqual([
      "Poster: 'медовик крем шоколадный' → ERP: 'медовик шок крем' (nomi mos emas)",
    ]);
  });

  it('names the name candidate in the mismatch warning', async () => {
    await mkProduct('медовик шок крем', { ppid: 1102 });
    await mkProduct('Медовик крем шоколадный', { type: 'semi' });
    const r = await buildComponents(
      [{ ...MEDOVIK_LINES[1]!, ingredient_name: 'медовик крем шоколадный' }],
      1,
      PREPACK,
    );
    expect(r.warnings).toEqual([
      "Poster: 'медовик крем шоколадный' → ERP: 'медовик шок крем' (nomi mos emas; nom bo'yicha nomzod: 'Медовик крем шоколадный')",
    ]);
  });

  it('flags a name-only binding', async () => {
    const vanilin = await mkProduct('Ванилин', { type: 'raw' });
    const r = await buildComponents(
      [{ ingredient_id: '9999', structure_unit: 'g', structure_type: '1', structure_brutto: 1, structure_netto: 1, ingredient_name: 'ванилин', ingredient_unit: 'kg' }],
      1,
      MENU,
    );
    expect(r.components[0]?.componentProductId).toBe(vanilin);
    expect(r.components[0]?.matchedBy).toBe('name');
    expect(r.warnings).toEqual([
      "Poster: 'ванилин' → ERP: 'Ванилин' (faqat nomi bo'yicha bog'landi — Poster ID 9999 ERP'da yo'q)",
    ]);
  });

  it('drops a component that resolves to the parent itself (self-reference)', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    const r = await buildComponents(
      [
        { ...MEDOVIK_LINES[1]! },
        { ...MEDOVIK_LINES[0]!, ingredient_id: '978', ingredient_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ' },
      ],
      1,
      { ...PREPACK, parentProductId: parent },
    );
    expect(r.components.map((c) => c.componentProductId)).toEqual([krem]);
    expect(r.warnings).toEqual(["Poster: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ' — mahsulotning o'zi, o'tkazib yuborildi"]);
  });
});

/** A minimal in-memory stand-in for the Poster client's read methods. */
function fakeClient(data: {
  prepacks?: PosterPrepack[];
  products?: PosterMenuProductRow[];
  full?: Record<number, PosterMenuProductFull>;
}): Pick<PosterClient, 'getPrepacks' | 'getProducts' | 'getProduct'> {
  return {
    getPrepacks: () => Promise.resolve(data.prepacks ?? []),
    getProducts: () => Promise.resolve(data.products ?? []),
    getProduct: (id: number) => Promise.resolve(data.full?.[id] ?? null),
  };
}

const MEDOVIK_PREPACK: PosterPrepack = {
  product_id: '978',
  ingredient_id: '2402',
  product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
  out: 1000,
  ingredients: MEDOVIK_LINES,
};

function erpRef(over: Partial<{
  name: string; type: string; batch_yield: number | null;
  poster_product_id: number | null; poster_ingredient_id: number | null;
}> = {}) {
  return {
    id: 1,
    name: over.name ?? 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
    type: over.type ?? 'semi',
    batch_yield: over.batch_yield ?? null,
    poster_product_id: over.poster_product_id === undefined ? 978 : over.poster_product_id,
    poster_ingredient_id: over.poster_ingredient_id === undefined ? 2402 : over.poster_ingredient_id,
  };
}

describe('findPosterRecipe', () => {
  it('matches a prepack by poster_product_id even when the ERP ingredient id differs', async () => {
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK] }),
      erpRef({ poster_ingredient_id: 7777 }),
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.source).toBe('prepack');
    expect(r.posterProductId).toBe(978);
    expect(r.posterName).toBe('Г/П МЕДОВИК ШОК ЧЕРНЫЙ');
    expect(r.batchYieldKg).toBe(1);
    expect(r.lines).toHaveLength(2);
  });

  it('matches a prepack by ingredient_id when the product id is unknown', async () => {
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK] }),
      erpRef({ poster_product_id: null }),
    );
    expect(r.found && r.source).toBe('prepack');
  });

  it('a semi ERP product matches a prepack by unique normalised name', async () => {
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK] }),
      erpRef({ poster_product_id: null, poster_ingredient_id: null, name: 'г/п медовик  шок черный' }),
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.posterProductId).toBe(978);
  });

  it('S6: a finished ERP product never borrows a prepack by name', async () => {
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK] }),
      erpRef({ type: 'finished', poster_product_id: null, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(false);
  });

  it('S6: a semi ERP product never borrows a menu product by name', async () => {
    const menuFull: PosterMenuProductFull = {
      product_id: '802', product_name: 'Наполеон', type: '2', ingredients: [MEDOVIK_LINES[0]!],
    };
    const r = await findPosterRecipe(
      fakeClient({
        products: [{ product_id: '802', product_name: 'НАПОЛЕОН', type: '2' }],
        full: { 802: menuFull },
      }),
      erpRef({ name: 'Наполеон', type: 'semi', poster_product_id: null, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(false);
  });

  it('falls back to menu.getProduct with a yield of 1 for a finished product', async () => {
    const menuFull: PosterMenuProductFull = {
      product_id: '800',
      product_name: 'Торт',
      type: '2',
      ingredients: [MEDOVIK_LINES[0]!],
    };
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK], full: { 800: menuFull } }),
      erpRef({ name: 'Торт', type: 'finished', poster_product_id: 800, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.source).toBe('menu');
    expect(r.batchYieldKg).toBe(1);
  });

  it('keeps the stored batch_yield for a semi product that only exists in the menu', async () => {
    const menuFull: PosterMenuProductFull = {
      product_id: '801',
      product_name: 'Крем',
      type: '2',
      ingredients: [MEDOVIK_LINES[0]!],
    };
    const r = await findPosterRecipe(
      fakeClient({ full: { 801: menuFull } }),
      erpRef({ name: 'Крем', type: 'semi', batch_yield: 2.5, poster_product_id: 801, poster_ingredient_id: null }),
    );
    expect(r.found && r.batchYieldKg).toBe(2.5);
  });

  it('a finished ERP product finds a menu product by unique name when it has no Poster ids', async () => {
    const menuFull: PosterMenuProductFull = {
      product_id: '802',
      product_name: 'Наполеон',
      type: '2',
      ingredients: [MEDOVIK_LINES[0]!],
    };
    const r = await findPosterRecipe(
      fakeClient({
        products: [{ product_id: '802', product_name: 'НАПОЛЕОН', type: '2' }],
        full: { 802: menuFull },
      }),
      erpRef({ name: 'Наполеон', type: 'finished', poster_product_id: null, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.source).toBe('menu');
    expect(r.posterProductId).toBe(802);
  });

  it('returns a reason when nothing matches', async () => {
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [MEDOVIK_PREPACK] }),
      erpRef({ name: 'Nomalum', poster_product_id: null, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('does not fall back to a same-named prepack once Poster confirmed the menu product (empty BOM)', async () => {
    const menuEmpty: PosterMenuProductFull = {
      product_id: '803',
      product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
      type: '3',
      ingredients: [],
    };
    const r = await findPosterRecipe(
      fakeClient({ prepacks: [{ ...MEDOVIK_PREPACK, product_id: '979', ingredient_id: '2403' }], full: { 803: menuEmpty } }),
      erpRef({ type: 'finished', poster_product_id: 803, poster_ingredient_id: null }),
    );
    expect(r.found).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// writePosterRecipe — stages (review B3) and the storage precision (E5)
// -----------------------------------------------------------------------------

async function stagesOf(productId: number): Promise<Array<{ component: number; stage: string; qty: number }>> {
  const { rows } = await ctx.db.query<{ component_product_id: string; stage: string; qty: string }>(
    `SELECT component_product_id, stage::text AS stage, qty_per_unit::text AS qty
       FROM recipes WHERE product_id = $1 ORDER BY component_product_id, stage`,
    [productId],
  );
  return rows.map((r) => ({ component: Number(r.component_product_id), stage: r.stage, qty: Number(r.qty) }));
}

describe('R1: round4 == PostgreSQL NUMERIC(14,4) rounding of what node-pg sends', () => {
  /** What PG stores for a JS number: node-pg sends String(n), NUMERIC rounds half away from zero. */
  async function pgRound(values: readonly number[]): Promise<number[]> {
    const { rows } = await ctx.db.query<{ r: string }>(
      `SELECT round(v::numeric, 4)::text AS r FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i`,
      [values.map((v) => String(v))],
    );
    return rows.map((x) => Number(x.r));
  }

  it('the review cases 1.45 / 3.55 / 8.45 / 10.45 g per kg round exactly like PG', async () => {
    // node-pg sends String(n): 1.45/1000 -> "0.00145" (PG: up to 0.0015) but
    // 3.55/1000 -> "0.0035499999999999998" (PG: down to 0.0035). A float-based
    // Math.round(n * 1e4) gets 1.45/8.45/10.45 wrong one way and a
    // toPrecision() fix gets 3.55 wrong the other way — only rounding the
    // decimal string PG receives matches in every case.
    const values = [1.45, 3.55, 8.45, 10.45].map((g) => g / 1000);
    expect(values.map(round4)).toEqual([0.0015, 0.0035, 0.0085, 0.0105]);
    expect(await pgRound(values)).toEqual(values.map(round4));
  });

  it('agrees with PG on a sweep of gram / batch-yield quantities (incl. exponent notation)', async () => {
    const values: number[] = [];
    for (let g = 1; g <= 3000; g += 1) {
      values.push(g / 100 / 1000, (g / 100) / 1000 / 2.5, (g / 100) / 1000 / 0.75);
    }
    values.push(1e-7, 4.9e-5, 5e-5, 0.00015, 1234.56785, 0.12345, 2.00005);
    expect(await pgRound(values)).toEqual(values.map(round4));
  });

  it('planRecipeRows already rounds every row it will write', () => {
    const plan = planRecipeRows([], [{ componentProductId: 1, qtyPerUnit: 1.45 / 1000, brutto: 8.45 / 1000 }], 99);
    expect(plan.rows).toEqual([{ component_product_id: 1, stage: 'base', qty_per_unit: 0.0015, brutto: 0.0085 }]);
  });
});

describe('R6: only real stage information counts as a stage reset', () => {
  const prev = (stage: string) => [{ component_product_id: 1, qty_per_unit: 0.5, brutto: 0.5, stage }];
  const next = [{ componentProductId: 1, qtyPerUnit: 0.5 }, { componentProductId: 2, qtyPerUnit: 0.1 }];

  it('base / dough / other are all hamir: a changed composition is never a reset', () => {
    for (const stage of ['base', 'dough', 'other']) {
      expect(planRecipeRows(prev(stage), next, 99).stagesReset).toBe(false);
    }
  });

  it('decoration / cream / assembly are real splits: a changed composition is a reset', () => {
    for (const stage of ['decoration', 'cream', 'assembly']) {
      expect(planRecipeRows(prev(stage), next, 99).stagesReset).toBe(true);
    }
  });
});

describe('writePosterRecipe — stages', () => {
  async function napoleon() {
    const cake = await mkProduct('Napoleon', { type: 'finished', unit: 'pcs' });
    const flour = await mkProduct('Un', { type: 'raw' });
    const krem = await mkProduct('Krem', { type: 'semi' });
    const zg = await mkProduct('z/g Napoleon', { type: 'semi' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage) VALUES
        ($1,$2,0.5,0.5,'base'), ($1,$3,0.3,0.3,'decoration'), ($1,$4,1,1,'decoration')`,
      [cake, flour, krem, zg],
    );
    return { cake, flour, krem, zg };
  }

  it('keeps the stages when the composition is unchanged — production still reads the split', async () => {
    const { cake, flour, krem, zg } = await napoleon();
    const zBefore = await withTransaction((tx) => findZagatovkaComponent(tx, cake));
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [
        { componentProductId: flour, qtyPerUnit: 0.6 },
        { componentProductId: krem, qtyPerUnit: 0.4 },
        { componentProductId: zg, qtyPerUnit: 1 },
      ]),
    );
    expect(r.stagesReset).toBe(false);
    const finalBom = await withTransaction((tx) => readFinalBom(tx, cake));
    expect(finalBom.map((l) => l.component_product_id).sort()).toEqual([krem, zg].sort());
    expect(finalBom.find((l) => l.component_product_id === krem)?.qty_per_unit).toBeCloseTo(0.4, 4);
    const zAfter = await withTransaction((tx) => findZagatovkaComponent(tx, cake));
    expect(zAfter?.component_product_id).toBe(zBefore?.component_product_id);
    expect(zAfter).not.toBeNull();
  });

  it('E3: a changed composition resets every line to base, so nothing is silently dropped', async () => {
    const { cake, flour, krem } = await napoleon();
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [
        { componentProductId: flour, qtyPerUnit: 0.5 },
        { componentProductId: krem, qtyPerUnit: 0.3 },
      ]),
    );
    expect(r.stagesReset).toBe(true);
    expect((await stagesOf(cake)).every((l) => l.stage === 'base')).toBe(true);
    // Legacy flat recipe: the final order consumes EVERY line (no hybrid).
    const finalBom = await withTransaction((tx) => readFinalBom(tx, cake));
    expect(finalBom.map((l) => l.component_product_id).sort()).toEqual([flour, krem].sort());
    expect(await withTransaction((tx) => findZagatovkaComponent(tx, cake))).toBeNull();
  });

  it('a NEW component next to preserved decoration lines is not stranded in base (reset instead)', async () => {
    const { cake, flour, krem, zg } = await napoleon();
    const sugar = await mkProduct('Shakar', { type: 'raw' });
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [
        { componentProductId: flour, qtyPerUnit: 0.5 },
        { componentProductId: krem, qtyPerUnit: 0.3 },
        { componentProductId: zg, qtyPerUnit: 1 },
        { componentProductId: sugar, qtyPerUnit: 0.1 },
      ]),
    );
    expect(r.stagesReset).toBe(true);
    const finalBom = await withTransaction((tx) => readFinalBom(tx, cake));
    expect(finalBom.map((l) => l.component_product_id)).toContain(sugar);
  });

  it('E4: a component split across stages keeps the split, Poster total distributed proportionally', async () => {
    const cake = await mkProduct('Tort', { type: 'finished', unit: 'pcs' });
    const flour = await mkProduct('Un2', { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage) VALUES
        ($1,$2,0.5,0.5,'decoration'), ($1,$2,0.1,0.1,'base')`,
      [cake, flour],
    );
    // Poster now says 1.2 in total -> 5/6 and 1/6 of it.
    const r = await withTransaction((tx) => writePosterRecipe(tx, cake, [{ componentProductId: flour, qtyPerUnit: 1.2 }]));
    expect(r.stagesReset).toBe(false);
    expect(await stagesOf(cake)).toEqual([
      { component: flour, stage: 'base', qty: 0.2 },
      { component: flour, stage: 'decoration', qty: 1.0 },
    ]);
    const finalBom = await withTransaction((tx) => readFinalBom(tx, cake));
    expect(finalBom).toEqual([{ component_product_id: flour, qty_per_unit: 1.0 }]);
  });

  it('a split part that would fall below 0.0001 falls back to a reset', async () => {
    const cake = await mkProduct('Tort7', { type: 'finished', unit: 'pcs' });
    const flour = await mkProduct('Un7', { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage) VALUES
        ($1,$2,0.9,0.9,'decoration'), ($1,$2,0.1,0.1,'base')`,
      [cake, flour],
    );
    // 0.0005 total -> base part 0.00005 < 0.0001.
    const r = await withTransaction((tx) => writePosterRecipe(tx, cake, [{ componentProductId: flour, qtyPerUnit: 0.0005 }]));
    expect(r.stagesReset).toBe(true);
    expect(await stagesOf(cake)).toEqual([{ component: flour, stage: 'base', qty: 0.0005 }]);
  });

  it('refuseStageReset: nothing is written when the write would drop a split', async () => {
    const { cake, flour, krem } = await napoleon();
    const before = await stagesOf(cake);
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [{ componentProductId: flour, qtyPerUnit: 0.5 }, { componentProductId: krem, qtyPerUnit: 0.3 }], { refuseStageReset: true }),
    );
    expect(r.refused).toBe(true);
    expect(r.applied).toBe(0);
    expect(await stagesOf(cake)).toEqual(before);
  });

  it('an all-base recipe with a new composition is not reported as a reset', async () => {
    const cake = await mkProduct('Tort4', { type: 'finished', unit: 'pcs' });
    const flour = await mkProduct('Un4', { type: 'raw' });
    const sugar = await mkProduct('Shakar4', { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto) VALUES ($1,$2,0.5,0.5)`,
      [cake, flour],
    );
    const r = await withTransaction((tx) => writePosterRecipe(tx, cake, [
      { componentProductId: flour, qtyPerUnit: 0.5 },
      { componentProductId: sugar, qtyPerUnit: 0.1 },
    ]));
    expect(r.stagesReset).toBe(false);
  });

  it('Y6: reports a value the 4-decimal storage changes by more than 10%', async () => {
    const cake = await mkProduct('Tort6', { type: 'finished', unit: 'pcs' });
    const van = await mkProduct('Vanilin6', { type: 'raw' });
    const flour = await mkProduct('Un6', { type: 'raw' });
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [
        { componentProductId: van, qtyPerUnit: 0.00006 },
        { componentProductId: flour, qtyPerUnit: 0.12344 }, // rounds by < 10%: not reported
      ]),
    );
    expect(r.roundingChanges).toEqual([{ componentProductId: van, from: 0.00006, to: 0.0001 }]);
  });

  it('E5: a qty below the 4-decimal storage is skipped by the database, 0.00005 rounds up', async () => {
    const cake = await mkProduct('Tort3', { type: 'finished', unit: 'pcs' });
    const van = await mkProduct('Vanilin', { type: 'raw' });
    const flour = await mkProduct('Un3', { type: 'raw' });
    const r = await withTransaction((tx) =>
      writePosterRecipe(tx, cake, [
        { componentProductId: van, qtyPerUnit: 0.00004 },
        { componentProductId: flour, qtyPerUnit: 0.00005 },
      ]),
    );
    expect(r.skipped.map((s) => s.componentProductId)).toEqual([van]);
    expect(r.written).toEqual([{ component_product_id: flour, qty_per_unit: 0.0001, brutto: 0.0001, stage: 'base' }]);
  });
});
