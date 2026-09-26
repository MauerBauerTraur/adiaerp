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
import { recordImportWarning, recordImportWarningOnce } from '../../services/importWarnings.js';
import { PosterClient } from './client.js';
import {
  ProductNameIndex,
  buildComponents,
  fallbackOrderFor,
  prepackYieldKg,
  roundingWarning,
  sameRecipeRows,
  writePosterRecipe,
  type BuiltComponent,
  type RecipeComponentInput,
} from './posterRecipe.js';
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
 * Replace the BOM for `parentProductId` with `components` (hourly/manual sync
 * path). The replace happens in one transaction — partial BOMs are never
 * visible — and skips products whose recipe is locked (`recipe_locked`).
 *
 * The lock is read `FOR NO KEY UPDATE` inside the same transaction, so a manual
 * recipe save that locks the product cannot slip in between the check and the
 * DELETE and be overwritten by Poster.
 *
 * The write itself (per-row SAVEPOINTs — I9; stages kept only for an
 * unchanged composition) lives in `writePosterRecipe`, shared with the explicit
 * re-sync endpoint. A row the database rejects is skipped (logged) here — the
 * hourly sync is best-effort; the explicit endpoint rejects the whole write.
 *
 * Review R6: the hourly sync NEVER silently flattens a real Hamir/Krem/Bezak
 * split. When the new Poster composition would reset one, the recipe is left
 * exactly as it is and a warning asks the owner to confirm the change on the
 * "Poster bilan solishtirish" page (bulk apply with include_stage_resets).
 */
async function replaceRecipe(
  parentProductId: number,
  components: readonly RecipeComponentInput[],
): Promise<RecipeSyncOutcome> {
  if (components.length === 0) return NOT_WRITTEN;
  return withTransaction(async (tx) => {
    const { rows: lockRows } = await tx.query<{ recipe_locked: boolean }>(
      'SELECT recipe_locked FROM products WHERE id = $1 FOR NO KEY UPDATE',
      [parentProductId],
    );
    if (lockRows[0] === undefined) return NOT_WRITTEN;
    if (lockRows[0].recipe_locked) {
      // Skip products whose recipe has been manually locked by a PM/manager.
      console.log(`[poster] recipe sync skipped for product=${parentProductId} (recipe_locked)`);
      return NOT_WRITTEN;
    }
    const result = await writePosterRecipe(tx, parentProductId, components, { refuseStageReset: true });
    if (result.refused) {
      console.log(`[poster] recipe sync skipped for product=${parentProductId} (would flatten a stage split)`);
      return { ...NOT_WRITTEN, stageSplitBlocked: true };
    }
    // The previous rows go into the audit whenever the recipe actually changed,
    // so any hourly rewrite can be reconstructed; an identical hourly rewrite
    // keeps the row small.
    const changed = !sameRecipeRows(result.previous, result.written);
    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.recipe.import',
      entity: 'recipes',
      entityId: parentProductId,
      payload: {
        components: result.applied,
        ...(changed ? { previous_components: result.previous } : {}),
      },
    });
    return { applied: result.applied, stageSplitBlocked: false, roundingChanges: result.roundingChanges };
  });
}

type RecipeSyncOutcome = {
  readonly applied: number;
  /** Skipped: the new composition would have flattened a real stage split. */
  readonly stageSplitBlocked: boolean;
  readonly roundingChanges: readonly { componentProductId: number; from: number; to: number }[];
};

const NOT_WRITTEN: RecipeSyncOutcome = { applied: 0, stageSplitBlocked: false, roundingChanges: [] };

/** Import warning when the hourly sync refuses to flatten a stage split (R6). */
const STAGE_SPLIT_BLOCKED_WARNING =
  "Poster tarkibi o'zgardi, lekin retseptda Hamir/Krem/Bezak bo'linishi bor — 'Poster bilan solishtirish' sahifasida tasdiqlang";

/**
 * Per-run bookkeeping of what the recipe sync must tell the PM, written to
 * `import_warnings` (source 'poster.recipe'). Best-effort: a failure here
 * never aborts the sync.
 *
 *   - binding notes (bound by id despite a different name / bound by name
 *     only) — ONE row per COMPONENT, not per recipe x component, so a
 *     systematic naming difference yields one row per product, not hundreds;
 *   - a recipe NOT synced because it would have flattened a Hamir/Krem/Bezak
 *     split (R6) — one row per parent product;
 *   - a value the 4-decimal storage changes by more than 10% — one row per
 *     parent product and component;
 *   - merged duplicate Poster lines — a server log line only.
 *
 * `recordImportWarningOnce` skips a row whose unresolved twin already exists
 * (across runs); the in-memory set saves the round-trips within one run.
 */
class RecipeSyncWarnings {
  private readonly seen = new Set<string>();

  async afterWrite(
    parentProductId: number,
    built: { readonly components: readonly BuiltComponent[]; readonly duplicates: readonly { componentProductId: number; lines: number }[] },
    outcome: RecipeSyncOutcome,
  ): Promise<void> {
    if (outcome.stageSplitBlocked) {
      await this.record(`product:${parentProductId}`, STAGE_SPLIT_BLOCKED_WARNING, {
        parent_product_id: parentProductId,
      });
      return;
    }
    if (outcome.applied === 0) return;
    for (const d of built.duplicates) {
      console.log(
        `[poster:recipe] product=${parentProductId} component=${d.componentProductId} merged ${d.lines} Poster lines (quantities summed)`,
      );
    }
    for (const c of built.components) {
      for (const note of c.notes) {
        await this.record(`product:${c.componentProductId}`, note, {
          component_product_id: c.componentProductId,
          poster_ingredient_id: c.posterIngredientId,
          poster_name: c.posterName,
          erp_name: c.name,
          matched_by: c.matchedBy,
          first_seen_in_product_id: parentProductId,
        });
      }
    }
    for (const r of outcome.roundingChanges) {
      const name = built.components.find((c) => c.componentProductId === r.componentProductId)?.name ?? `#${r.componentProductId}`;
      await this.record(`product:${parentProductId}`, roundingWarning(name, r.from, r.to), {
        parent_product_id: parentProductId,
        component_product_id: r.componentProductId,
        from: r.from,
        to: r.to,
      });
    }
  }

  private async record(entity: string, message: string, payload: Record<string, unknown>): Promise<void> {
    const key = `${entity}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      await recordImportWarningOnce({ source: 'poster.recipe', entity, severity: 'warning', message, payload });
    } catch (err) {
      console.error('[poster:recipe] failed to record import_warning:', (err as Error).message);
    }
  }
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
      // Raw-material cost from Poster's ingredient `prime_cost` — the SAME basis
      // Poster uses for себестоимость, so ADIA BOM costs line up with Poster's.
      // `prime_cost` is scaled ×10000 (1/10000 so'm), so divide by 10000.
      // (Stock sync no longer overwrites cost_price — see stockSync.ts — so this
      //  value persists between the 15-min leftover syncs.)
      const primeCost = Math.round(Number(r.prime_cost ?? 0) / 10000);
      if (Number.isFinite(primeCost) && primeCost > 0) {
        await query(
          `UPDATE products SET cost_price = $1, updated_at = now()
           WHERE poster_ingredient_id = $2 AND type = 'raw' AND cost_price IS DISTINCT FROM $1`,
          [primeCost, id],
        );
      }
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
      // Poster returns cost in tiyin (kopecks × 100); divide by 100 to store in so'm.
      const posterCost = Math.round(Number(p.cost ?? '') / 100);
      if (Number.isFinite(posterCost) && posterCost > 0) {
        await query(
          `UPDATE products SET cost_price = $1, updated_at = now()
           WHERE id = $2 AND cost_price IS DISTINCT FROM $1`,
          [posterCost, adiaId],
        );
      }
    }
    // Phase 2: BOM import + sell_price for type=2 products.
    // One name index + one warning log per run.
    const nameIndex = new ProductNameIndex();
    const warnings = new RecipeSyncWarnings();
    for (const p of list) {
      if (p.type !== '2') continue;
      const ppid = Number(p.product_id);
      const parentId = idMap.get(ppid);
      if (parentId === undefined) continue;
      const full = await client.getProduct(ppid);
      if (full === null) continue;
      // Save selling price — only when not yet set manually (sell_price IS NULL).
      // This prevents Poster sync from overwriting prices the user has set by hand.
      // Poster returns price in tiyin; divide by 100 to store in so'm.
      if (full.price !== null && full.price !== undefined && typeof full.price === 'object') {
        const firstPrice = Math.round(Number(Object.values(full.price)[0] ?? '') / 100);
        if (Number.isFinite(firstPrice) && firstPrice > 0) {
          await query(
            `UPDATE products SET sell_price = $1, updated_at = now()
             WHERE id = $2 AND sell_price IS NULL`,
            [firstPrice, parentId],
          );
        }
      }
      if (!Array.isArray(full.ingredients) || full.ingredients.length === 0) continue;
      // A menu product's Poster lines are per unit sold -> yield divisor 1.
      // Menu tech cards keep the historical ingredient-first id fallback.
      const built = await buildComponents(full.ingredients, 1, {
        order: fallbackOrderFor('menu'),
        parentProductId: parentId,
        nameIndex,
      });
      await warnings.afterWrite(parentId, built, await replaceRecipe(parentId, built.components));
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
    // One name index + one warning log per run.
    const nameIndex = new ProductNameIndex();
    const warnings = new RecipeSyncWarnings();
    for (const p of list) {
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      // Poster returns ingredient_id=0 for prepacks that are not directly stocked
      // as raw ingredients — treat these as product_id-keyed-only semi-finished rows.
      const pingRaw = Number(p.ingredient_id);
      const ping: number | null = Number.isInteger(pingRaw) && pingRaw > 0 ? pingRaw : null;
      try {
        // `out` (batch yield) is grams in Poster, kg in the ERP (see prepackYieldKg).
        const batchYieldKg = prepackYieldKg(p.out);
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
        // qty_per_unit = component qty (ERP unit) per 1 kg of finished prepack,
        // BRUTTO-based. Consumption tracks the gross amount taken from stock,
        // which is what Poster charges to себестоимость; netto is unreliable in
        // this account (sometimes the batch yield — 1000 g inflated qty to 1.0
        // and blew cost up ~10000x: мясо курицы; sometimes a rounded net weight
        // below brutto: тесто сслойка 1.0 instead of 1.453). Netto is only a
        // fallback when brutto is missing/zero. See `buildComponents`.
        // Components not yet seeded in the ERP are skipped (next run picks
        // them up); unusual bindings are flagged (RecipeSyncWarnings).
        const built = await buildComponents(p.ingredients ?? [], batchYieldKg, {
          order: fallbackOrderFor('prepack'),
          parentProductId: parentId,
          nameIndex,
        });
        await warnings.afterWrite(parentId, built, await replaceRecipe(parentId, built.components));
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
