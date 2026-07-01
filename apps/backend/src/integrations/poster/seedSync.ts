/**
 * Initial seed/bootstrap from Poster (M7, spec section 4.9 — POST .../poster/sync).
 *
 * Each entity sync is idempotent: a second run UPDATEs the same rows by their
 * `poster_*` natural keys. We never DELETE — Poster is a single read-only
 * source, but operational decisions in ADIA (which storage is the central
 * warehouse, which user manages a store) live on the same `locations` row.
 *
 *   - syncSpots()       — Poster spots  -> locations(type='store')
 *   - syncStorages()    — Poster storages -> locations (default central_warehouse,
 *                         classification edited by PM in PATCH /api/locations/:id)
 *   - syncIngredients() — menu.getIngredients -> products(type='raw')
 *   - syncPrepacks()    — menu.getPrepacks    -> products(type='semi') + recipes
 *   - syncMenuProducts() — menu.getProducts + menu.getProduct -> products(type='finished') + recipes
 *
 * BOM import path is FULL (validated 2026-05-23 — see docs/adia-poster-api.md §8).
 *
 * The high-level `runSeedSync()` runs all five sequentially and reports a
 * per-entity result. The HTTP layer exposes optional `?entity=` filtering.
 */
import { query, withTransaction } from '../../db/index.js';
import { writeAudit } from '../../lib/audit.js';
import { recordImportWarning } from '../../services/importWarnings.js';
import { PosterClient } from './client.js';
import {
  STORAGE_TYPE_BY_ID,
  STORE_BACKING_STORAGE,
  DEFAULT_STORAGE_TYPE,
} from './storageClassification.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
  type SyncEntity,
  type SyncTrigger,
} from './syncLog.js';

export type SeedRunResult = {
  readonly entity: SyncEntity;
  readonly status: 'ok' | 'partial' | 'failed';
  readonly recordsIn: number;
  readonly recordsApplied: number;
  readonly errorDetail?: string;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const UNIT_FROM_POSTER: Record<string, 'kg' | 'l' | 'pcs'> = {
  kg: 'kg',
  g: 'kg', // grams normalise to kg
  l: 'l',
  ml: 'l',
  p: 'pcs',
  pcs: 'pcs',
};

function normaliseUnit(raw: string | undefined): 'kg' | 'l' | 'pcs' {
  if (raw === undefined) return 'pcs';
  return UNIT_FROM_POSTER[raw.toLowerCase()] ?? 'pcs';
}

/**
 * Convert a Poster recipe quantity to a quantity in the component's unit:
 *   - structure_unit "g"  + ingredient_unit "kg" -> divide by 1000
 *   - structure_unit "ml" + ingredient_unit "l"  -> divide by 1000
 *   - same unit                                  -> as-is
 *
 * Anything else falls back to "as-is" — the import then writes a `recipes` row
 * the production-manager can correct in `PUT /api/products/:id/recipe`.
 */
function normaliseQty(
  structureUnit: string,
  ingredientUnit: string,
  raw: number | string,
): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const su = structureUnit.toLowerCase();
  const iu = ingredientUnit.toLowerCase();
  if (su === iu) return n;
  if ((su === 'g' && iu === 'kg') || (su === 'ml' && iu === 'l')) return n / 1000;
  if ((su === 'kg' && iu === 'g') || (su === 'l' && iu === 'ml')) return n * 1000;
  return n;
}

// -----------------------------------------------------------------------------
// Per-entity sync
// -----------------------------------------------------------------------------

/**
 * Find or create an ERP `production` location for a Poster workshop.
 * Returns the ERP location id. Also returns the storage_location_id for the
 * closest matching `sex_storage` location, if one is found by name.
 *
 * - First tries exact match on `poster_workshop_id`.
 * - If not found, tries a case-insensitive name match among production locations.
 * - If still not found, creates a new `production` location.
 * - For storage: looks for a `sex_storage` location whose Poster storage is
 *   the workshop's `ingredients_storage_id`, then falls back to name fuzzy match.
 */
async function upsertWorkshopLocation(
  workshopId: number,
  workshopName: string,
  posterStorageId?: number,
): Promise<{ productionLocationId: number; storageLocationId: number | null }> {
  // 1. Try exact match by poster_workshop_id.
  const exact = await query<{ id: number }>(
    `SELECT id FROM locations WHERE poster_workshop_id = $1 LIMIT 1`,
    [workshopId],
  );
  let productionLocationId: number | undefined = exact.rows[0]?.id;

  if (productionLocationId === undefined) {
    // 2. Try name match among production-type locations.
    const byName = await query<{ id: number }>(
      `SELECT id FROM locations WHERE type = 'production' AND name ILIKE $1 LIMIT 1`,
      [workshopName],
    );
    productionLocationId = byName.rows[0]?.id;
    if (productionLocationId !== undefined) {
      // Attach poster_workshop_id to this existing row.
      await query(
        `UPDATE locations SET poster_workshop_id = $1, updated_at = now()
         WHERE id = $2 AND poster_workshop_id IS NULL`,
        [workshopId, productionLocationId],
      );
    }
  }

  if (productionLocationId === undefined) {
    // 3. Create a new production location for this workshop.
    const { rows } = await query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_workshop_id)
       VALUES ($1, 'production', $2)
       ON CONFLICT (poster_workshop_id) WHERE poster_workshop_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [workshopName, workshopId],
    );
    productionLocationId = rows[0]?.id;
    if (productionLocationId === undefined) {
      const { rows: r2 } = await query<{ id: number }>(
        `SELECT id FROM locations WHERE poster_workshop_id = $1 LIMIT 1`,
        [workshopId],
      );
      productionLocationId = r2[0]?.id;
    }
  }

  if (productionLocationId === undefined) {
    throw new Error(`upsertWorkshopLocation: failed to resolve location for workshop_id=${workshopId}`);
  }

  // Find the sex_storage for this workshop.
  let storageLocationId: number | null = null;

  if (posterStorageId !== undefined && posterStorageId > 0) {
    // Exact match by poster_storage_id.
    const storRow = await query<{ id: number }>(
      `SELECT id FROM locations WHERE poster_storage_id = $1 AND type = 'sex_storage' LIMIT 1`,
      [posterStorageId],
    );
    storageLocationId = storRow.rows[0]?.id ?? null;
  }

  if (storageLocationId === null) {
    // Fuzzy name match: look for a sex_storage whose name contains the workshop keywords.
    // Strip " отдел" / " цех" suffix and match the remaining keyword.
    const keyword = workshopName.replace(/\s+(отдел|цех|sexi)$/i, '').trim();
    if (keyword.length >= 3) {
      const fuzzy = await query<{ id: number }>(
        `SELECT id FROM locations WHERE type = 'sex_storage' AND name ILIKE $1 LIMIT 1`,
        [`%${keyword}%`],
      );
      storageLocationId = fuzzy.rows[0]?.id ?? null;
    }
  }

  return { productionLocationId, storageLocationId };
}

/**
 * Insert/update one Poster spot into a `locations(type='store')` row. The PM
 * may later edit `name`, `parent_id`, `manager_user_id` via PATCH.
 *
 * The ON CONFLICT clause updates ONLY the name — never `poster_storage_id`.
 * A store-backing storage merged onto this row (ADR-0017 §4, `upsertStorage`)
 * must survive a re-run of the spot sync.
 */
async function upsertSpot(spotId: number, name: string): Promise<void> {
  await query(
    `INSERT INTO locations (name, type, poster_spot_id)
     VALUES ($1, 'store', $2)
     ON CONFLICT (poster_spot_id) WHERE poster_spot_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
    [name, spotId],
  );
}

/**
 * Insert/update one Poster storage (ADR-0017).
 *
 *   - Store-backing storages (3/4/5) are NOT inserted as standalone
 *     locations. Their `poster_storage_id` is merged onto the matching POS
 *     spot row (P2, ADR §4) so sales + stock land on one store location.
 *   - Every other storage is inserted at its ADR §3 classified type, with
 *     `sex_storage` as the safe default for any unknown id.
 *
 * Insert-time classification only: ON CONFLICT DO UPDATE rotates ONLY the
 * `name`, NEVER the `type` — a PM's manual reclassification (PATCH
 * /api/locations/:id) must not be reverted by a later sync.
 */
async function upsertStorage(storageId: number, name: string): Promise<void> {
  const backingSpotId = STORE_BACKING_STORAGE[storageId];
  if (backingSpotId !== undefined) {
    await mergeStorageIntoSpot(storageId, backingSpotId);
    return;
  }
  const type = STORAGE_TYPE_BY_ID[storageId] ?? DEFAULT_STORAGE_TYPE;
  await query(
    `INSERT INTO locations (name, type, poster_storage_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (poster_storage_id) WHERE poster_storage_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
    [name, type, storageId],
  );
}

/**
 * P2 merge (ADR-0017 §4): attach a store-backing `storage_id` to its POS
 * spot location so that sales (`poster_spot_id`) and stock
 * (`poster_storage_id`) resolve to the SAME store row.
 *
 * The UPDATE is gated so it:
 *   - only runs when the spot row exists and does not already carry the id
 *     (idempotent re-run = no-op);
 *   - never steals a storage id already owned by another spot row
 *     (preserves uq_locations_poster_storage).
 *
 * If the spot row does not exist yet (storage synced before its spot) the
 * merge is a no-op — the next sync, with the spot present, completes it.
 */
async function mergeStorageIntoSpot(storageId: number, spotId: number): Promise<void> {
  await query(
    `UPDATE locations AS spot
        SET poster_storage_id = $1, updated_at = now()
      WHERE spot.poster_spot_id = $2
        AND spot.type = 'store'
        AND spot.poster_storage_id IS DISTINCT FROM $1
        AND NOT EXISTS (
          SELECT 1 FROM locations other
           WHERE other.poster_storage_id = $1
             AND other.id <> spot.id
        )`,
    [storageId, spotId],
  );
}

/**
 * Insert/update one Poster ingredient as a `products(type='raw')` row. Pure
 * raw materials carry only `poster_ingredient_id` (per ADR-0002 §1).
 */
async function upsertIngredient(
  posterIngredientId: number,
  name: string,
  unit: string,
): Promise<void> {
  await query(
    `INSERT INTO products (name, type, unit, poster_ingredient_id)
     VALUES ($1, 'raw', $2, $3)
     ON CONFLICT (poster_ingredient_id) WHERE poster_ingredient_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit`,
    [name, normaliseUnit(unit), posterIngredientId],
  );
}

/**
 * Insert/update one Poster prepack (semi-finished — `type='semi'`). Prepacks
 * are stocked AND used as recipe components — both columns are filled
 * (`poster_product_id` for menu/sales sync, `poster_ingredient_id` for stock).
 *
 * `posterIngredientId` may be null when Poster returns `ingredient_id=0` — in
 * that case the row is keyed only by `poster_product_id`.
 */
async function upsertPrepack(
  posterProductId: number,
  posterIngredientId: number | null,
  name: string,
  batchYieldKg: number,
  productionLocationId?: number | null,
  storageLocationId?: number | null,
): Promise<number> {
  // C5 — `products` has TWO partial UNIQUE indexes on the Poster keys:
  // `uq_products_poster_product` on (poster_product_id) AND
  // `uq_products_poster_ingredient` on (poster_ingredient_id).
  // A plain `ON CONFLICT (poster_product_id)` does not catch a collision
  // on the ingredient_id key — which is the realistic case where the
  // prepack's component already exists as `type='raw'` with the same
  // `poster_ingredient_id` (e.g. type=1 ingredient list also contained
  // the prepack). Two-phase SELECT-then-INSERT/UPDATE handles both keys
  // without raising 23505 and without overwriting the wrong row.
  const existing = await query<{ id: number; type: string }>(
    posterIngredientId !== null
      ? `SELECT id, type FROM products
          WHERE poster_product_id = $1
             OR (poster_ingredient_id IS NOT NULL AND poster_ingredient_id = $2)
          ORDER BY (poster_product_id = $1) DESC, id ASC
          LIMIT 1`
      : `SELECT id, type FROM products WHERE poster_product_id = $1 LIMIT 1`,
    posterIngredientId !== null ? [posterProductId, posterIngredientId] : [posterProductId],
  );
  const found = existing.rows[0];
  if (found !== undefined) {
    await query(
      `UPDATE products
          SET name = $1,
              poster_product_id = COALESCE(poster_product_id, $2),
              poster_ingredient_id = COALESCE(poster_ingredient_id, $3),
              type = CASE WHEN type = 'raw' THEN 'semi' ELSE type END,
              batch_yield = $5,
              production_location_id = COALESCE(production_location_id, $6::bigint),
              storage_location_id = COALESCE(storage_location_id, $7::bigint)
        WHERE id = $4`,
      [name, posterProductId, posterIngredientId, found.id, batchYieldKg, productionLocationId ?? null, storageLocationId ?? null],
    );
    return found.id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, batch_yield, production_location_id, storage_location_id)
     VALUES ($1, 'semi', 'kg', $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, posterProductId, posterIngredientId, batchYieldKg, productionLocationId ?? null, storageLocationId ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`upsertPrepack: could not resolve id for poster_product_id=${posterProductId}`);
  }
  return id;
}

/**
 * Insert/update one Poster menu product (finished — `type='finished'`). Both
 * `poster_product_id` (sales) and `poster_ingredient_id` (stock) are filled
 * when the row is stocked (Poster type=2). Type=3 menu items are
 * not-directly-stocked — `poster_ingredient_id` may be NULL.
 */
async function upsertMenuProduct(
  posterProductId: number,
  posterIngredientId: number | null,
  name: string,
  productionLocationId?: number | null,
  storageLocationId?: number | null,
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id, production_location_id, storage_location_id)
     VALUES ($1, 'finished', 'pcs', $2, $3, $4, $5)
     ON CONFLICT (poster_product_id) WHERE poster_product_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name,
                   poster_ingredient_id = COALESCE(products.poster_ingredient_id, EXCLUDED.poster_ingredient_id),
                   production_location_id = COALESCE(products.production_location_id, $4::bigint),
                   storage_location_id = COALESCE(products.storage_location_id, $5::bigint)
     RETURNING id`,
    [name, posterProductId, posterIngredientId, productionLocationId ?? null, storageLocationId ?? null],
  );
  const id = rows[0]?.id;
  if (id !== undefined) return id;
  const { rows: r2 } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_product_id = $1`,
    [posterProductId],
  );
  if (r2[0] === undefined) {
    throw new Error(`upsertMenuProduct: cannot resolve id for poster_product_id=${posterProductId}`);
  }
  return r2[0].id;
}

/**
 * Replace the BOM for `parentProductId` with `components`. The replace
 * happens in one transaction — partial BOMs are never visible.
 *
 * I9 (Sprint 3 audit): the inner per-row `try/catch` previously swallowed
 * the error message but LEFT the transaction in an aborted state. Once one
 * INSERT raised (e.g. 23505 / CHECK violation), every subsequent INSERT
 * inside the same tx failed with "current transaction is aborted, commands
 * ignored until end of transaction block" — so a single bad row sank the
 * whole recipe AND the per-prepack caller. The fix is a SAVEPOINT per row:
 * each row is its own sub-transaction; a failure rolls back ONLY that row
 * and the parent transaction continues. This is the only Postgres-correct
 * way to swallow a mid-tx error.
 */
async function replaceRecipe(
  parentProductId: number,
  components: readonly { componentProductId: number; qtyPerUnit: number; brutto?: number }[],
): Promise<number> {
  if (components.length === 0) return 0;
  // Skip products whose recipe has been manually locked by a PM/manager.
  const { rows: lockRows } = await query<{ recipe_locked: boolean }>(
    'SELECT recipe_locked FROM products WHERE id = $1',
    [parentProductId],
  );
  if (lockRows[0]?.recipe_locked === true) {
    console.log(`[poster] recipe sync skipped for product=${parentProductId} (recipe_locked)`);
    return 0;
  }
  return withTransaction(async (tx) => {
    await tx.query('DELETE FROM recipes WHERE product_id = $1', [parentProductId]);
    let applied = 0;
    for (const c of components) {
      if (c.componentProductId === parentProductId) continue; // chk_recipe_no_self
      if (c.qtyPerUnit <= 0) continue;
      // SAVEPOINT name — sanitised, only alphanumerics + underscore. The
      // identifier is server-side state, not user input, but we still avoid
      // string templating into SQL anywhere unsafe.
      const sp = `sp_recipe_${parentProductId}_${c.componentProductId}`;
      try {
        await tx.query(`SAVEPOINT ${sp}`);
        const brutto = (c.brutto !== undefined && c.brutto > 0) ? c.brutto : (c.qtyPerUnit);
        await tx.query(
          `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (product_id, component_product_id, stage) DO UPDATE
             SET qty_per_unit = EXCLUDED.qty_per_unit,
                 brutto = EXCLUDED.brutto`,
          [parentProductId, c.componentProductId, c.qtyPerUnit, brutto],
        );
        await tx.query(`RELEASE SAVEPOINT ${sp}`);
        applied += 1;
      } catch (err) {
        // Roll back ONLY this row — the outer tx is still healthy.
        try {
          await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await tx.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // savepoint already released — ignore
        }
        const e = err as { message?: string; code?: string };
        console.error(
          `[poster] recipe row skipped product=${parentProductId} component=${c.componentProductId} code=${e.code ?? '-'} msg=${redactUrl(e.message ?? '')}`,
        );
      }
    }
    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.recipe.import',
      entity: 'recipes',
      entityId: parentProductId,
      payload: { components: applied },
    });
    return applied;
  });
}

// -----------------------------------------------------------------------------
// Public sync entry points — one per entity + a top-level `runSeedSync`.
// -----------------------------------------------------------------------------

/**
 * Sync Poster workshops (цех) to ERP `production`-type locations.
 * Returns a Map of poster_workshop_id → { productionLocationId, storageLocationId }
 * so callers can set production_location_id on products without re-querying.
 */
export async function syncWorkshops(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<{ result: SeedRunResult; workshopMap: Map<number, { productionLocationId: number; storageLocationId: number | null }> }> {
  const workshopMap = new Map<number, { productionLocationId: number; storageLocationId: number | null }>();
  const runId = await startSyncRun('spots', trigger); // reuse 'spots' entity bucket
  try {
    const rows = await client.getWorkshops();
    let applied = 0;
    for (const r of rows) {
      const wid = Number(r.workshop_id);
      if (!Number.isInteger(wid) || wid <= 0) continue;
      const wname = String(r.workshop_name ?? '').trim() || `Workshop ${wid}`;
      if (wname.toLowerCase().includes('без цеха') || wname.toLowerCase().includes('bez cexa')) continue; // skip "no workshop"
      const storageId = r.ingredients_storage_id !== undefined ? Number(r.ingredients_storage_id) : undefined;
      const locs = await upsertWorkshopLocation(wid, wname, storageId !== undefined && Number.isFinite(storageId) && storageId > 0 ? storageId : undefined);
      workshopMap.set(wid, locs);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return {
      result: { entity: 'spots', status: 'ok', recordsIn: rows.length, recordsApplied: applied },
      workshopMap,
    };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    console.error('[poster:workshops] sync failed:', detail);
    return {
      result: { entity: 'spots', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail },
      workshopMap,
    };
  }
}

export async function syncSpots(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('spots', trigger);
  try {
    const rows = await client.getSpots();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.spot_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = (r.spot_name ?? r.name ?? '').trim() || `Spot ${id}`;
      await upsertSpot(id, name);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'spots', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('spots', detail);
    return { entity: 'spots', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

export async function syncStorages(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('storages', trigger);
  try {
    const rows = await client.getStorages();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.storage_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = (r.storage_name ?? '').trim() || `Storage ${id}`;
      await upsertStorage(id, name);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'storages', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('storages', detail);
    return { entity: 'storages', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

export async function syncIngredients(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('ingredients', trigger);
  try {
    const rows = await client.getIngredients();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.ingredient_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      // C5 — Poster `menu.getIngredients` returns BOTH raw ingredients
      // (`ingredients_type=1`) and semi-finished prepacks
      // (`ingredients_type=2`). Importing type=2 here as raw would later
      // collide with `syncPrepacks` on `(poster_ingredient_id)` (the
      // partial UNIQUE on `products.poster_ingredient_id`) AND mislabel
      // the row as raw. Skip non-type-1 rows — prepacks land via
      // `syncPrepacks` instead. Missing/undefined `ingredients_type`
      // defaults to 1 (the historical behaviour for older Poster fixtures).
      const ingType = r.ingredients_type === undefined ? 1 : Number(r.ingredients_type);
      if (Number.isFinite(ingType) && ingType !== 1) continue;
      const name = String(r.ingredient_name ?? '').trim() || `Ingredient ${id}`;
      const unit = String(r.ingredient_unit ?? 'p');
      await upsertIngredient(id, name, unit);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'ingredients', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('ingredients', detail);
    return { entity: 'ingredients', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

/**
 * Sync menu products + their per-product BOMs.
 *
 * Two-phase:
 *   1. upsert every product (type=2 and type=3) so their ids exist;
 *   2. for type=2 products with `ingredient_id`, fetch `menu.getProduct` and
 *      write `recipes` — this is the BOM import path validated 2026-05-23.
 *
 * Type=3 products (e.g. plate/portion variants) carry no top-level BOM and
 * are left without recipes — PM can add them via `PUT /api/products/:id/recipe`.
 */
export async function syncMenuProducts(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
  workshopMap?: Map<number, { productionLocationId: number; storageLocationId: number | null }>,
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let applied = 0;
  let total = 0;
  // Load workshop map if not provided.
  let wmap = workshopMap;
  if (wmap === undefined) {
    try {
      const { workshopMap: loaded } = await syncWorkshops(client, trigger);
      wmap = loaded;
    } catch {
      wmap = new Map();
    }
  }
  try {
    const list = await client.getProducts();
    total = list.length;
    // Phase 1: upsert each product row + save Poster BOM cost.
    const idMap = new Map<number, number>(); // poster_product_id -> ADIA id
    for (const p of list) {
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      const pingId = p.ingredient_id !== undefined ? Number(p.ingredient_id) : null;
      const workshopId = Number(p.workshop);
      const workshopLocs = Number.isInteger(workshopId) && workshopId > 0 ? wmap.get(workshopId) : undefined;
      const adiaId = await upsertMenuProduct(
        ppid,
        pingId !== null && Number.isInteger(pingId) && pingId > 0 ? pingId : null,
        String(p.product_name ?? '').trim() || `Product ${ppid}`,
        workshopLocs?.productionLocationId ?? null,
        workshopLocs?.storageLocationId ?? null,
      );
      idMap.set(ppid, adiaId);
      applied += 1;
      // Save Poster-calculated BOM cost (cost field from menu.getProducts list).
      const posterCost = Number(p.cost ?? '');
      if (Number.isFinite(posterCost) && posterCost > 0) {
        await query(
          `UPDATE products SET cost_price = $1, updated_at = now()
           WHERE id = $2 AND cost_price IS DISTINCT FROM $1`,
          [posterCost, adiaId],
        );
      }
    }
    // Phase 2: BOM import + sell_price for type=2 products.
    for (const p of list) {
      if (p.type !== '2') continue;
      const ppid = Number(p.product_id);
      const parentId = idMap.get(ppid);
      if (parentId === undefined) continue;
      const full = await client.getProduct(ppid);
      if (full === null) continue;
      // Save selling price — Poster returns per-spot prices; take the first spot's price.
      if (full.price !== null && full.price !== undefined && typeof full.price === 'object') {
        const firstPrice = Number(Object.values(full.price)[0] ?? '');
        if (Number.isFinite(firstPrice) && firstPrice > 0) {
          await query(
            `UPDATE products SET sell_price = $1, updated_at = now()
             WHERE id = $2 AND sell_price IS DISTINCT FROM $1`,
            [firstPrice, parentId],
          );
        }
      }
      if (!Array.isArray(full.ingredients) || full.ingredients.length === 0) continue;
      const components = await resolveBomComponents(full.ingredients);
      await replaceRecipe(parentId, components);
    }
    await finishSyncRun(runId, 'ok', { recordsIn: total, recordsApplied: applied });
    return { entity: 'products', status: 'ok', recordsIn: total, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'partial', { recordsIn: total, recordsApplied: applied }, detail);
    await notifyPosterSyncFailed('products', detail);
    return {
      entity: 'products',
      status: 'partial',
      recordsIn: total,
      recordsApplied: applied,
      errorDetail: detail,
    };
  }
}

/**
 * Sync prepacks (semi-finished products) + their BOMs.
 *
 * I9 (Sprint 3 audit P1): each prepack is handled in its OWN try/catch so
 * one failure (23505 unique-key violation, CHECK constraint, an ingredient
 * that has not been seeded yet, etc.) does not poison the rest of the run.
 * Real Poster fixtures had 1121 prepacks where only ~109 landed before this
 * fix — every failure after the first cascaded as
 * "current transaction is aborted, commands ignored". Root-cause errors are
 * collected in `failedItems` and surfaced in the final log + return payload
 * so the next debugging session has the SQLSTATE code in hand.
 */
export async function syncPrepacks(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
  workshopMap?: Map<number, { productionLocationId: number; storageLocationId: number | null }>,
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let applied = 0;
  let total = 0;
  const failedItems: { posterProductId: number; code: string | undefined; message: string }[] = [];
  // Load workshop map if not provided (standalone call without prior syncWorkshops).
  let wmap = workshopMap;
  if (wmap === undefined) {
    try {
      const { workshopMap: loaded } = await syncWorkshops(client, trigger);
      wmap = loaded;
    } catch {
      wmap = new Map();
    }
  }
  try {
    const list = await client.getPrepacks();
    total = list.length;
    for (const p of list) {
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      // Poster returns ingredient_id=0 for prepacks that are not directly stocked
      // as raw ingredients — treat these as product_id-keyed-only semi-finished rows.
      const pingRaw = Number(p.ingredient_id);
      const ping: number | null = Number.isInteger(pingRaw) && pingRaw > 0 ? pingRaw : null;
      try {
        const out = Number(p.out);
        // Poster stores `p.out` (batch yield) in grams for all weight-based
        // prepacks. All ADIA prepacks are normalised to 'kg', so divide by 1000.
        // Fall back to 1 kg when out is zero/missing (e.g. piece-based items
        // where Poster returns out=0).
        const batchYieldKg = Number.isFinite(out) && out > 0 ? out / 1000 : 1;
        // Resolve workshop → production_location_id.
        const workshopId = Number(p.workshop_id);
        const workshopLocs = Number.isInteger(workshopId) && workshopId > 0 ? wmap.get(workshopId) : undefined;
        const parentId = await upsertPrepack(
          ppid,
          ping,
          String(p.product_name ?? '').trim() || `Prepack ${ppid}`,
          batchYieldKg,
          workshopLocs?.productionLocationId ?? null,
          workshopLocs?.storageLocationId ?? null,
        );
        // qty_per_unit = ingredient_qty_in_ADIA_unit / batch_yield_in_kg
        // batchYieldKg is always in kg (prepack ADIA unit). Each ingredient's
        // qty is converted from its recipe unit (structure_unit, e.g. "g") to
        // its ADIA stored unit (ingredient_unit, e.g. "kg") via normaliseQty.
        const components: { componentProductId: number; qtyPerUnit: number; brutto: number }[] = [];
        for (const ing of p.ingredients ?? []) {
          const compPing = Number(ing.ingredient_id);
          if (!Number.isInteger(compPing) || compPing <= 0) continue;
          // structure_type=2 means the component is another prepack; in Poster's
          // API, ingredient_id for prepack components stores the prepack's
          // product_id (not its ingredient_id). Try poster_product_id first for
          // these, then fall back to poster_ingredient_id.
          const isPrepackComponent = String(ing.structure_type) === '2';
          const firstQ = isPrepackComponent
            ? `SELECT id FROM products WHERE poster_product_id = $1`
            : `SELECT id FROM products WHERE poster_ingredient_id = $1`;
          const secondQ = isPrepackComponent
            ? `SELECT id FROM products WHERE poster_ingredient_id = $1`
            : `SELECT id FROM products WHERE poster_product_id = $1`;
          const compRow = await query<{ id: number }>(firstQ, [compPing]);
          let compId = compRow.rows[0]?.id;
          if (compId === undefined) {
            const compRow2 = await query<{ id: number }>(secondQ, [compPing]);
            compId = compRow2.rows[0]?.id;
          }
          if (compId === undefined) continue; // ingredient not yet seeded — skip
          const strUnit = String(ing.structure_unit ?? '');
          const ingUnit = String(ing.ingredient_unit ?? '');
          const bruttoConverted = normaliseQty(strUnit, ingUnit, ing.structure_brutto);
          const nettoConverted = normaliseQty(strUnit, ingUnit, ing.structure_netto ?? ing.structure_brutto);
          // For piece-counted ingredients (unit "p"), Poster stores structure_netto
          // in grams (not pieces), so netto is in a different unit than brutto.
          // Always use brutto for these to avoid treating gram-netto as piece count.
          const isPcs = ingUnit.toLowerCase() === 'p' || ingUnit.toLowerCase() === 'pcs';
          const qtyConverted = (!isPcs && nettoConverted > 0) ? nettoConverted : bruttoConverted;
          // Use the prepack's batch yield (already in kg) as the divisor so
          // qty_per_unit = "ingredient_ADIA_unit per 1 kg of finished prepack".
          const safeYield = batchYieldKg > 0 ? batchYieldKg : 1;
          const perUnit = qtyConverted / safeYield;
          const bruttoPerUnit = bruttoConverted / safeYield;
          if (perUnit > 0 && Number.isFinite(perUnit)) {
            components.push({ componentProductId: compId, qtyPerUnit: perUnit, brutto: bruttoPerUnit > 0 ? bruttoPerUnit : perUnit });
          }
        }
        await replaceRecipe(parentId, components);
        applied += 1;
      } catch (err) {
        // Per-prepack isolation: log the real Postgres code + message, push
        // to failedItems, and continue with the next prepack. Without this
        // catch one bad row aborted the loop AND surfaced as a useless
        // "current transaction is aborted" against the NEXT prepack.
        const e = err as { message?: string; code?: string };
        const msg = redactUrl(e.message ?? 'unknown');
        failedItems.push({ posterProductId: ppid, code: e.code, message: msg });
        console.error(
          `[poster:prepack] id=${ppid} code=${e.code ?? '-'} msg=${msg}`,
        );
        // F2.3 — persist the per-item failure to `import_warnings` so PM
        // sees it on the dashboard without scanning the server log. The
        // helper is best-effort: a failure here must not abort the loop.
        try {
          await recordImportWarning({
            source: 'poster.prepack',
            entity: `product:${ppid}`,
            severity: 'warning',
            message: msg,
            payload: { poster_product_id: ppid, code: e.code ?? null },
          });
        } catch (warnErr) {
          console.error(
            '[poster:prepack] failed to record import_warning:',
            (warnErr as Error).message,
          );
        }
      }
    }
    // If any prepack failed, the run is `partial`, not `ok` — operators
    // need to see this in `poster_sync_log` to drive the next fix.
    const status: 'ok' | 'partial' = failedItems.length === 0 ? 'ok' : 'partial';
    const summary =
      failedItems.length === 0
        ? undefined
        : `${failedItems.length} prepack(s) failed (first: id=${failedItems[0]!.posterProductId} ` +
          `code=${failedItems[0]!.code ?? '-'} ${failedItems[0]!.message.slice(0, 200)})`;
    await finishSyncRun(runId, status, { recordsIn: total, recordsApplied: applied }, summary);
    return {
      entity: 'products',
      status,
      recordsIn: total,
      recordsApplied: applied,
      ...(summary !== undefined ? { errorDetail: summary } : {}),
    };
  } catch (err) {
    // Catastrophic outer failure — e.g. `client.getPrepacks()` itself threw.
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'partial', { recordsIn: total, recordsApplied: applied }, detail);
    await notifyPosterSyncFailed('products', detail);
    return {
      entity: 'products',
      status: 'partial',
      recordsIn: total,
      recordsApplied: applied,
      errorDetail: detail,
    };
  }
}

/**
 * Resolve a Poster `ingredients` array to ADIA component product ids +
 * normalised qty. Components that are not yet seeded are silently skipped —
 * the next seed run picks them up.
 */
async function resolveBomComponents(
  rows: readonly {
    ingredient_id: string;
    structure_unit: string;
    ingredient_unit: string;
    structure_brutto: number | string;
    structure_netto?: number | string;
  }[],
): Promise<{ componentProductId: number; qtyPerUnit: number; brutto: number }[]> {
  const out: { componentProductId: number; qtyPerUnit: number; brutto: number }[] = [];
  for (const ing of rows) {
    const ping = Number(ing.ingredient_id);
    if (!Number.isInteger(ping) || ping <= 0) continue;
    const r = await query<{ id: number }>(
      `SELECT id FROM products WHERE poster_ingredient_id = $1`,
      [ping],
    );
    let id = r.rows[0]?.id;
    if (id === undefined) {
      // Fallback: some prepacks have ingredient_id=0 in Poster, so BOMs reference
      // them by product_id. Try poster_product_id when ingredient lookup misses.
      const r2 = await query<{ id: number }>(
        `SELECT id FROM products WHERE poster_product_id = $1`,
        [ping],
      );
      id = r2.rows[0]?.id;
    }
    if (id === undefined) continue;
    const ingUnit = String(ing.ingredient_unit ?? '');
    const brutto = normaliseQty(
      String(ing.structure_unit ?? ''),
      ingUnit,
      ing.structure_brutto,
    );
    const netto = ing.structure_netto !== undefined
      ? normaliseQty(String(ing.structure_unit ?? ''), ingUnit, ing.structure_netto)
      : brutto;
    const isPcs = ingUnit.toLowerCase() === 'p' || ingUnit.toLowerCase() === 'pcs';
    const qty = (!isPcs && netto > 0) ? netto : brutto;
    if (qty > 0) out.push({ componentProductId: id, qtyPerUnit: qty, brutto });
  }
  return out;
}

/**
 * Dedicated pass: reads workshop assignment from Poster (prepack.workshop_id and
 * product.workshop) and forcefully writes production_location_id +
 * storage_location_id to ERP products. Runs independently of the full sync so
 * it can be triggered without importing BOM or recipes.
 *
 * Unlike the per-row COALESCE inside upsertPrepack/upsertMenuProduct (which
 * preserves NULLs when Poster returns workshop_id=0), this function writes the
 * resolved location id directly — overwriting a previously mismatched value with
 * the authoritative Poster workshop assignment.  Products where Poster returns
 * workshop_id=0 / undefined are left unchanged.
 */
export async function syncProductWorkshops(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('spots', trigger);
  try {
    // Always refresh the workshop map so location ids are current.
    const { workshopMap } = await syncWorkshops(client, trigger);

    let total = 0;
    let updated = 0;

    // ── Prepacks ─────────────────────────────────────────────────────────────
    const prepacks = await client.getPrepacks();
    for (const p of prepacks) {
      const wid = Number(p.workshop_id);
      if (!Number.isInteger(wid) || wid <= 0) continue;
      const locs = workshopMap.get(wid);
      if (locs === undefined) continue;
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;

      total += 1;
      const { rowCount } = await query(
        `UPDATE products
            SET production_location_id = COALESCE(production_location_id, $1),
                storage_location_id    = COALESCE(storage_location_id, $2::bigint),
                updated_at             = now()
          WHERE poster_product_id = $3
            AND production_location_id IS NULL`,
        [locs.productionLocationId, locs.storageLocationId ?? null, ppid],
      );
      if (rowCount > 0) updated += 1;
    }

    // ── Menu products ─────────────────────────────────────────────────────────
    const products = await client.getProducts();
    for (const p of products) {
      const wid = Number(p.workshop);
      if (!Number.isInteger(wid) || wid <= 0) continue;
      const locs = workshopMap.get(wid);
      if (locs === undefined) continue;
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;

      total += 1;
      const { rowCount } = await query(
        `UPDATE products
            SET production_location_id = COALESCE(production_location_id, $1),
                storage_location_id    = COALESCE(storage_location_id, $2::bigint),
                updated_at             = now()
          WHERE poster_product_id = $3
            AND production_location_id IS NULL`,
        [locs.productionLocationId, locs.storageLocationId ?? null, ppid],
      );
      if (rowCount > 0) updated += 1;
    }

    await finishSyncRun(runId, 'ok', { recordsIn: total, recordsApplied: updated });
    return { entity: 'products', status: 'ok', recordsIn: total, recordsApplied: updated };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    return { entity: 'products', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

// -----------------------------------------------------------------------------
// Top-level orchestrator
// -----------------------------------------------------------------------------

export type SeedSelector = 'all' | 'locations' | 'products';

/**
 * Run the seed sync. Ordering matters — products that reference ingredients
 * via BOM cannot be linked before the ingredient rows exist.
 *
 *   locations: spots + storages
 *   products: ingredients -> prepacks -> menu products
 */
export async function runSeedSync(
  client: PosterClient,
  selector: SeedSelector = 'all',
): Promise<SeedRunResult[]> {
  const results: SeedRunResult[] = [];
  // Sync workshops first so product syncs can reference the resulting map.
  let workshopMap: Map<number, { productionLocationId: number; storageLocationId: number | null }> | undefined;
  if (selector === 'all' || selector === 'locations') {
    results.push(await syncSpots(client, 'manual'));
    results.push(await syncStorages(client, 'manual'));
    const wResult = await syncWorkshops(client, 'manual');
    results.push(wResult.result);
    workshopMap = wResult.workshopMap;
  }
  if (selector === 'products') {
    // When syncing only products (no locations pass), still need workshops.
    const wResult = await syncWorkshops(client, 'manual');
    workshopMap = wResult.workshopMap;
  }
  if (selector === 'all' || selector === 'products') {
    results.push(await syncIngredients(client, 'manual'));
    results.push(await syncPrepacks(client, 'manual', workshopMap));
    results.push(await syncMenuProducts(client, 'manual', workshopMap));
  }
  return results;
}
