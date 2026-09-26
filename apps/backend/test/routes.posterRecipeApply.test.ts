/**
 * Route tests for the per-product Poster recipe endpoints:
 *
 *   GET  /api/integrations/poster/product-recipe/:id        — preview
 *   POST /api/integrations/poster/product-recipe/:id/apply  — re-sync + unlock
 *
 * The fixture is the real case from the owner's screenshots: the prepack
 * "Г/П МЕДОВИК ШОК ЧЕРНЫЙ" (out = 1000 g) with two prepack components whose
 * netto is unreliable (0 g and 1000 g) — the recipe must be BRUTTO-based.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import { readFinalBom } from '../src/services/bom.js';
import {
  PosterClient,
  resetPosterClientCache,
  setPosterClientForTests,
  type PosterMenuProductFull,
  type PosterMenuProductRow,
  type PosterPrepack,
  type PosterRecipeIngredient,
} from '../src/integrations/poster/client.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  process.env.POSTER_TOKEN = 'acc:test';
  const { resetConfigCache } = await import('../src/config/index.js');
  resetConfigCache();
});

afterAll(async () => {
  setPosterClientForTests(undefined);
  resetPosterClientCache();
  await ctx.dispose();
});

beforeEach(async () => {
  setPosterClientForTests(undefined);
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const TESTO_LINE: PosterRecipeIngredient = {
  structure_id: '1',
  ingredient_id: '1101',
  structure_unit: 'g',
  structure_type: '2',
  structure_brutto: 115.3,
  structure_netto: 0,
  ingredient_name: 'медовик шок черный тесто',
  ingredient_unit: 'kg',
};

const KREM_LINE: PosterRecipeIngredient = {
  structure_id: '2',
  ingredient_id: '1102',
  structure_unit: 'g',
  structure_type: '2',
  structure_brutto: 63.88,
  structure_netto: 1000,
  ingredient_name: 'медовик шок крем',
  ingredient_unit: 'kg',
};

function medovikPrepack(lines: PosterRecipeIngredient[] = [TESTO_LINE, KREM_LINE]): PosterPrepack {
  return {
    product_id: '978',
    ingredient_id: '2402',
    product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
    out: 1000,
    ingredients: lines,
  };
}

/** Stub the Poster client singleton with the given read-only payloads. */
function stubPoster(data: {
  prepacks?: PosterPrepack[];
  products?: PosterMenuProductRow[];
  full?: Record<string, PosterMenuProductFull>;
}): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        const ok = (response: unknown): Promise<Response> =>
          Promise.resolve(new Response(JSON.stringify({ response }), { status: 200 }));
        if (m === 'menu.getPrepacks') return ok(data.prepacks ?? []);
        if (m === 'menu.getProducts') return ok(data.products ?? []);
        if (m === 'menu.getProduct') {
          const id = u.searchParams.get('product_id') ?? '';
          return ok(data.full?.[id] ?? null);
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    }),
  );
}

async function mkProduct(
  name: string,
  opts: {
    type?: string;
    unit?: string;
    ppid?: number | null;
    ping?: number | null;
    locked?: boolean;
  } = {},
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, recipe_locked)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, opts.type ?? 'semi', opts.unit ?? 'kg', opts.ppid ?? null, opts.ping ?? null, opts.locked ?? false],
  );
  return Number(rows[0]!.id);
}

async function addRecipeLine(
  productId: number,
  componentId: number,
  qty: number,
  stage = 'base',
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
     VALUES ($1, $2, $3, $3, $4)`,
    [productId, componentId, qty, stage],
  );
}

type Seed = { parent: number; testo: number; krem: number; zg: number };

/**
 * The production state: the parent is LOCKED with a hand-saved one-line
 * recipe (1 × "з/г медовик", stage base) and carries an OLD ingredient id
 * that no longer matches Poster's (defect 1).
 */
async function seedMedovik(): Promise<Seed> {
  const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 9999, locked: true });
  const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101, ping: 2501 });
  const krem = await mkProduct('медовик шок крем', { ppid: 1102, ping: 2502 });
  const zg = await mkProduct('з/г медовик', { unit: 'pcs' });
  await addRecipeLine(parent, zg, 1, 'base');
  return { parent, testo, krem, zg };
}

async function pmToken(): Promise<string> {
  return (await makeUser(ctx.db, { role: 'pm', locationId: null })).token;
}

type RecipeRowBody = {
  id: number;
  product_id: number;
  component_product_id: number;
  qty_per_unit: number;
  brutto: number;
  stage: string | null;
  component_name: string;
  component_unit: string;
  component_cost_price: number | null;
  component_type: string;
};

async function dbRecipe(productId: number) {
  const { rows } = await ctx.db.query<{ component_product_id: string; qty_per_unit: string; stage: string }>(
    `SELECT component_product_id, qty_per_unit::text AS qty_per_unit, stage::text AS stage
       FROM recipes WHERE product_id = $1 ORDER BY id`,
    [productId],
  );
  return rows.map((r) => ({ component: Number(r.component_product_id), qty: Number(r.qty_per_unit), stage: r.stage }));
}

async function isLocked(productId: number): Promise<boolean> {
  const { rows } = await ctx.db.query<{ recipe_locked: boolean }>(
    'SELECT recipe_locked FROM products WHERE id = $1',
    [productId],
  );
  return rows[0]!.recipe_locked;
}

const applyUrl = (id: number): string => `/api/integrations/poster/product-recipe/${id}/apply`;
const previewUrl = (id: number): string => `/api/integrations/poster/product-recipe/${id}`;

// -----------------------------------------------------------------------------
// POST .../apply
// -----------------------------------------------------------------------------

describe('POST /api/integrations/poster/product-recipe/:id/apply', () => {
  it('re-syncs the locked real медовик recipe from Poster (brutto-based) and unlocks it', async () => {
    const s = await seedMedovik();
    stubPoster({ prepacks: [medovikPrepack()] });
    const token = await pmToken();

    // N4 — the product recipe endpoint exposes the lock.
    const before = await request(ctx.app)
      .get(`/api/products/${s.parent}/recipe`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.body.recipe_locked).toBe(true);

    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.product_id).toBe(s.parent);
    expect(res.body.recipe_locked).toBe(false);
    expect(res.body.source).toBe('prepack');
    expect(res.body.poster_product_id).toBe(978);
    expect(res.body.poster_name).toBe('Г/П МЕДОВИК ШОК ЧЕРНЫЙ');
    // The old recipe was all 'base' — nothing to report as a stage reset.
    expect(res.body.stages_reset).toBe(false);
    expect(res.body.warnings).toEqual([]);

    const after = await request(ctx.app)
      .get(`/api/products/${s.parent}/recipe`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.recipe_locked).toBe(false);
    expect(after.body.product_id).toBe(s.parent);
    expect(after.body.recipe).toHaveLength(2);

    const recipe = res.body.recipe as RecipeRowBody[];
    expect(recipe).toHaveLength(2);
    const testo = recipe.find((r) => r.component_product_id === s.testo);
    const krem = recipe.find((r) => r.component_product_id === s.krem);
    expect(testo?.qty_per_unit).toBeCloseTo(0.1153, 4);
    expect(testo?.brutto).toBeCloseTo(0.1153, 4);
    expect(testo?.stage).toBe('base');
    expect(testo?.component_name).toBe('медовик шок черный тесто');
    expect(testo?.component_unit).toBe('kg');
    expect(testo?.component_type).toBe('semi');
    expect(testo).toHaveProperty('id');
    expect(testo).toHaveProperty('product_id', s.parent);
    expect(testo).toHaveProperty('component_cost_price');
    // NUMERIC(14,4) keeps 4 decimals: 0.06388 is stored as 0.0639 — never 1.0.
    expect(krem?.qty_per_unit).toBeCloseTo(0.06388, 3);
    expect(krem?.qty_per_unit).toBeLessThan(0.1);
    // The hand-saved "з/г медовик" line is gone.
    expect(recipe.some((r) => r.component_product_id === s.zg)).toBe(false);

    expect(await isLocked(s.parent)).toBe(false);
    const { rows: audit } = await ctx.db.query<{ action: string; entity_id: string; payload: Record<string, unknown> }>(
      `SELECT action, entity_id, payload FROM audit_log WHERE action = 'product.recipe.poster_resync'`,
    );
    expect(audit).toHaveLength(1);
    expect(Number(audit[0]!.entity_id)).toBe(s.parent);
    expect(audit[0]!.payload.source).toBe('prepack');
    expect(audit[0]!.payload.poster_product_id).toBe(978);
    expect(audit[0]!.payload.poster_name).toBe('Г/П МЕДОВИК ШОК ЧЕРНЫЙ');
    expect(JSON.stringify(audit[0]!.payload.previous_components)).toContain(String(s.zg));
    expect(Array.isArray(audit[0]!.payload.components)).toBe(true);
    expect(audit[0]!.payload.name_mismatches).toEqual([]);
  });

  it('allows a production_manager', async () => {
    const s = await seedMedovik();
    stubPoster({ prepacks: [medovikPrepack()] });
    const prodLoc = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type) VALUES ('Sex', 'production') RETURNING id`,
    );
    const pmgr = await makeUser(ctx.db, { role: 'production_manager', locationId: Number(prodLoc.rows[0]!.id) });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${pmgr.token}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it('binds the product_id row on a type-2 id collision (not the unrelated ingredient_id row)', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const p1 = await mkProduct('медовик шок крем', { ppid: 1102 });
    const p2 = await mkProduct('медовик сметанный крем', { ping: 1102 });
    stubPoster({ prepacks: [medovikPrepack()] });

    const res = await request(ctx.app)
      .post(applyUrl(parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    const ids = (res.body.recipe as RecipeRowBody[]).map((r) => r.component_product_id);
    expect(ids).toContain(p1);
    expect(ids).not.toContain(p2);
  });

  it('keeps the id candidate when names differ (no exact name match) and reports a warning', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    stubPoster({
      prepacks: [medovikPrepack([TESTO_LINE, { ...KREM_LINE, ingredient_name: 'медовик крем шоколадный' }])],
    });

    const res = await request(ctx.app)
      .post(applyUrl(parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect((res.body.recipe as RecipeRowBody[]).map((r) => r.component_product_id)).toContain(krem);
    expect(res.body.warnings).toEqual([
      "Poster: 'медовик крем шоколадный' → ERP: 'медовик шок крем' (nomi mos emas)",
    ]);
    const { rows } = await ctx.db.query<{ payload: { name_mismatches: unknown[] } }>(
      `SELECT payload FROM audit_log WHERE action = 'product.recipe.poster_resync'`,
    );
    expect(rows[0]!.payload.name_mismatches).toHaveLength(1);
  });

  it('keeps ERP-set stages when Poster brings the same components (production reads the split)', async () => {
    const s = await seedMedovik();
    await ctx.db.query('DELETE FROM recipes WHERE product_id = $1', [s.parent]);
    await addRecipeLine(s.parent, s.testo, 0.2, 'base');
    await addRecipeLine(s.parent, s.krem, 0.5, 'decoration');
    stubPoster({ prepacks: [medovikPrepack()] });

    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.stages_reset).toBe(false);
    expect(res.body.warnings).toEqual([]);
    const recipe = res.body.recipe as RecipeRowBody[];
    expect(recipe.find((r) => r.component_product_id === s.krem)?.stage).toBe('decoration');
    expect(recipe.find((r) => r.component_product_id === s.testo)?.stage).toBe('base');
    // What the FINAL production order consumes: only the decoration line.
    const finalBom = await withTransaction((tx) => readFinalBom(tx, s.parent));
    expect(finalBom.map((l) => l.component_product_id)).toEqual([s.krem]);
    expect(finalBom[0]!.qty_per_unit).toBeCloseTo(0.0639, 4);
  });

  it('resets stages to base when the composition changed, warns, and production reads every line', async () => {
    const s = await seedMedovik(); // z/g медовик (base) is dropped by Poster
    await addRecipeLine(s.parent, s.krem, 0.5, 'decoration');
    stubPoster({ prepacks: [medovikPrepack()] });
    const token = await pmToken();

    // Y1(d) — the preview says so before anything is written.
    const preview = await request(ctx.app).get(previewUrl(s.parent)).set('Authorization', `Bearer ${token}`);
    expect(preview.body.stages_will_reset).toBe(true);

    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.stages_reset).toBe(true);
    expect(res.body.warnings).toEqual([
      "Poster tarkibi o'zgargani uchun Hamir/Krem/Bezak bosqichlari tiklanmadi — kerak bo'lsa qayta belgilang.",
    ]);
    expect((res.body.recipe as RecipeRowBody[]).every((r) => r.stage === 'base')).toBe(true);
    const finalBom = await withTransaction((tx) => readFinalBom(tx, s.parent));
    expect(finalBom.map((l) => l.component_product_id).sort()).toEqual([s.testo, s.krem].sort());
    const { rows } = await ctx.db.query<{ payload: { stages_reset: boolean } }>(
      `SELECT payload FROM audit_log WHERE action = 'product.recipe.poster_resync'`,
    );
    expect(rows[0]!.payload.stages_reset).toBe(true);
  });

  it('S9: type-2 line ids from the INGREDIENT space resolve the медовик components', async () => {
    const s = await seedMedovik(); // testo ping 2501, krem ping 2502
    await mkProduct('бисквит ванильный', { ppid: 2502 }); // unrelated product-space row
    stubPoster({
      prepacks: [medovikPrepack([
        { ...TESTO_LINE, ingredient_id: '2501' },
        { ...KREM_LINE, ingredient_id: '2502' },
      ])],
    });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    const recipe = res.body.recipe as RecipeRowBody[];
    expect(recipe.map((r) => r.component_product_id).sort()).toEqual([s.testo, s.krem].sort());
    expect(recipe.find((r) => r.component_product_id === s.krem)?.qty_per_unit).toBeCloseTo(0.0639, 4);
  });

  it('B1: a MENU tech card falls back ingredient-first, exactly like the hourly sync', async () => {
    const cake = await mkProduct('Cake', { type: 'finished', unit: 'pcs', ppid: 800 });
    await mkProduct('AAA product-space row', { ppid: 1102 });
    const b = await mkProduct('BBB ingredient-space row', { ping: 1102 });
    stubPoster({
      full: {
        '800': {
          product_id: '800', product_name: 'Cake', type: '2',
          ingredients: [{ ...KREM_LINE, ingredient_name: 'zzz poster name', structure_brutto: 300 }],
        },
      },
    });
    const res = await request(ctx.app)
      .post(applyUrl(cake))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('menu');
    expect((res.body.recipe as RecipeRowBody[]).map((r) => r.component_product_id)).toEqual([b]);
    expect(res.body.warnings).toEqual([
      "Poster: 'zzz poster name' → ERP: 'BBB ingredient-space row' (nomi mos emas)",
    ]);
  });

  it('B2: a name-only binding is reported in the warnings and the audit', async () => {
    const s = await seedMedovik();
    await ctx.db.query('UPDATE products SET poster_product_id = NULL, poster_ingredient_id = NULL WHERE id = $1', [s.krem]);
    stubPoster({ prepacks: [medovikPrepack()] });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect((res.body.recipe as RecipeRowBody[]).map((r) => r.component_product_id)).toContain(s.krem);
    expect(res.body.warnings).toEqual([
      "Poster: 'медовик шок крем' → ERP: 'медовик шок крем' (faqat nomi bo'yicha bog'landi — Poster ID 1102 ERP'da yo'q)",
    ]);
    const { rows } = await ctx.db.query<{ payload: { name_bindings: Array<{ component_product_id: number }> } }>(
      `SELECT payload FROM audit_log WHERE action = 'product.recipe.poster_resync'`,
    );
    expect(rows[0]!.payload.name_bindings.map((b) => b.component_product_id)).toEqual([s.krem]);
  });

  it('S2: duplicate Poster lines for one component are summed and reported', async () => {
    const s = await seedMedovik();
    stubPoster({
      prepacks: [medovikPrepack([TESTO_LINE, KREM_LINE, { ...KREM_LINE, structure_id: '3', structure_brutto: 10 }])],
    });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect((res.body.recipe as RecipeRowBody[]).find((r) => r.component_product_id === s.krem)?.qty_per_unit)
      .toBeCloseTo(0.0739, 4);
    expect(res.body.warnings).toEqual([
      "ERP: 'медовик шок крем' Poster'da 2 ta qatorda keldi — miqdorlar qo'shildi",
    ]);
  });

  it('S8: a Poster line that resolves to the product itself is dropped with a warning', async () => {
    const s = await seedMedovik();
    stubPoster({
      prepacks: [medovikPrepack([
        TESTO_LINE,
        KREM_LINE,
        { ...TESTO_LINE, structure_id: '9', ingredient_id: '978', ingredient_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ' },
      ])],
    });
    const token = await pmToken();
    const preview = await request(ctx.app).get(previewUrl(s.parent)).set('Authorization', `Bearer ${token}`);
    expect((preview.body.lines as Array<{ component_product_id: number }>).map((l) => l.component_product_id))
      .not.toContain(s.parent);
    const res = await request(ctx.app).post(applyUrl(s.parent)).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect((res.body.recipe as RecipeRowBody[]).map((r) => r.component_product_id).sort()).toEqual([s.testo, s.krem].sort());
    const selfWarning = "Poster: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ' — mahsulotning o'zi, o'tkazib yuborildi";
    expect(preview.body.warnings).toEqual([selfWarning]);
    expect(res.body.warnings).toEqual([selfWarning]);
  });

  it('422 and no change when the Poster recipe would close a BOM cycle', async () => {
    const s = await seedMedovik();
    // тесто already contains the parent -> adding тесто to the parent closes a cycle.
    await addRecipeLine(s.testo, s.parent, 0.1, 'base');
    stubPoster({ prepacks: [medovikPrepack()] });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/sikl/);
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('Y6: warns when 4-decimal rounding changes a value by more than 10%', async () => {
    const s = await seedMedovik();
    // 0.06 g in a 1000 g batch = 0.00006 kg/kg -> stored as 0.0001 (+67%).
    stubPoster({ prepacks: [medovikPrepack([TESTO_LINE, { ...KREM_LINE, structure_brutto: 0.06 }])] });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      "ERP: 'медовик шок крем' miqdori 4 xonaga yaxlitlanganda 10% dan ko'p o'zgardi: 0.00006 → 0.0001",
    ]);
  });

  it('S3: 422 and no change when a quantity is too small for the 4-decimal storage', async () => {
    const s = await seedMedovik();
    // 0.03 g in a 1000 g batch = 0.00003 kg/kg -> rounds to 0.0000 -> CHECK fails.
    stubPoster({ prepacks: [medovikPrepack([TESTO_LINE, { ...KREM_LINE, structure_brutto: 0.03 }])] });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe(
      "Quyidagi komponentlar miqdori juda kichik — 4 xonali kasrda saqlab bo'lmaydi (0.0001 dan kam): " +
        "медовик шок крем. O'zgartirish kiritilmadi.",
    );
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('422 and no change when a component cannot be resolved in the ERP', async () => {
    const s = await seedMedovik();
    await ctx.db.query('DELETE FROM products WHERE id = $1', [s.krem]);
    stubPoster({ prepacks: [medovikPrepack()] });

    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe(
      "Quyidagi komponentlar ERP'da topilmadi: медовик шок крем. Avval Poster sinxronlashni ishga tushiring.",
    );
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('422 and no change when Poster has no recipe for the product', async () => {
    const s = await seedMedovik();
    await ctx.db.query(
      `UPDATE products SET name = 'Boshqa mahsulot', poster_product_id = NULL, poster_ingredient_id = NULL WHERE id = $1`,
      [s.parent],
    );
    stubPoster({ prepacks: [medovikPrepack()] });

    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/^Poster'da bu mahsulot retsepti topilmadi/);
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('422 and no change when the Poster recipe has no usable lines', async () => {
    const s = await seedMedovik();
    stubPoster({ prepacks: [medovikPrepack([{ ...TESTO_LINE, ingredient_id: '0' }])] });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(422);
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('404 for an unknown product, 422 for a malformed id (Uzbek messages)', async () => {
    stubPoster({ prepacks: [] });
    const token = await pmToken();
    const res = await request(ctx.app)
      .post(applyUrl(987654))
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Mahsulot topilmadi.');
    const bad = await request(ctx.app)
      .post('/api/integrations/poster/product-recipe/abc/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe("Mahsulot ID noto'g'ri.");
  });

  it('403 for a store_manager', async () => {
    const s = await seedMedovik();
    stubPoster({ prepacks: [medovikPrepack()] });
    const store = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type) VALUES ('Dokon', 'store') RETURNING id`,
    );
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: Number(store.rows[0]!.id) });
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${sm.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(await isLocked(s.parent)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// GET .../product-recipe/:id (preview)
// -----------------------------------------------------------------------------

describe('GET /api/integrations/poster/product-recipe/:id (preview)', () => {
  it('finds the prepack by poster_product_id and previews BRUTTO quantities', async () => {
    const s = await seedMedovik(); // ERP ingredient id 9999 ≠ Poster 2402
    stubPoster({ prepacks: [medovikPrepack()] });

    const res = await request(ctx.app)
      .get(previewUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('source'); // the client never read it
    expect(res.body.poster_name).toBe('Г/П МЕДОВИК ШОК ЧЕРНЫЙ');
    expect(res.body.not_found).toEqual([]);
    expect(res.body.warnings).toEqual([]);
    // The old recipe was all 'base' — nothing would be lost.
    expect(res.body.stages_will_reset).toBe(false);
    const lines = res.body.lines as Array<Record<string, unknown> & {
      component_product_id: number; component_name: string; component_unit: string;
      qty_per_unit: number; brutto: number;
    }>;
    expect(lines).toHaveLength(2);
    const krem = lines.find((l) => l.component_product_id === s.krem);
    expect(krem?.qty_per_unit).toBeCloseTo(0.06388, 6);
    expect(krem?.brutto).toBeCloseTo(0.06388, 6);
    expect(krem).not.toHaveProperty('found');
    // The client reads only these three per line.
    expect(Object.keys(krem!).sort()).toEqual(['brutto', 'component_product_id', 'qty_per_unit']);
    const testo = lines.find((l) => l.component_product_id === s.testo);
    expect(testo?.qty_per_unit).toBeCloseTo(0.1153, 6);
    // Preview never writes.
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });

  it('binds the product_id row on a type-2 id collision', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const p1 = await mkProduct('медовик шок крем', { ppid: 1102 });
    const p2 = await mkProduct('медовик сметанный крем', { ping: 1102 });
    stubPoster({ prepacks: [medovikPrepack()] });
    const res = await request(ctx.app)
      .get(previewUrl(parent))
      .set('Authorization', `Bearer ${await pmToken()}`);
    expect(res.status).toBe(200);
    const ids = (res.body.lines as Array<{ component_product_id: number }>).map((l) => l.component_product_id);
    expect(ids).toContain(p1);
    expect(ids).not.toContain(p2);
  });

  it('keeps the backward-compatible empty shape with an Uzbek message when Poster has no recipe', async () => {
    const orphan = await mkProduct('Yetim mahsulot');
    stubPoster({ prepacks: [medovikPrepack()] });
    const res = await request(ctx.app)
      .get(previewUrl(orphan))
      .set('Authorization', `Bearer ${await pmToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.not_found).toEqual([]);
    expect(res.body.message).toBe(
      "Poster'da bu mahsulot retsepti topilmadi (mahsulot Poster bilan bog'lanmagan — " +
        "poster_ingredient_id va poster_product_id yo'q, nomi bo'yicha ham topilmadi).",
    );
  });

  it('explains in Uzbek when no component resolved (the client only shows `message` then)', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    stubPoster({ prepacks: [medovikPrepack()] });
    const res = await request(ctx.app)
      .get(previewUrl(parent))
      .set('Authorization', `Bearer ${await pmToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.not_found).toEqual(['медовик шок черный тесто', 'медовик шок крем']);
    expect(res.body.message).toBe(
      "Quyidagi komponentlar ERP'da topilmadi: медовик шок черный тесто, медовик шок крем. " +
        'Avval Poster sinxronlashni ishga tushiring.',
    );
  });
});

describe('Poster failures on the recipe endpoints', () => {
  /** A client whose every call fails with a network error that leaks the token. */
  function stubFailingPoster(): void {
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        transientRetries: 0,
        fetcher: (() =>
          Promise.reject(
            new Error('connect ECONNREFUSED https://joinposter.com/api/menu.getPrepacks?token=acc:secret123'),
          )) as unknown as typeof fetch,
      }),
    );
  }

  it('GET preview: 502 with an Uzbek, token-redacted message', async () => {
    const s = await seedMedovik();
    stubFailingPoster();
    const res = await request(ctx.app)
      .get(previewUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/^Poster bilan bog'lanib bo'lmadi \(menu\.getPrepacks\): /);
    expect(res.body.error.message).not.toContain('secret123');
  });

  it('POST apply: 502 and nothing changes', async () => {
    const s = await seedMedovik();
    stubFailingPoster();
    const res = await request(ctx.app)
      .post(applyUrl(s.parent))
      .set('Authorization', `Bearer ${await pmToken()}`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error.message).not.toContain('secret123');
    expect(await dbRecipe(s.parent)).toEqual([{ component: s.zg, qty: 1, stage: 'base' }]);
    expect(await isLocked(s.parent)).toBe(true);
  });
});
