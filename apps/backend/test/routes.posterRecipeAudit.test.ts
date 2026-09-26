/**
 * Bulk Poster recipe audit / apply / restore (the owner's "every recipe must
 * match Poster" request), run in-app after deploy:
 *
 *   GET  /api/integrations/poster/recipe-audit          — pm, production_manager
 *   GET  /api/integrations/poster/recipe-audit/job      — pm, production_manager
 *   POST /api/integrations/poster/recipe-audit/run      — pm, production_manager
 *   POST /api/integrations/poster/recipe-audit/apply    — pm only
 *   POST /api/integrations/poster/recipe-audit/restore  — pm only
 *
 * Main fixture (`seed`):
 *   - медовик      semi, LOCKED, hand-saved 1-line recipe  -> differs
 *   - Krem asosi   semi, equal to Poster at 4 decimals      -> match
 *   - Biskvit      semi, LOCKED, unknown Poster component   -> unresolved
 *   - Eski krem    semi, LOCKED, not in Poster at all       -> poster_missing
 *   - Cake         finished (menu), flour 0.25 vs Poster 0.2 -> differs
 *   - Bo'sh        semi, linked, empty on both sides        -> excluded
 *   - Arxiv tort   semi, linked, INACTIVE                   -> out of scope
 *   - мука         raw                                      -> out of scope
 * E6 fixture (`seedCakes`): stage-split cakes from the code review.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import { findZagatovkaComponent } from '../src/services/bom.js';
import { POSTER_RECIPE_LOCK_KEY, acquirePosterRecipeLock } from '../src/integrations/poster/recipeLock.js';
import {
  PosterClient,
  resetPosterClientCache,
  setPosterClientForTests,
  type PosterMenuProductFull,
  type PosterPrepack,
  type PosterRecipeIngredient,
} from '../src/integrations/poster/client.js';
import {
  resetRecipeAuditForTests,
  whenRecipeAuditIdle,
} from '../src/services/posterRecipeAudit.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  process.env.POSTER_TOKEN = 'acc:test';
  const { resetConfigCache } = await import('../src/config/index.js');
  resetConfigCache();
});

afterAll(async () => {
  await whenRecipeAuditIdle();
  setPosterClientForTests(undefined);
  resetPosterClientCache();
  await ctx.dispose();
});

beforeEach(async () => {
  await whenRecipeAuditIdle();
  resetRecipeAuditForTests();
  setPosterClientForTests(undefined);
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM import_warnings');
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const line = (over: Partial<PosterRecipeIngredient> & Pick<PosterRecipeIngredient, 'ingredient_id' | 'ingredient_name'>): PosterRecipeIngredient => ({
  structure_id: `s${over.ingredient_id}`,
  structure_unit: 'g',
  structure_type: '1',
  structure_brutto: 0,
  structure_netto: 0,
  ingredient_unit: 'kg',
  ...over,
});

const PREPACKS: PosterPrepack[] = [
  {
    product_id: '978', ingredient_id: '2402', product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ', out: 1000,
    ingredients: [
      line({ ingredient_id: '1101', ingredient_name: 'медовик шок черный тесто', structure_type: '2', structure_brutto: 115.3, structure_netto: 0 }),
      line({ ingredient_id: '1102', ingredient_name: 'медовик шок крем', structure_type: '2', structure_brutto: 63.88, structure_netto: 1000 }),
    ],
  },
  {
    // 500.04 g / 1 kg = 0.50004 -> round4 0.5 == ERP 0.5
    product_id: '700', ingredient_id: '2700', product_name: 'Krem asosi', out: 1000,
    ingredients: [line({ ingredient_id: '100', ingredient_name: 'мука', structure_brutto: 500.04 })],
  },
  {
    product_id: '701', ingredient_id: '2701', product_name: 'Biskvit', out: 1000,
    ingredients: [
      line({ ingredient_id: '100', ingredient_name: 'мука', structure_brutto: 300 }),
      line({ ingredient_id: '404', ingredient_name: 'Kardamon', structure_brutto: 5 }),
    ],
  },
  {
    product_id: '705', ingredient_id: '0', product_name: 'Arxiv tort', out: 1000,
    ingredients: [line({ ingredient_id: '100', ingredient_name: 'мука', structure_brutto: 900 })],
  },
];

/** E6 — two cakes: muka 500 g + krem (a prepack) 300 g per 1 kg batch. */
const CAKE_PREPACKS: PosterPrepack[] = ['900', '901'].map((id) => ({
  product_id: id, ingredient_id: '0', product_name: id === '900' ? 'Tort A' : 'Tort B', out: 1000,
  ingredients: [
    line({ ingredient_id: '100', ingredient_name: 'мука', structure_brutto: 500 }),
    line({ ingredient_id: '300', ingredient_name: 'krem', structure_type: '2', structure_brutto: 300 }),
  ],
}));

const CAKE_FULL: PosterMenuProductFull = {
  product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500',
  ingredients: [line({ ingredient_id: '100', ingredient_name: 'мука', structure_brutto: 200 })],
};

type PosterCalls = { getProduct: Map<string, number>; getPrepacks: number; getProducts: number };

type StubOpts = {
  gate?: Promise<void>;
  failPrepacks?: boolean;
  extraPrepacks?: PosterPrepack[];
  failProduct?: string;
  productGate?: { id: string; reached: () => void; wait: Promise<void> };
};

/** Install a Poster stub and return live call counters. */
function stubPoster(opts: StubOpts = {}): PosterCalls {
  const calls: PosterCalls = { getProduct: new Map(), getPrepacks: 0, getProducts: 0 };
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      transientRetries: 0,
      fetcher: (async (url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        const ok = (response: unknown): Response =>
          new Response(JSON.stringify({ response }), { status: 200 });
        if (m === 'menu.getPrepacks') {
          calls.getPrepacks += 1;
          if (opts.gate !== undefined) await opts.gate;
          if (opts.failPrepacks === true) throw new Error('connect ECONNREFUSED ?token=acc:secret999');
          return ok([...PREPACKS, ...(opts.extraPrepacks ?? [])]);
        }
        if (m === 'menu.getProducts') {
          calls.getProducts += 1;
          return ok([{ product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500' }]);
        }
        if (m === 'menu.getProduct') {
          const id = u.searchParams.get('product_id') ?? '';
          calls.getProduct.set(id, (calls.getProduct.get(id) ?? 0) + 1);
          if (opts.productGate !== undefined && opts.productGate.id === id) {
            opts.productGate.reached();
            await opts.productGate.wait;
          }
          if (opts.failProduct === id) {
            return new Response(JSON.stringify({ error: { code: 10, message: 'API limit' } }), { status: 200 });
          }
          return ok(id === '800' ? CAKE_FULL : null);
        }
        return new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  return calls;
}

async function mkProduct(
  name: string,
  opts: { type?: string; unit?: string; ppid?: number | null; ping?: number | null; locked?: boolean; active?: boolean } = {},
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, recipe_locked, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [name, opts.type ?? 'semi', opts.unit ?? 'kg', opts.ppid ?? null, opts.ping ?? null, opts.locked ?? false, opts.active ?? true],
  );
  return Number(rows[0]!.id);
}

async function addLine(productId: number, componentId: number, qty: number, stage = 'base'): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage) VALUES ($1, $2, $3, $3, $4)`,
    [productId, componentId, qty, stage],
  );
}

type Seed = {
  flour: number; medovik: number; testo: number; krem: number; zg: number;
  kremAsosi: number; biskvit: number; eskiKrem: number; cake: number; empty: number; archived: number;
};

async function seed(): Promise<Seed> {
  const flour = await mkProduct('мука', { type: 'raw', ping: 100 });
  const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101, ping: 2501 });
  const krem = await mkProduct('медовик шок крем', { ppid: 1102, ping: 2502 });
  const zg = await mkProduct('з/г медовик', { unit: 'pcs' });
  const medovik = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 9999, locked: true });
  await addLine(medovik, zg, 1);
  const kremAsosi = await mkProduct('Krem asosi', { ppid: 700, ping: 2700 });
  await addLine(kremAsosi, flour, 0.5);
  const biskvit = await mkProduct('Biskvit', { ppid: 701, ping: 2701, locked: true });
  await addLine(biskvit, flour, 0.3);
  const eskiKrem = await mkProduct('Eski krem', { ppid: 702, locked: true });
  await addLine(eskiKrem, flour, 0.2);
  const cake = await mkProduct('Cake', { type: 'finished', unit: 'pcs', ppid: 800, ping: 1500 });
  await addLine(cake, flour, 0.25);
  const empty = await mkProduct("Bo'sh", { ppid: 703 });
  const archived = await mkProduct('Arxiv tort', { ppid: 705, locked: true, active: false });
  await addLine(archived, flour, 0.1);
  return { flour, medovik, testo, krem, zg, kremAsosi, biskvit, eskiKrem, cake, empty, archived };
}

type Cakes = { flour: number; krem: number; zg: number; cakeA: number; cakeB: number };

/** E6 — cake A: split + z/g that Poster dropped; cake B: split, same components. */
async function seedCakes(): Promise<Cakes> {
  const flour = await mkProduct('мука', { type: 'raw', ping: 100 });
  const krem = await mkProduct('krem', { ppid: 300 });
  const zg = await mkProduct('zg tort');
  const cakeA = await mkProduct('Tort A', { ppid: 900, locked: true });
  await addLine(cakeA, flour, 0.5, 'base');
  await addLine(cakeA, krem, 0.3, 'decoration');
  await addLine(cakeA, zg, 1, 'decoration');
  const cakeB = await mkProduct('Tort B', { ppid: 901, locked: true });
  await addLine(cakeB, flour, 0.1, 'base');
  await addLine(cakeB, flour, 0.4, 'decoration');
  await addLine(cakeB, krem, 0.3, 'decoration');
  return { flour, krem, zg, cakeA, cakeB };
}

async function token(role: 'pm' | 'production_manager' | 'store_manager'): Promise<string> {
  if (role === 'pm') return (await makeUser(ctx.db, { role, locationId: null })).token;
  const type = role === 'store_manager' ? 'store' : 'production';
  const loc = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type) VALUES ($1, $2) RETURNING id`,
    [`L-${role}`, type],
  );
  return (await makeUser(ctx.db, { role, locationId: Number(loc.rows[0]!.id) })).token;
}

type ReportLine = {
  component_product_id: number | null; component_name: string;
  erp_qty: number | null; poster_qty: number | null; stage: string | null;
  diff: 'same' | 'changed' | 'erp_only' | 'poster_only';
};
type ReportItem = {
  product_id: number; product_name: string; product_type: string; product_unit: string;
  recipe_locked: boolean; status: string; poster_name: string | null; source: string | null;
  lines: ReportLine[]; not_found: string[]; warnings: string[]; stages_will_reset: boolean;
  apply_result?: string; apply_message?: string;
};
type Report = {
  generated_at: string; summary: Record<string, number>; items: ReportItem[];
  skipped_outside_scope?: Array<{ product_id: number; apply_message: string }>;
};
type State = {
  job: Record<string, unknown> | null; report: Report | null;
  last_apply_report: Report | null; restorable_job_id: string | null;
};

const BASE = '/api/integrations/poster/recipe-audit';

async function getState(tok: string): Promise<State> {
  const res = await request(ctx.app).get(BASE).set('Authorization', `Bearer ${tok}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function runAudit(tok: string): Promise<Report> {
  const res = await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${tok}`).send({});
  expect(res.status).toBe(202);
  await whenRecipeAuditIdle();
  return (await getState(tok)).report!;
}

async function apply(tok: string, body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${tok}`).send(body);
  expect(res.status).toBe(202);
  expect(res.body.job).toMatchObject({ kind: 'apply', status: 'running' });
  await whenRecipeAuditIdle();
  return res.body.job.id as string;
}

async function rows(productId: number) {
  const { rows: r } = await ctx.db.query<{ c: string; q: string; b: string; s: string }>(
    `SELECT component_product_id AS c, qty_per_unit::text AS q, brutto::text AS b, stage::text AS s
       FROM recipes WHERE product_id = $1 ORDER BY component_product_id, stage`,
    [productId],
  );
  return r.map((x) => ({ component: Number(x.c), qty: Number(x.q), brutto: Number(x.b), stage: x.s }));
}

async function isLocked(productId: number): Promise<boolean> {
  const { rows: r } = await ctx.db.query<{ l: boolean }>('SELECT recipe_locked AS l FROM products WHERE id = $1', [productId]);
  return r[0]!.l;
}

const itemOf = (report: Report, id: number): ReportItem | undefined => report.items.find((i) => i.product_id === id);

// -----------------------------------------------------------------------------
// Audit (dry run)
// -----------------------------------------------------------------------------

describe('recipe audit (dry run)', () => {
  it('reports every active linked semi/finished product with its status and line diffs', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');

    expect(await getState(pm)).toEqual({ job: null, report: null, last_apply_report: null, restorable_job_id: null });

    const start = await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pm}`).send({});
    expect(start.status).toBe(202);
    expect(start.body.job).toMatchObject({ kind: 'audit', status: 'running', finished_at: null });
    expect(typeof start.body.job.id).toBe('string');
    await whenRecipeAuditIdle();

    const polled = await request(ctx.app).get(`${BASE}/job`).set('Authorization', `Bearer ${pm}`);
    expect(polled.status).toBe(200);
    expect(polled.body.job).toMatchObject({ id: start.body.job.id, kind: 'audit', status: 'done' });

    const { job, report, last_apply_report: lastApply } = await getState(pm);
    expect(job).toMatchObject({ id: start.body.job.id, status: 'done' });
    expect(typeof job!.finished_at).toBe('string');
    // Scope = 8 active linked semi/finished rows; тесто, крем and Bo'sh are
    // scanned but excluded (empty on both sides); Arxiv tort is inactive.
    expect(job!.progress).toEqual({ done: 8, total: 8 });
    expect(lastApply).toBeNull();
    expect(report!.summary).toEqual({
      total: 5, match: 1, differs: 2, locked: 3, poster_missing: 1, unresolved: 1,
      poster_error: 0, stages_will_reset: 0,
    });

    expect(itemOf(report!, s.flour)).toBeUndefined();
    expect(itemOf(report!, s.empty)).toBeUndefined();
    expect(itemOf(report!, s.archived)).toBeUndefined();

    const medovik = itemOf(report!, s.medovik)!;
    expect(medovik).toMatchObject({
      status: 'differs', recipe_locked: true, source: 'prepack', stages_will_reset: false,
      poster_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ', product_type: 'semi', product_unit: 'kg', not_found: [],
    });
    expect(medovik.lines).toEqual([
      { component_product_id: s.zg, component_name: 'з/г медовик', erp_qty: 1, poster_qty: null, stage: 'base', diff: 'erp_only' },
      { component_product_id: s.testo, component_name: 'медовик шок черный тесто', erp_qty: null, poster_qty: 0.1153, stage: null, diff: 'poster_only' },
      { component_product_id: s.krem, component_name: 'медовик шок крем', erp_qty: null, poster_qty: 0.0639, stage: null, diff: 'poster_only' },
    ]);

    expect(itemOf(report!, s.kremAsosi)!.status).toBe('match');
    expect(itemOf(report!, s.kremAsosi)!.lines).toEqual([
      { component_product_id: s.flour, component_name: 'мука', erp_qty: 0.5, poster_qty: 0.5, stage: 'base', diff: 'same' },
    ]);
    expect(itemOf(report!, s.cake)).toMatchObject({ status: 'differs', source: 'menu', recipe_locked: false });
    expect(itemOf(report!, s.cake)!.lines).toEqual([
      { component_product_id: s.flour, component_name: 'мука', erp_qty: 0.25, poster_qty: 0.2, stage: 'base', diff: 'changed' },
    ]);
    const biskvit = itemOf(report!, s.biskvit)!;
    expect(biskvit).toMatchObject({ status: 'unresolved', not_found: ['Kardamon'] });
    expect(biskvit.lines).toContainEqual(
      { component_product_id: null, component_name: 'Kardamon', erp_qty: null, poster_qty: 0.005, stage: null, diff: 'poster_only' },
    );
    expect(itemOf(report!, s.eskiKrem)).toMatchObject({ status: 'poster_missing', poster_name: null, source: null });

    // A dry run never writes.
    expect(await rows(s.medovik)).toEqual([{ component: s.zg, qty: 1, brutto: 1, stage: 'base' }]);
    expect(await isLocked(s.medovik)).toBe(true);
  });

  it('E7: equality is exact at 4 decimals (0.0001 vs Poster 0.0002 differs)', async () => {
    const van = await mkProduct('vanilin', { type: 'raw', ping: 61 });
    const p = await mkProduct('Krem V', { ppid: 910 });
    await addLine(p, van, 0.0001);
    stubPoster({ extraPrepacks: [{ product_id: '910', ingredient_id: '0', product_name: 'Krem V', out: 1000, ingredients: [line({ ingredient_id: '61', ingredient_name: 'vanilin', structure_brutto: 0.2 })] }] });
    const report = await runAudit(await token('pm'));
    expect(itemOf(report, p)).toMatchObject({ status: 'differs' });
    expect(itemOf(report, p)!.lines[0]).toMatchObject({ erp_qty: 0.0001, poster_qty: 0.0002, diff: 'changed' });
  });

  it("a per-product Poster error is 'poster_error', not 'poster_missing'", async () => {
    const s = await seed();
    stubPoster({ failProduct: '800' });
    const report = await runAudit(await token('pm'));
    const cake = itemOf(report, s.cake)!;
    expect(cake.status).toBe('poster_error');
    expect(cake.warnings[0]).toMatch(/^Poster bilan bog'lanib bo'lmadi \(menu\.getProduct\)/);
    expect(report.summary.poster_error).toBe(1);
    expect(report.summary.poster_missing).toBe(1);
  });

  it('a second run while one is running returns the running job; apply/restore get 409', async () => {
    const s = await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubPoster({ gate });
    const pm = await token('pm');

    const first = await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pm}`).send({});
    expect(first.status).toBe(202);
    const second = await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pm}`).send({});
    expect(second.status).toBe(200);
    expect(second.body.job.id).toBe(first.body.job.id);
    expect(second.body.job.status).toBe('running');
    const ap = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pm}`).send({ product_ids: [s.medovik] });
    expect(ap.status).toBe(409);

    release();
    await whenRecipeAuditIdle();
    expect((await getState(pm)).job).toMatchObject({ id: first.body.job.id, status: 'done' });
  });

  it('a Poster outage fails the job cleanly (the process keeps running)', async () => {
    await seed();
    stubPoster({ failPrepacks: true });
    const pm = await token('pm');
    await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pm}`).send({});
    await whenRecipeAuditIdle();
    const { job, report } = await getState(pm);
    expect(job).toMatchObject({ status: 'failed' });
    expect(String(job!.error)).toMatch(/^Poster bilan bog'lanib bo'lmadi/);
    expect(String(job!.error)).not.toContain('secret999');
    expect(report).toBeNull();
  });

  it('N5 / Y3: while the sync holds the lock a dry run still works (read-only), apply/restore answer 409', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    const jobId = await apply(pm, { product_ids: [s.cake] }); // a restorable job
    const held = await acquirePosterRecipeLock();
    expect(held).not.toBeNull();
    try {
      const msg = "Poster sinxronlash ishlayapti — birozdan keyin qayta urinib ko'ring.";
      const run = await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pm}`).send({});
      expect(run.status).toBe(202);
      await whenRecipeAuditIdle();
      expect((await getState(pm)).job).toMatchObject({ kind: 'audit', status: 'done' });
      const ap = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pm}`).send({ product_ids: [s.medovik] });
      expect(ap.status).toBe(409);
      expect(ap.body.error.message).toBe(msg);
      const rs = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: jobId });
      expect(rs.status).toBe(409);
      expect(rs.body.error.message).toBe(msg);
    } finally {
      await held!.release();
    }
  });
});

// -----------------------------------------------------------------------------
// Apply
// -----------------------------------------------------------------------------

describe('recipe bulk apply', () => {
  it('applies the confirmed targets, leaves the rest untouched, and re-audits', async () => {
    const s = await seed();
    const calls = stubPoster();
    const pm = await token('pm');

    const jobId = await apply(pm, { product_ids: [s.medovik, s.cake] });

    // медовик: unlocked with the Poster (brutto) quantities.
    expect(await isLocked(s.medovik)).toBe(false);
    expect((await rows(s.medovik)).map((r) => [r.component, r.qty, r.stage])).toEqual(
      [[s.testo, 0.1153, 'base'], [s.krem, 0.0639, 'base']].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
    expect(await rows(s.cake)).toEqual([{ component: s.flour, qty: 0.2, brutto: 0.2, stage: 'base' }]);
    // Not requested: untouched, locks stay.
    expect(await rows(s.biskvit)).toEqual([{ component: s.flour, qty: 0.3, brutto: 0.3, stage: 'base' }]);
    expect(await isLocked(s.biskvit)).toBe(true);
    expect(await isLocked(s.eskiKrem)).toBe(true);

    // One restorable snapshot (locks from the fresh pre-audit) + one audit row per product.
    const { rows: snaps } = await ctx.db.query<{ payload: { job_id: string; products: Array<{ product_id: number; recipe_locked: boolean; recipe: unknown[] }> } }>(
      `SELECT payload FROM audit_log WHERE action = 'poster.recipe.bulk_resync.snapshot'`,
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.payload.job_id).toBe(jobId);
    expect(snaps[0]!.payload.products.map((p) => p.product_id).sort()).toEqual([s.medovik, s.cake].sort());
    const medSnap = snaps[0]!.payload.products.find((p) => p.product_id === s.medovik)!;
    expect(medSnap.recipe_locked).toBe(true);
    expect(medSnap.recipe).toEqual([{ component_product_id: s.zg, qty_per_unit: 1, brutto: 1, stage: 'base' }]);
    const { rows: perProduct } = await ctx.db.query<{ entity_id: string; payload: { bulk_job_id: string } }>(
      `SELECT entity_id, payload FROM audit_log WHERE action = 'product.recipe.poster_resync'`,
    );
    expect(perProduct.map((r) => Number(r.entity_id)).sort()).toEqual([s.medovik, s.cake].sort());
    expect(perProduct.every((r) => r.payload.bulk_job_id === jobId)).toBe(true);

    const state = await getState(pm);
    expect(state.job).toMatchObject({ id: jobId, kind: 'apply', status: 'done' });
    expect(state.restorable_job_id).toBe(jobId);
    const report = state.last_apply_report!;
    expect(state.report).toEqual(report);
    expect(report.summary).toEqual({
      total: 5, match: 3, differs: 0, locked: 2, poster_missing: 1, unresolved: 1,
      poster_error: 0, stages_will_reset: 0, applied: 2, skipped: 0,
    });
    expect(itemOf(report, s.medovik)).toMatchObject({ status: 'match', recipe_locked: false, apply_result: 'applied' });
    expect(itemOf(report, s.biskvit)!.apply_result).toBeUndefined();

    // Poster: the lists once, each menu tech card once — per job.
    expect(calls.getPrepacks).toBe(1);
    expect(calls.getProducts).toBeLessThanOrEqual(1);
    expect(calls.getProduct.get('800')).toBe(1);
    expect(calls.getProduct.get('702')).toBe(1);
  });

  it('"qulflarni yechib bajar": a locked matching product ends unlocked with recipe + stages unchanged', async () => {
    const s = await seed();
    await ctx.db.query(`UPDATE recipes SET stage = 'decoration' WHERE product_id = $1`, [s.kremAsosi]);
    await ctx.db.query('UPDATE products SET recipe_locked = TRUE WHERE id = $1', [s.kremAsosi]);
    const before = await rows(s.kremAsosi);
    stubPoster();
    const pm = await token('pm');
    const pre = await runAudit(pm);
    expect(itemOf(pre, s.kremAsosi)).toMatchObject({ status: 'match', recipe_locked: true, stages_will_reset: false });

    await apply(pm, { product_ids: [s.medovik, s.kremAsosi, s.cake, s.biskvit] });

    expect(await isLocked(s.kremAsosi)).toBe(false);
    expect(await rows(s.kremAsosi)).toEqual(before);
    expect(await isLocked(s.biskvit)).toBe(true); // unresolved: never a target
    const { last_apply_report: report } = await getState(pm);
    expect(itemOf(report!, s.kremAsosi)).toMatchObject({ status: 'match', recipe_locked: false, apply_result: 'applied' });
    expect(itemOf(report!, s.biskvit)).toMatchObject({ apply_result: 'skipped', apply_message: "Holati o'zgargan — qayta tekshiring" });
  });

  it('Y2: ids that are no longer targets or outside the scope are skipped (no 422), the rest applied', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    // Failing ids FIRST: the job must carry on past them.
    await apply(pm, { product_ids: [s.kremAsosi, s.biskvit, s.eskiKrem, s.flour, 987654, s.medovik] });

    expect(await isLocked(s.medovik)).toBe(false);
    expect(await isLocked(s.biskvit)).toBe(true);
    expect(await isLocked(s.eskiKrem)).toBe(true);
    const { last_apply_report: report } = await getState(pm);
    const changed = "Holati o'zgargan — qayta tekshiring";
    expect(itemOf(report!, s.kremAsosi)).toMatchObject({ apply_result: 'skipped', apply_message: changed });
    expect(itemOf(report!, s.biskvit)).toMatchObject({ apply_result: 'skipped', apply_message: changed });
    expect(itemOf(report!, s.eskiKrem)).toMatchObject({ apply_result: 'skipped', apply_message: changed });
    expect(itemOf(report!, s.medovik)).toMatchObject({ apply_result: 'applied' });
    const outside = "Tekshiruv doirasida emas (topilmadi, nofaol, xom-ashyo yoki Poster bilan bog'lanmagan)";
    expect(report!.skipped_outside_scope).toEqual([
      { product_id: s.flour, apply_message: outside },
      { product_id: 987654, apply_message: outside },
    ]);
    expect(report!.summary.applied).toBe(1);
    expect(report!.summary.skipped).toBe(5);
  });

  it('Y2: product_ids is required and must be a non-empty id list; include_stage_resets a boolean', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    for (const body of [{}, { product_ids: [] }, { product_ids: ['x'] }, { product_ids: 5 }, { product_ids: [s.medovik], include_stage_resets: 'yes' }]) {
      const res = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pm}`).send(body);
      expect(res.status).toBe(422);
    }
  });

  it('writes no snapshot when nothing is left to apply', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    await apply(pm, { product_ids: [s.kremAsosi] }); // unlocked match: not a target
    const { rows: snaps } = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'poster.recipe.bulk_resync.snapshot'`);
    expect(snaps).toHaveLength(0);
    expect((await getState(pm)).restorable_job_id).toBeNull();
  });

  it('E6 / Y1: a split that would be lost is skipped unless include_stage_resets; a kept split is preserved', async () => {
    const c = await seedCakes();
    stubPoster({ extraPrepacks: CAKE_PREPACKS });
    const pm = await token('pm');
    const zagB = await withTransaction((tx) => findZagatovkaComponent(tx, c.cakeB));

    const pre = await runAudit(pm);
    expect(itemOf(pre, c.cakeA)).toMatchObject({ status: 'differs', recipe_locked: true, stages_will_reset: true });
    expect(itemOf(pre, c.cakeB)).toMatchObject({ status: 'match', recipe_locked: true, stages_will_reset: false });
    expect(pre.summary.stages_will_reset).toBe(1);

    const beforeA = await rows(c.cakeA);
    await apply(pm, { product_ids: [c.cakeA, c.cakeB] });

    // A: untouched, still locked, with the Uzbek reason.
    expect(await rows(c.cakeA)).toEqual(beforeA);
    expect(await isLocked(c.cakeA)).toBe(true);
    const { last_apply_report: r1 } = await getState(pm);
    expect(itemOf(r1!, c.cakeA)).toMatchObject({
      apply_result: 'skipped',
      apply_message: "Hamir/Krem/Bezak bo'linishi yo'qolardi — alohida tasdiq bilan yangilang.",
    });
    // B: applied, unlocked, the flour split 0.1 base / 0.4 decoration kept.
    expect(await isLocked(c.cakeB)).toBe(false);
    expect(await rows(c.cakeB)).toEqual([
      { component: c.flour, qty: 0.1, brutto: 0.1, stage: 'base' },
      { component: c.flour, qty: 0.4, brutto: 0.4, stage: 'decoration' },
      { component: c.krem, qty: 0.3, brutto: 0.3, stage: 'decoration' },
    ]);
    expect(await withTransaction((tx) => findZagatovkaComponent(tx, c.cakeB))).toEqual(zagB);

    // With the separate confirmation, A is reset to a flat recipe and unlocked.
    await apply(pm, { product_ids: [c.cakeA], include_stage_resets: true });
    expect(await isLocked(c.cakeA)).toBe(false);
    expect((await rows(c.cakeA)).every((r) => r.stage === 'base')).toBe(true);
    expect((await rows(c.cakeA)).map((r) => r.component).sort()).toEqual([c.flour, c.krem].sort());
  });

  it('Y3: a product whose recipe changed after the pre-audit is skipped inside its transaction', async () => {
    const s = await seed();
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    // The cake (menu, audited AFTER медовик) blocks the pre-audit on its tech card.
    stubPoster({ productGate: { id: '800', reached, wait } });
    const pm = await token('pm');

    const res = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pm}`).send({ product_ids: [s.medovik, s.cake] });
    expect(res.status).toBe(202);
    await reachedP;
    // Someone edits медовик after it was audited.
    await ctx.db.query('UPDATE recipes SET qty_per_unit = 2, brutto = 2 WHERE product_id = $1', [s.medovik]);
    release();
    await whenRecipeAuditIdle();

    expect(await rows(s.medovik)).toEqual([{ component: s.zg, qty: 2, brutto: 2, stage: 'base' }]);
    expect(await isLocked(s.medovik)).toBe(true);
    const { last_apply_report: report } = await getState(pm);
    expect(itemOf(report!, s.medovik)).toMatchObject({
      apply_result: 'skipped', apply_message: "Retsept tekshiruvdan keyin o'zgargan",
    });
    expect(itemOf(report!, s.cake)).toMatchObject({ apply_result: 'applied' });
  });

  it('Y7: a product row held by another transaction is skipped after lock_timeout', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    let free!: () => void;
    const freeP = new Promise<void>((r) => { free = r; });
    const holder = withTransaction(async (tx) => {
      await tx.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [s.medovik]);
      locked();
      await freeP;
    });
    await lockedP;
    try {
      await apply(pm, { product_ids: [s.medovik, s.cake] });
    } finally {
      free();
      await holder;
    }
    expect(await isLocked(s.medovik)).toBe(true);
    const { last_apply_report: report } = await getState(pm);
    expect(itemOf(report!, s.medovik)).toMatchObject({
      apply_result: 'skipped', apply_message: "Mahsulot band — keyinroq urinib ko'ring",
    });
    expect(itemOf(report!, s.cake)).toMatchObject({ apply_result: 'applied' });
  }, 30_000);

  it('Y5: a later dry run by production_manager does not wipe the apply results', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    await apply(pm, { product_ids: [s.medovik] });
    const pmgr = await token('production_manager');
    await runAudit(pmgr);
    const state = await getState(pmgr);
    expect(state.job).toMatchObject({ kind: 'audit' });
    expect(itemOf(state.report!, s.medovik)!.apply_result).toBeUndefined();
    expect(itemOf(state.last_apply_report!, s.medovik)!.apply_result).toBe('applied');
  });
});

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

describe('recipe bulk restore', () => {
  it('Y4: apply then restore gives back exactly the original rows, stages and locks (after a restart)', async () => {
    const s = await seed();
    // медовик gets a stage split that the apply resets (confirmed separately).
    await ctx.db.query(`UPDATE recipes SET stage = 'decoration' WHERE product_id = $1`, [s.medovik]);
    const before = { medovik: await rows(s.medovik), cake: await rows(s.cake) };
    stubPoster();
    const pm = await token('pm');

    const jobId = await apply(pm, { product_ids: [s.medovik, s.cake], include_stage_resets: true });
    expect(await isLocked(s.medovik)).toBe(false);
    expect(await rows(s.medovik)).not.toEqual(before.medovik);

    resetRecipeAuditForTests(); // the in-memory state is gone (PM2 restart)
    expect((await getState(pm)).restorable_job_id).toBe(jobId);

    const res = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: jobId });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: 'restore', status: 'running' });
    await whenRecipeAuditIdle();

    expect(await rows(s.medovik)).toEqual(before.medovik);
    expect(await isLocked(s.medovik)).toBe(true);
    expect(await rows(s.cake)).toEqual(before.cake);
    expect(await isLocked(s.cake)).toBe(false);

    const { rows: audits } = await ctx.db.query<{ entity_id: string; payload: { job_id: string } }>(
      `SELECT entity_id, payload FROM audit_log WHERE action = 'poster.recipe.bulk_resync.restore'`,
    );
    expect(audits.map((a) => Number(a.entity_id)).sort()).toEqual([s.medovik, s.cake].sort());
    expect(audits.every((a) => a.payload.job_id === jobId)).toBe(true);

    const state = await getState(pm);
    expect(state.job).toMatchObject({ kind: 'restore', status: 'done' });
    expect(itemOf(state.last_apply_report!, s.medovik)).toMatchObject({ apply_result: 'restored', status: 'differs', recipe_locked: true });
    expect(state.last_apply_report!.summary).toMatchObject({ restored: 2, skipped: 0 });
    expect(state.last_apply_report!.summary.applied).toBeUndefined();
  });

  it('skips a product edited after the apply, restores the rest; product_ids narrows the set', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    const jobId = await apply(pm, { product_ids: [s.medovik, s.cake] });
    await ctx.db.query('UPDATE recipes SET qty_per_unit = 0.3, brutto = 0.3 WHERE product_id = $1', [s.cake]);

    const res = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`)
      .send({ job_id: jobId, product_ids: [s.cake, s.medovik, s.biskvit] });
    expect(res.status).toBe(202);
    await whenRecipeAuditIdle();

    expect(await rows(s.cake)).toEqual([{ component: s.flour, qty: 0.3, brutto: 0.3, stage: 'base' }]);
    expect(await isLocked(s.medovik)).toBe(true);
    const { last_apply_report: report } = await getState(pm);
    expect(itemOf(report!, s.cake)).toMatchObject({ apply_result: 'skipped', apply_message: "Retsept yangilashdan keyin o'zgargan — tiklanmadi" });
    expect(itemOf(report!, s.medovik)).toMatchObject({ apply_result: 'restored' });
    expect(itemOf(report!, s.biskvit)).toMatchObject({ apply_result: 'skipped', apply_message: "Bu mahsulot o'sha yangilashda o'zgartirilmagan" });
  });

  it('validates the body and the job id; pm only', async () => {
    await seed();
    stubPoster();
    const pm = await token('pm');
    expect((await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({})).status).toBe(422);
    const unknown = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: 'no-such-job' });
    expect(unknown.status).toBe(404);
    const pmgr = await token('production_manager');
    expect((await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pmgr}`).send({ job_id: 'x' })).status).toBe(403);
  });
});

// -----------------------------------------------------------------------------
// Round 4: rounding parity, lost lock, restorability, degraded final audit
// -----------------------------------------------------------------------------

/** Kill the session that holds the recipe advisory lock (what a PG restart does). */
async function terminateLockHolder(): Promise<number> {
  const { rows: r } = await ctx.db.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND objid::bigint = $1::bigint AND classid::bigint = 0`,
    [POSTER_RECIPE_LOCK_KEY],
  );
  for (const x of r) await ctx.db.query('SELECT pg_terminate_backend($1)', [x.pid]);
  return r.length;
}

describe('round 4', () => {
  it('R1: quantities on the 4th-decimal boundary round-trip DB -> audit as match; a 2nd apply is a no-op', async () => {
    const pids = [71, 72, 73, 74];
    const grams = [1.45, 3.55, 8.45, 10.45];
    const ingr: number[] = [];
    for (const [i, pid] of pids.entries()) ingr.push(await mkProduct(`ingr ${i}`, { type: 'raw', ping: pid }));
    const p = await mkProduct('Krem X', { ppid: 920, locked: true });
    await addLine(p, ingr[0]!, 0.5);
    stubPoster({
      extraPrepacks: [{
        product_id: '920', ingredient_id: '0', product_name: 'Krem X', out: 1000,
        ingredients: pids.map((pid, i) => line({ ingredient_id: String(pid), ingredient_name: `ingr ${i}`, structure_brutto: grams[i]! })),
      }],
    });
    const pm = await token('pm');

    await apply(pm, { product_ids: [p] });
    expect((await rows(p)).map((r) => r.qty)).toEqual([0.0015, 0.0035, 0.0085, 0.0105]);
    const { report } = await getState(pm);
    expect(itemOf(report!, p)).toMatchObject({ status: 'match', apply_result: 'applied' });
    expect(itemOf(report!, p)!.lines.every((l) => l.diff === 'same')).toBe(true);

    await apply(pm, { product_ids: [p] });
    const { last_apply_report: second } = await getState(pm);
    expect(itemOf(second!, p)).toMatchObject({ status: 'match', apply_result: 'skipped' });
    const { rows: resyncs } = await ctx.db.query(
      `SELECT 1 FROM audit_log WHERE action = 'product.recipe.poster_resync' AND entity_id = $1`, [p],
    );
    expect(resyncs).toHaveLength(1);
  });

  it('R2: a dropped lock connection stops the job before any write (failed, results kept, no crash)', async () => {
    const s = await seed();
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    stubPoster({ productGate: { id: '800', reached, wait } });
    const pm = await token('pm');

    const res = await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pm}`).send({ product_ids: [s.medovik, s.cake] });
    expect(res.status).toBe(202);
    await reachedP;
    expect(await terminateLockHolder()).toBe(1);
    await new Promise((r) => setTimeout(r, 300)); // let the client see the dead socket
    release();
    await whenRecipeAuditIdle();

    const state = await getState(pm);
    expect(state.job).toMatchObject({ kind: 'apply', status: 'failed' });
    expect(String(state.job!.error)).toMatch(/^Retsept qulfi/);
    expect(state.last_apply_report).not.toBeNull();
    expect(await isLocked(s.medovik)).toBe(true);
    expect(await rows(s.medovik)).toEqual([{ component: s.zg, qty: 1, brutto: 1, stage: 'base' }]);
    // The lock is free again for the next job.
    const next = await acquirePosterRecipeLock();
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('R3: restorable_job_id skips a job that changed nothing and moves off after a full restore', async () => {
    const c = await seedCakes();
    stubPoster({ extraPrepacks: CAKE_PREPACKS });
    const pm = await token('pm');

    const job1 = await apply(pm, { product_ids: [c.cakeB] }); // applied
    const job2 = await apply(pm, { product_ids: [c.cakeA] }); // snapshot, but the split reset is refused
    expect(job2).not.toBe(job1);
    const { rows: snaps } = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'poster.recipe.bulk_resync.snapshot'`);
    expect(snaps).toHaveLength(2);
    expect((await getState(pm)).restorable_job_id).toBe(job1);

    const res = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: job1 });
    expect(res.status).toBe(202);
    await whenRecipeAuditIdle();
    expect(await isLocked(c.cakeB)).toBe(true);
    expect((await getState(pm)).restorable_job_id).toBeNull();

    // Restoring again says so instead of a misleading "changed".
    await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: job1 });
    await whenRecipeAuditIdle();
    const { last_apply_report: again } = await getState(pm);
    expect(itemOf(again!, c.cakeB)).toMatchObject({ apply_result: 'skipped', apply_message: 'Allaqachon tiklangan' });
  });

  it('R4: a restore whose closing audit fails (Poster down) is still done, with a non-empty report', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    const jobId = await apply(pm, { product_ids: [s.medovik, s.cake] });

    stubPoster({ failPrepacks: true });
    const res = await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: jobId });
    expect(res.status).toBe(202);
    await whenRecipeAuditIdle();

    const state = await getState(pm);
    expect(state.job).toMatchObject({ kind: 'restore', status: 'done' });
    expect(await isLocked(s.medovik)).toBe(true);
    const report = state.last_apply_report!;
    expect(report.summary).toMatchObject({ restored: 2, skipped: 0 });
    const med = itemOf(report, s.medovik)!;
    expect(med).toMatchObject({ product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ', apply_result: 'restored', recipe_locked: true });
    expect(med.warnings[0]).toMatch(/^Yakuniy tekshiruv bajarilmadi \(Poster bilan bog'lanib bo'lmadi/);
    expect(med.warnings[0]).toMatch(/— qayta tekshiring$/);
  });

  it('N4: a restore that would close a BOM cycle is skipped', async () => {
    const s = await seed();
    stubPoster();
    const pm = await token('pm');
    const jobId = await apply(pm, { product_ids: [s.medovik] });
    // Meanwhile z/g медовик got a recipe containing медовик: restoring медовик -> z/g closes a cycle.
    await addLine(s.zg, s.medovik, 0.1);
    await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${pm}`).send({ job_id: jobId });
    await whenRecipeAuditIdle();
    const { last_apply_report: report } = await getState(pm);
    expect(itemOf(report!, s.medovik)!.apply_result).toBe('skipped');
    expect(itemOf(report!, s.medovik)!.apply_message).toMatch(/sikl/);
    expect(await isLocked(s.medovik)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// RBAC
// -----------------------------------------------------------------------------

describe('recipe audit RBAC', () => {
  it('production_manager can audit and read but not apply/restore; store_manager can do nothing', async () => {
    const s = await seed();
    stubPoster();
    const pmgr = await token('production_manager');
    expect((await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${pmgr}`).send({})).status).toBe(202);
    await whenRecipeAuditIdle();
    expect((await request(ctx.app).get(BASE).set('Authorization', `Bearer ${pmgr}`)).status).toBe(200);
    expect((await request(ctx.app).get(`${BASE}/job`).set('Authorization', `Bearer ${pmgr}`)).status).toBe(200);
    expect((await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${pmgr}`).send({ product_ids: [s.medovik] })).status).toBe(403);

    const sm = await token('store_manager');
    expect((await request(ctx.app).post(`${BASE}/run`).set('Authorization', `Bearer ${sm}`).send({})).status).toBe(403);
    expect((await request(ctx.app).post(`${BASE}/apply`).set('Authorization', `Bearer ${sm}`).send({ product_ids: [s.medovik] })).status).toBe(403);
    expect((await request(ctx.app).post(`${BASE}/restore`).set('Authorization', `Bearer ${sm}`).send({ job_id: 'x' })).status).toBe(403);
    expect((await request(ctx.app).get(BASE).set('Authorization', `Bearer ${sm}`)).status).toBe(403);
    expect((await request(ctx.app).get(`${BASE}/job`).set('Authorization', `Bearer ${sm}`)).status).toBe(403);
  });
});
