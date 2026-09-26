/**
 * Integration tests for the Poster seed/bootstrap sync (M7).
 *
 * The Poster client is mocked through `fetcher` — every test feeds a synthetic
 * Poster response and asserts that ADIA `locations`, `products`, `recipes`,
 * and `poster_sync_log` end up in the expected state.
 *
 * Idempotency is verified by running the sync twice in the same test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import { withTransaction } from '../src/db/index.js';
import { readFinalBom } from '../src/services/bom.js';
import {
  syncSpots,
  syncStorages,
  syncIngredients,
  syncPrepacks,
  syncMenuProducts,
} from '../src/integrations/poster/seedSync.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Wipe everything M7 writes between tests.
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM poster_sync_log');
});

/**
 * Build a `PosterClient` whose fetcher returns a static map of method ->
 * response payload. Unknown methods produce a Poster error envelope so a
 * missing setup surfaces clearly.
 */
function clientForResponses(map: Record<string, unknown>): PosterClient {
  return new PosterClient({
    token: 'acc:test-token',
    minIntervalMs: 0,
    fetcher: ((url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      const method = u.pathname.split('/').pop() ?? '';
      if (method in map) {
        return Promise.resolve(
          new Response(JSON.stringify({ response: map[method] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch,
  });
}

describe('Poster seedSync — spots', () => {
  it('upserts spots into locations(type=store) and is idempotent', async () => {
    const client = clientForResponses({
      'access.getSpots': [
        { spot_id: '1', name: 'Кукча', spot_name: 'Кукча' },
        { spot_id: '2', name: 'Рабочий', spot_name: 'Рабочий' },
      ],
    });

    const r1 = await syncSpots(client);
    expect(r1.status).toBe('ok');
    expect(r1.recordsApplied).toBe(2);

    const { rows: first } = await ctx.db.query<{ id: number; name: string; type: string; poster_spot_id: number }>(
      `SELECT id, name, type, poster_spot_id FROM locations ORDER BY poster_spot_id`,
    );
    expect(first).toHaveLength(2);
    expect(first[0]?.type).toBe('store');
    expect(first[0]?.poster_spot_id).toBe(1);

    // Second run — same Poster payload, no new rows, name update wins.
    const r2 = await syncSpots(client);
    expect(r2.status).toBe('ok');
    const { rows: second } = await ctx.db.query<{ id: number }>(`SELECT id FROM locations`);
    expect(second).toHaveLength(2);

    // sync log row exists for both runs.
    const { rows: logs } = await ctx.db.query<{ status: string; records_applied: number; entity: string }>(
      `SELECT status, records_applied, entity FROM poster_sync_log WHERE entity='spots' ORDER BY id`,
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]?.status).toBe('ok');
  });

  it('records failed status when the Poster call errors', async () => {
    const client = clientForResponses({}); // empty -> error 30
    const r = await syncSpots(client);
    expect(r.status).toBe('failed');
    expect(r.errorDetail).toContain('Method Not Allowed');
    const { rows } = await ctx.db.query<{ status: string; error_detail: string }>(
      `SELECT status, error_detail FROM poster_sync_log WHERE entity='spots'`,
    );
    expect(rows[0]?.status).toBe('failed');
  });
});

describe('Poster seedSync — storages (ADR-0017 classification)', () => {
  it('classifies storages at insert time and keeps a PM reclassification on re-run', async () => {
    const client = clientForResponses({
      'storage.getStorages': [
        { storage_id: '2', storage_name: 'Основной склад' }, // raw_warehouse
        { storage_id: '8', storage_name: 'Склад Центральный' }, // central_warehouse
        { storage_id: '20', storage_name: 'Производственный Цех' }, // production
        { storage_id: '19', storage_name: 'Склад Тортов' }, // sex_storage
        { storage_id: '777', storage_name: 'Склад Новый' }, // unknown -> default sex_storage
      ],
    });
    await syncStorages(client);

    const { rows: first } = await ctx.db.query<{ type: string; poster_storage_id: number }>(
      `SELECT type, poster_storage_id FROM locations ORDER BY poster_storage_id`,
    );
    expect(first.find((r) => r.poster_storage_id === 2)?.type).toBe('raw_warehouse');
    expect(first.find((r) => r.poster_storage_id === 8)?.type).toBe('central_warehouse');
    expect(first.find((r) => r.poster_storage_id === 20)?.type).toBe('production');
    expect(first.find((r) => r.poster_storage_id === 19)?.type).toBe('sex_storage');
    // Unknown id falls back to the safe default.
    expect(first.find((r) => r.poster_storage_id === 777)?.type).toBe('sex_storage');

    // PM reclassifies storage 19 as a `central_warehouse` by mistake-fix.
    await ctx.db.query(`UPDATE locations SET type='raw_warehouse' WHERE poster_storage_id=19`);

    // Second run must NOT overwrite the PM's classification — only name updates.
    await syncStorages(client);
    const { rows: second } = await ctx.db.query<{ type: string; poster_storage_id: number }>(
      `SELECT type, poster_storage_id FROM locations ORDER BY poster_storage_id`,
    );
    expect(second.find((r) => r.poster_storage_id === 19)?.type).toBe('raw_warehouse');
    // No duplicate rows on re-run.
    expect(second.filter((r) => r.poster_storage_id === 19)).toHaveLength(1);
  });

  it('merges store-backing storages (3/4/5) onto their POS spot rows (P2)', async () => {
    // Spots first (runSeedSync order), then storages.
    const client = clientForResponses({
      'access.getSpots': [
        { spot_id: '1', spot_name: 'Кукча' },
        { spot_id: '2', spot_name: 'Рабочий' },
        { spot_id: '3', spot_name: 'Чигатай' },
      ],
      'storage.getStorages': [
        { storage_id: '3', storage_name: 'Склад Кукча' },
        { storage_id: '4', storage_name: 'Склад Рабочий' },
        { storage_id: '5', storage_name: 'Склад Чигатай' },
      ],
    });
    await syncSpots(client);
    await syncStorages(client);

    const { rows } = await ctx.db.query<{
      type: string;
      poster_spot_id: number | null;
      poster_storage_id: number | null;
    }>(`SELECT type, poster_spot_id, poster_storage_id FROM locations ORDER BY poster_spot_id`);

    // No standalone storage rows were created — exactly the 3 spot rows exist.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === 'store')).toBe(true);
    // Each spot now carries its backing storage id (sales + stock co-located).
    expect(rows.find((r) => r.poster_spot_id === 1)?.poster_storage_id).toBe(3);
    expect(rows.find((r) => r.poster_spot_id === 2)?.poster_storage_id).toBe(4);
    expect(rows.find((r) => r.poster_spot_id === 3)?.poster_storage_id).toBe(5);
  });

  it('store-backing merge is idempotent and survives a spot re-sync', async () => {
    const client = clientForResponses({
      'access.getSpots': [{ spot_id: '1', spot_name: 'Кукча' }],
      'storage.getStorages': [{ storage_id: '3', storage_name: 'Склад Кукча' }],
    });
    await syncSpots(client);
    await syncStorages(client);
    // Re-run both in either order — still one row, storage id intact.
    await syncStorages(client);
    await syncSpots(client);

    const { rows } = await ctx.db.query<{
      poster_spot_id: number | null;
      poster_storage_id: number | null;
    }>(`SELECT poster_spot_id, poster_storage_id FROM locations`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.poster_spot_id).toBe(1);
    expect(rows[0]?.poster_storage_id).toBe(3);
  });
});

describe('Poster seedSync — ingredients_type filter (C5)', () => {
  // Sprint 3 audit: `menu.getIngredients` returns BOTH raw ingredients
  // (ingredients_type=1) AND semi-finished prepacks (ingredients_type=2).
  // syncIngredients must skip type=2 — otherwise it would create a
  // `products(type='raw')` row that later collides with `syncPrepacks` on
  // the partial UNIQUE on `poster_ingredient_id` and crash the seed.
  it('imports only ingredients_type=1; type=2 prepacks land via syncPrepacks without collision', async () => {
    const client = clientForResponses({
      // Mixed list — one raw (type=1), one prepack (type=2). Real Poster
      // payload is what surfaced this bug.
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg', ingredients_type: 1 },
        { ingredient_id: 600, ingredient_name: 'Dough base', ingredient_unit: 'kg', ingredients_type: 2 },
      ],
      // The matching prepack — `ingredient_id=600` collides with the row
      // skipped above so syncPrepacks can claim it safely.
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 1,
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.5,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    const rIng = await syncIngredients(client);
    expect(rIng.status).toBe('ok');
    // Only Flour was imported as raw; the type=2 row was skipped.
    expect(rIng.recordsApplied).toBe(1);
    const { rows: rawProducts } = await ctx.db.query<{
      id: number;
      type: string;
      poster_ingredient_id: number;
    }>(`SELECT id, type, poster_ingredient_id FROM products`);
    expect(rawProducts).toHaveLength(1);
    expect(rawProducts[0]?.type).toBe('raw');
    expect(rawProducts[0]?.poster_ingredient_id).toBe(100);

    // The prepack now lands as `type='semi'`. No UNIQUE-violation crash.
    const rPre = await syncPrepacks(client);
    expect(rPre.status).toBe('ok');
    expect(rPre.recordsApplied).toBe(1);

    const { rows: allProducts } = await ctx.db.query<{
      type: string;
      poster_product_id: number | null;
      poster_ingredient_id: number | null;
    }>(`SELECT type, poster_product_id, poster_ingredient_id FROM products ORDER BY id`);
    const prepack = allProducts.find((p) => p.poster_product_id === 500);
    expect(prepack?.type).toBe('semi');
    expect(prepack?.poster_ingredient_id).toBe(600);
  });

  it('upsertPrepack does not crash when a raw row already holds the same poster_ingredient_id', async () => {
    // Pre-seed a raw row that ALREADY occupies `poster_ingredient_id=600`.
    // This is the worst-case version of the bug above — what happens when
    // the seed is run on a database that was once filled by the buggy
    // version that imported type=2 as raw. The new upsertPrepack must
    // upgrade the existing row (raw -> semi) rather than try to INSERT a
    // duplicate that violates the partial UNIQUE.
    await ctx.db.query(
      `INSERT INTO products (name, type, unit, poster_ingredient_id)
       VALUES ('Dough base (legacy)', 'raw', 'kg', 600)`,
    );
    const client = clientForResponses({
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 1,
          ingredients: [], // BOM doesn't matter for this test.
        },
      ],
    });
    const r = await syncPrepacks(client);
    expect(r.status).toBe('ok');
    const { rows } = await ctx.db.query<{
      id: number;
      type: string;
      poster_product_id: number | null;
      poster_ingredient_id: number | null;
    }>(`SELECT id, type, poster_product_id, poster_ingredient_id FROM products`);
    expect(rows).toHaveLength(1);
    // Same row, upgraded from raw -> semi, with poster_product_id now filled.
    expect(rows[0]?.type).toBe('semi');
    expect(rows[0]?.poster_product_id).toBe(500);
    expect(rows[0]?.poster_ingredient_id).toBe(600);
  });
});

describe('Poster seedSync — ingredients + prepacks (BOM)', () => {
  it('imports ingredients, then a prepack with its BOM (`out`-normalised)', async () => {
    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
        { ingredient_id: 101, ingredient_name: 'Sugar', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 2000, // 2000 units per batch
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'g',
              structure_type: '1',
              structure_brutto: 1000, // 1000 g -> 1 kg per batch -> 1/2 kg per kg of prepack
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
            {
              structure_id: 's2',
              ingredient_id: '101',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.4, // 0.4 kg/batch -> 0.4/2 kg per kg of prepack
              ingredient_name: 'Sugar',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    const rIng = await syncIngredients(client);
    expect(rIng.status).toBe('ok');
    expect(rIng.recordsApplied).toBe(2);

    const rPre = await syncPrepacks(client);
    expect(rPre.status).toBe('ok');
    expect(rPre.recordsApplied).toBe(1);

    const { rows: prods } = await ctx.db.query<{ id: number; type: string; poster_ingredient_id: number | null; poster_product_id: number | null }>(
      `SELECT id, type, poster_ingredient_id, poster_product_id FROM products ORDER BY id`,
    );
    expect(prods.find((p) => p.poster_ingredient_id === 100)?.type).toBe('raw');
    expect(prods.find((p) => p.poster_product_id === 500)?.type).toBe('semi');

    const { rows: recipes } = await ctx.db.query<{ qty_per_unit: number; component_product_id: number }>(
      `SELECT qty_per_unit, component_product_id FROM recipes ORDER BY component_product_id`,
    );
    expect(recipes).toHaveLength(2);
    // `out` is Poster's batch yield in GRAMS, so out=2000 is a 2 kg batch and
    // qty_per_unit is "component unit per 1 kg of finished prepack"
    // (migration 0040 batch_yield). It used to be "per 1 out unit", which read
    // a 2000 g batch as 2000 pieces and divided the recipe 1000x too far.
    // Flour: 1000 g (-> 1 kg) / 2 kg batch = 0.5 kg per kg
    expect(recipes[0]?.qty_per_unit).toBeCloseTo(0.5, 6);
    // Sugar: 0.4 kg / 2 kg batch = 0.2 kg per kg
    expect(recipes[1]?.qty_per_unit).toBeCloseTo(0.2, 6);
  });

  it('isolates per-prepack failures so one bad row does NOT poison the rest (Prove-It regression)', async () => {
    // Sprint 3 audit P1: against a real Poster account 1121 prepacks came
    // down the wire but only ~109 landed — every prepack AFTER the first
    // failure surfaced as "current transaction is aborted, commands ignored
    // until end of transaction block". Root cause: an inner `try/catch`
    // around `INSERT INTO recipes` inside `withTransaction` silently
    // swallowed the error message but left the tx aborted (Postgres only
    // allows a mid-tx recovery via SAVEPOINT). After the fix:
    //   - per-row SAVEPOINT inside `replaceRecipe` so a single bad recipe
    //     row does not abort the prepack's whole BOM;
    //   - per-prepack `try/catch` in `syncPrepacks` so a hard upsert
    //     failure on one prepack does not abort the loop;
    //   - `failedItems` captured and surfaced as `partial` + `errorDetail`.
    //
    // We engineer a hard failure on prepack #2 by forcing a NUMERIC(14,4)
    // overflow on `qty_per_unit` — `structure_brutto = 1e18`. The recipe
    // INSERT raises a numeric_value_out_of_range (22003) inside the
    // SAVEPOINT and is rolled back; the prepack itself still gets the
    // upsert (no BOM rows survive), so `recordsApplied` counts prepacks
    // attempted, but `failedItems` collects nothing for this case because
    // SAVEPOINT swallows the recipe row failure cleanly. To prove the
    // OUTER per-prepack catch we also force a true upsert failure on
    // prepack #3 by pre-seeding a row that collides on the partial UNIQUE
    // via a path the two-phase upsert CANNOT recover from.
    //
    // Pragmatic version: drive prepack #2 with a `qty_per_unit` overflow
    // that fails inside replaceRecipe's SAVEPOINT (proves SAVEPOINT fix),
    // and assert that prepack #1 AND prepack #3 BOTH land with recipes —
    // before the fix prepack #3 would have surfaced "transaction is
    // aborted" from prepack #2's poisoned outer tx.

    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        // 1. clean prepack — must land with its recipe.
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Good prepack A',
          out: 1000, // 1 kg batch (Poster reports `out` in grams)
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.5,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
        // 2. poisoned prepack — `structure_brutto = 1e18` overflows
        // NUMERIC(14,4). Without SAVEPOINT, this aborts the whole tx and
        // prepack #3 below would surface "transaction is aborted".
        {
          product_id: '502',
          ingredient_id: '602',
          product_name: 'Overflow prepack',
          out: 1000,
          ingredients: [
            {
              structure_id: 's2',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 1e18,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
        // 3. clean prepack — REGRESSION ASSERTION: this must land. Before
        // the fix prepack #2's aborted tx poisoned this whole iteration.
        {
          product_id: '503',
          ingredient_id: '603',
          product_name: 'Good prepack B',
          out: 2000, // 2 kg batch
          ingredients: [
            {
              structure_id: 's3',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 1,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    await syncIngredients(client);
    const r = await syncPrepacks(client);
    // All three prepacks were ATTEMPTED — none threw out to the outer
    // catch (SAVEPOINT contained the failure). recordsApplied counts
    // prepacks that finished their loop body.
    expect(r.recordsApplied).toBe(3);

    // All three prepack rows are in the DB (the upsert happens before
    // replaceRecipe).
    const { rows: prepacks } = await ctx.db.query<{ poster_product_id: number; type: string }>(
      `SELECT poster_product_id, type FROM products
        WHERE poster_product_id IN (500, 502, 503) ORDER BY poster_product_id`,
    );
    expect(prepacks.map((p) => p.poster_product_id)).toEqual([500, 502, 503]);
    expect(prepacks.every((p) => p.type === 'semi')).toBe(true);

    // The CRITICAL regression assertion: prepack #3's BOM landed. Before
    // the SAVEPOINT fix, prepack #2's overflow aborted the recipe tx and
    // prepack #3 surfaced "current transaction is aborted, commands
    // ignored until end of transaction block". After the fix, prepack #3
    // has its recipe row.
    const { rows: recipes } = await ctx.db.query<{
      product_id: number;
      qty_per_unit: string;
    }>(
      `SELECT r.product_id, r.qty_per_unit::text AS qty_per_unit
         FROM recipes r
         JOIN products p ON p.id = r.product_id
        WHERE p.poster_product_id IN (500, 503)
        ORDER BY p.poster_product_id`,
    );
    expect(recipes.length).toBe(2);
    // Prepack #1 — 0.5 kg into a 1 kg batch = 0.5 per kg
    expect(Number(recipes[0]?.qty_per_unit)).toBeCloseTo(0.5, 4);
    // Prepack #3 — 1 kg into a 2 kg batch = 0.5 per kg
    expect(Number(recipes[1]?.qty_per_unit)).toBeCloseTo(0.5, 4);

    // Prepack #2 has NO recipe (the row failed inside its SAVEPOINT and
    // was rolled back). This proves the SAVEPOINT scoping.
    const { rows: badRecipes } = await ctx.db.query<{ product_id: number }>(
      `SELECT r.product_id FROM recipes r
         JOIN products p ON p.id = r.product_id
        WHERE p.poster_product_id = 502`,
    );
    expect(badRecipes).toHaveLength(0);
  });

  it('skips a prepack component whose ingredient is not yet seeded', async () => {
    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough',
          out: 1000, // 1 kg batch
          ingredients: [
            { structure_id: 's1', ingredient_id: '100', structure_unit: 'kg', structure_type: '1', structure_brutto: 0.5, ingredient_name: 'Flour', ingredient_unit: 'kg' },
            { structure_id: 's2', ingredient_id: '999', structure_unit: 'kg', structure_type: '1', structure_brutto: 0.2, ingredient_name: 'Missing', ingredient_unit: 'kg' },
          ],
        },
      ],
    });
    await syncIngredients(client);
    await syncPrepacks(client);
    const { rows } = await ctx.db.query<{ qty_per_unit: number }>(`SELECT qty_per_unit FROM recipes`);
    // Only the resolvable component lands.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty_per_unit).toBeCloseTo(0.5, 6);
  });
});

describe('Poster seedSync — menu products + BOM import', () => {
  it('imports type=2 products with BOM and skips type=3 products', async () => {
    // Drive `menu.getProduct?product_id=...` per id via URL inspection.
    const client = new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const method = u.pathname.split('/').pop() ?? '';
        if (method === 'menu.getIngredients') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: [
                  { ingredient_id: 1000, ingredient_name: 'Cocoa', ingredient_unit: 'kg' },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (method === 'menu.getProducts') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: [
                  { product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500' },
                  { product_id: '801', product_name: 'Adia', type: '3', ingredient_id: '1600' },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (method === 'menu.getProduct') {
          const pid = u.searchParams.get('product_id');
          if (pid === '800') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  response: {
                    product_id: '800',
                    product_name: 'Cake',
                    type: '2',
                    ingredient_id: '1500',
                    ingredients: [
                      {
                        structure_id: 's1',
                        ingredient_id: '1000',
                        structure_unit: 'g',
                        structure_type: '1',
                        structure_brutto: 200,
                        ingredient_name: 'Cocoa',
                        ingredient_unit: 'kg',
                      },
                    ],
                  },
                }),
                { status: 200 },
              ),
            );
          }
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'not allowed' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });

    await syncIngredients(client);
    const r = await syncMenuProducts(client);
    expect(r.status).toBe('ok');
    expect(r.recordsApplied).toBe(2);

    const { rows: products } = await ctx.db.query<{ poster_product_id: number; type: string }>(
      `SELECT poster_product_id, type FROM products WHERE poster_product_id IS NOT NULL ORDER BY poster_product_id`,
    );
    expect(products).toHaveLength(2);

    const { rows: recipes } = await ctx.db.query<{ qty_per_unit: number; product_id: number; component_product_id: number }>(
      `SELECT qty_per_unit, product_id, component_product_id FROM recipes`,
    );
    expect(recipes).toHaveLength(1);
    // 200 g of cocoa converted to kg -> 0.2 kg per unit.
    expect(recipes[0]?.qty_per_unit).toBeCloseTo(0.2, 6);
  });
});

// -----------------------------------------------------------------------------
// Component resolution (id-space collisions), stage preservation, warnings.
// -----------------------------------------------------------------------------

async function mkProduct(
  name: string,
  opts: { type?: string; unit?: string; ppid?: number | null; ping?: number | null; locked?: boolean } = {},
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, recipe_locked)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, opts.type ?? 'semi', opts.unit ?? 'kg', opts.ppid ?? null, opts.ping ?? null, opts.locked ?? false],
  );
  return Number(rows[0]!.id);
}

async function recipeOf(posterProductId: number) {
  const { rows } = await ctx.db.query<{ component_product_id: string; qty_per_unit: string; stage: string }>(
    `SELECT r.component_product_id, r.qty_per_unit::text AS qty_per_unit, r.stage::text AS stage
       FROM recipes r JOIN products p ON p.id = r.product_id
      WHERE p.poster_product_id = $1 ORDER BY r.id`,
    [posterProductId],
  );
  return rows.map((r) => ({ component: Number(r.component_product_id), qty: Number(r.qty_per_unit), stage: r.stage }));
}

const MEDOVIK_PREPACK = {
  product_id: '978',
  ingredient_id: '2402',
  product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
  out: 1000,
  ingredients: [
    {
      structure_id: '1', ingredient_id: '1101', structure_unit: 'g', structure_type: '2',
      structure_brutto: 115.3, structure_netto: 0,
      ingredient_name: 'медовик шок черный тесто', ingredient_unit: 'kg',
    },
    {
      structure_id: '2', ingredient_id: '1102', structure_unit: 'g', structure_type: '2',
      structure_brutto: 63.88, structure_netto: 1000,
      ingredient_name: 'медовик шок крем', ingredient_unit: 'kg',
    },
  ],
};

describe('Poster seedSync — component resolution + stages', () => {
  it('syncPrepacks binds the right product on an id collision (type-2 component)', async () => {
    // 1102: product_id row is the real крем, ingredient_id row is unrelated.
    const p1 = await mkProduct('медовик шок крем', { ppid: 1102 });
    await mkProduct('медовик сметанный крем', { ping: 1102 });
    // 1101: the product_id row carries a DIFFERENT name, the ingredient_id row
    // matches Poster's name — the name check must win over the id priority.
    await mkProduct('бисквит ванильный', { ppid: 1101 });
    const testo = await mkProduct('медовик шок черный тесто', { ping: 1101 });

    const r = await syncPrepacks(clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] }));
    expect(r.status).toBe('ok');
    const recipe = await recipeOf(978);
    expect(recipe.map((l) => l.component).sort()).toEqual([p1, testo].sort());
    // Brutto-based: крем 63.88 g / 1 kg batch (never the 1000 g netto).
    expect(recipe.find((l) => l.component === p1)?.qty).toBeCloseTo(0.0639, 4);
  });

  it('syncMenuProducts: type-1 component takes the id-space row that matches by name (mirror case)', async () => {
    await mkProduct('сахар', { type: 'raw', ping: 55 });
    const cocoa = await mkProduct('какао порошок', { type: 'raw', ppid: 55 });
    // A type-2 component on a MENU product: the NAME decides between the id
    // spaces (the fallback order only matters when neither name matches).
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    await mkProduct('медовик сметанный крем', { ping: 1102 });

    const client = clientForResponses({
      'menu.getProducts': [{ product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500' }],
      'menu.getProduct': {
        product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500',
        ingredients: [
          {
            structure_id: 's1', ingredient_id: '55', structure_unit: 'g', structure_type: '1',
            structure_brutto: 200, structure_netto: 200, ingredient_name: 'Какао порошок', ingredient_unit: 'kg',
          },
          {
            structure_id: 's2', ingredient_id: '1102', structure_unit: 'g', structure_type: '2',
            structure_brutto: 300, structure_netto: 1000, ingredient_name: 'медовик шок крем', ingredient_unit: 'kg',
          },
        ],
      },
    });
    const r = await syncMenuProducts(client);
    expect(r.status).toBe('ok');
    const recipe = await recipeOf(800);
    expect(recipe.map((l) => l.component).sort()).toEqual([cocoa, krem].sort());
    expect(recipe.find((l) => l.component === krem)?.qty).toBeCloseTo(0.3, 4);
  });

  it('E1 regression: menu type-2 line, names match neither id space -> OLD ingredient-first binding', async () => {
    await mkProduct('AAA product-space row', { ppid: 1102 });
    const byPing = await mkProduct('BBB ingredient-space row', { ping: 1102 });
    const client = clientForResponses({
      'menu.getProducts': [{ product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500' }],
      'menu.getProduct': {
        product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500',
        ingredients: [{
          structure_id: 's', ingredient_id: '1102', structure_unit: 'g', structure_type: '2',
          structure_brutto: 300, structure_netto: 300, ingredient_name: 'zzz poster name', ingredient_unit: 'kg',
        }],
      },
    });
    await syncMenuProducts(client);
    expect((await recipeOf(800)).map((l) => l.component)).toEqual([byPing]);
  });

  it('the hourly sync keeps ERP-set stages when the composition is unchanged', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
       VALUES ($1, $2, 0.2, 0.2, 'base'), ($1, $3, 0.5, 0.5, 'decoration')`,
      [parent, testo, krem],
    );

    await syncPrepacks(clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] }));
    const recipe = await recipeOf(978);
    expect(recipe.find((l) => l.component === krem)?.stage).toBe('decoration');
    expect(recipe.find((l) => l.component === testo)?.stage).toBe('base');
    const finalBom = await withTransaction((tx) => readFinalBom(tx, parent));
    expect(finalBom.map((l) => l.component_product_id)).toEqual([krem]);
    expect(finalBom[0]!.qty_per_unit).toBeCloseTo(0.0639, 4);
  });

  it('Y1: the hourly sync keeps a component split across stages, distributing the new total', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    // крем split 1:3 between base and decoration; Poster's total is 0.06388.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage) VALUES
        ($1, $2, 0.2, 0.2, 'base'), ($1, $3, 0.1, 0.1, 'base'), ($1, $3, 0.3, 0.3, 'decoration')`,
      [parent, testo, krem],
    );
    await syncPrepacks(clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] }));
    const rows = (await recipeOf(978)).filter((l) => l.component === krem).sort((a, b) => a.stage.localeCompare(b.stage));
    expect(rows.map((l) => l.stage)).toEqual(['base', 'decoration']);
    expect(rows[0]!.qty).toBeCloseTo(0.016, 4); // 0.06388 / 4
    expect(rows[1]!.qty).toBeCloseTo(0.0479, 4); // 0.06388 * 3/4
    const finalBom = await withTransaction((tx) => readFinalBom(tx, parent));
    expect(finalBom.map((l) => l.component_product_id)).toEqual([krem]);
  });

  it('Y6: the hourly sync records a warning when 4-decimal rounding changes a value by >10%', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    const parent = await mkProduct('Vanil krem', { ppid: 990 });
    await mkProduct('ванилин', { type: 'raw', ping: 61 });
    await syncPrepacks(clientForResponses({
      'menu.getPrepacks': [{
        product_id: '990', ingredient_id: '0', product_name: 'Vanil krem', out: 1000,
        ingredients: [{
          structure_id: 'v', ingredient_id: '61', structure_unit: 'g', structure_type: '1',
          structure_brutto: 0.06, structure_netto: 0.06, ingredient_name: 'ванилин', ingredient_unit: 'kg',
        }],
      }],
    }));
    const { rows } = await ctx.db.query<{ message: string; entity: string }>(
      `SELECT message, entity FROM import_warnings WHERE source = 'poster.recipe'`,
    );
    expect(rows).toEqual([{
      entity: `product:${parent}`,
      message: "ERP: 'ванилин' miqdori 4 xonaga yaxlitlanganda 10% dan ko'p o'zgardi: 0.00006 → 0.0001",
    }]);
  });

  it('R6: the hourly sync never flattens a stage split — it skips the recipe and records ONE warning', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
       VALUES ($1, $2, 0.5, 0.5, 'decoration')`,
      [parent, krem],
    );

    const client = clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] });
    await syncPrepacks(client);
    await syncPrepacks(client); // second hourly run: still skipped, no duplicate warning

    // Current rows kept exactly (the owner opts in on the audit page).
    expect(await recipeOf(978)).toEqual([{ component: krem, qty: 0.5, stage: 'decoration' }]);
    const { rows } = await ctx.db.query<{ message: string; entity: string }>(
      `SELECT message, entity FROM import_warnings WHERE source = 'poster.recipe'`,
    );
    expect(rows).toEqual([{
      entity: `product:${parent}`,
      message: "Poster tarkibi o'zgardi, lekin retseptda Hamir/Krem/Bezak bo'linishi bor — 'Poster bilan solishtirish' sahifasida tasdiqlang",
    }]);
    const { rows: audits } = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'poster.recipe.import' AND entity_id = $1`, [parent]);
    expect(audits).toHaveLength(0);
  });

  it('R6: an all-base recipe is never blocked; a rewrite that changes rows audits the previous rows', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402 });
    const testo = await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем', { ppid: 1102 });
    const zg = await mkProduct('з/г медовик', { unit: 'pcs' });
    // 'other' / 'dough' carry no split (both are the hamir section).
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
       VALUES ($1, $2, 1, 1, 'other'), ($1, $3, 0.2, 0.2, 'dough')`,
      [parent, zg, testo],
    );
    const client = clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] });
    await syncPrepacks(client);
    const recipe = await recipeOf(978);
    expect(recipe.map((l) => l.component).sort()).toEqual([testo, krem].sort());
    expect(recipe.every((l) => l.stage === 'base')).toBe(true);

    const { rows: first } = await ctx.db.query<{ payload: { previous_components?: Array<{ component_product_id: number; stage: string }> } }>(
      `SELECT payload FROM audit_log WHERE action = 'poster.recipe.import' AND entity_id = $1 ORDER BY id`,
      [parent],
    );
    expect(first).toHaveLength(1);
    expect(first[0]!.payload.previous_components!.map((r) => [r.component_product_id, r.stage]).sort())
      .toEqual([[zg, 'other'], [testo, 'dough']].sort());

    // An identical hourly rewrite keeps the audit row small (nothing changed).
    await syncPrepacks(client);
    const { rows: all } = await ctx.db.query<{ payload: { previous_components?: unknown } }>(
      `SELECT payload FROM audit_log WHERE action = 'poster.recipe.import' AND entity_id = $1 ORDER BY id`,
      [parent],
    );
    expect(all).toHaveLength(2);
    expect(all[1]!.payload.previous_components).toBeUndefined();
  });

  it('records a name-only binding as an import warning', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('медовик шок крем'); // no Poster ids at all
    await syncPrepacks(clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] }));
    expect((await recipeOf(978)).map((l) => l.component)).toContain(krem);
    const { rows } = await ctx.db.query<{ message: string; entity: string }>(
      `SELECT message, entity FROM import_warnings WHERE source = 'poster.recipe'`,
    );
    expect(rows).toEqual([{
      entity: `product:${krem}`,
      message: "Poster: 'медовик шок крем' → ERP: 'медовик шок крем' (faqat nomi bo'yicha bog'landi — Poster ID 1102 ERP'da yo'q)",
    }]);
  });

  it('logs merged duplicate Poster lines', async () => {
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    await mkProduct('медовик шок крем', { ppid: 1102 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await syncPrepacks(clientForResponses({
        'menu.getPrepacks': [{
          ...MEDOVIK_PREPACK,
          ingredients: [...MEDOVIK_PREPACK.ingredients, { ...MEDOVIK_PREPACK.ingredients[1]!, structure_id: '3' }],
        }],
      }));
      expect(log.mock.calls.some((c) => String(c[0]).includes('merged 2 Poster lines'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('still skips a locked recipe', async () => {
    const parent = await mkProduct('Г/П МЕДОВИК ШОК ЧЕРНЫЙ', { ppid: 978, ping: 2402, locked: true });
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    await mkProduct('медовик шок крем', { ppid: 1102 });
    const zg = await mkProduct('з/г медовик', { unit: 'pcs' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto) VALUES ($1, $2, 1, 1)`,
      [parent, zg],
    );
    await syncPrepacks(clientForResponses({ 'menu.getPrepacks': [MEDOVIK_PREPACK] }));
    expect(await recipeOf(978)).toEqual([{ component: zg, qty: 1, stage: 'base' }]);
  });

  it('records ONE import warning per mismatched component (N8), across recipes and runs', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    await mkProduct('медовик шок черный тесто', { ppid: 1101 });
    const krem = await mkProduct('крем шоколадный', { ppid: 1102 });
    // Two prepacks use the same mismatched component.
    const client = clientForResponses({
      'menu.getPrepacks': [
        MEDOVIK_PREPACK,
        { ...MEDOVIK_PREPACK, product_id: '979', ingredient_id: '2403', product_name: 'Г/П МЕДОВИК ШОК БЕЛЫЙ' },
      ],
    });

    await syncPrepacks(client);
    await syncPrepacks(client); // second hourly run must not add a duplicate row

    expect((await recipeOf(978)).map((l) => l.component)).toContain(krem);
    expect((await recipeOf(979)).map((l) => l.component)).toContain(krem);
    const { rows } = await ctx.db.query<{ source: string; message: string; entity: string }>(
      `SELECT source, message, entity FROM import_warnings WHERE source = 'poster.recipe'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity).toBe(`product:${krem}`);
    expect(rows[0]!.message).toBe("Poster: 'медовик шок крем' → ERP: 'крем шоколадный' (nomi mos emas)");
  });
});
