/**
 * Re-sync ONE product's recipe from Poster — the per-product transaction.
 *
 * Shared, byte-for-byte, by:
 *   - POST /api/integrations/poster/product-recipe/:id/apply   (one product);
 *   - the bulk recipe-audit apply job (services/posterRecipeAudit.ts).
 *
 * Every business rejection is an AppError with an Uzbek message and leaves the
 * product untouched (recipe AND lock): the endpoint turns it into a 4xx, the
 * bulk job into `apply_result: 'skipped'` with that message.
 */
import { withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { loadConfig } from '../config/index.js';
import { writeAudit } from '../lib/audit.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import {
  STAGES_RESET_WARNING,
  buildComponents,
  fallbackOrderFor,
  readRecipeSnapshot,
  roundingWarning,
  sameRecipeRows,
  writePosterRecipe,
  type ErpProductRef,
  type PosterRecipeLookup,
  type PosterRecipeReader,
  type ProductNameIndex,
  type RecipeLineSnapshot,
} from '../integrations/poster/posterRecipe.js';
import { redactUrl } from '../integrations/poster/syncLog.js';
import { assertNoBomCycle, readRecipeRows, type RecipeApiRow } from './bom.js';

// -----------------------------------------------------------------------------
// Poster access
// -----------------------------------------------------------------------------

/**
 * Poster failures used to escape as raw PosterApiError, which the terminal
 * error handler reports as a bare 500 "An unexpected error occurred." — the
 * user could not tell a Poster outage from an ERP bug. Surface the real reason
 * as a 502 instead (token redacted: this text reaches the browser).
 */
async function posterCall<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = redactUrl(err instanceof Error ? err.message : String(err));
    throw AppError.posterSync(`Poster bilan bog'lanib bo'lmadi (${method}): ${detail}`);
  }
}

/** The client's recipe reads, each wrapped so a Poster failure becomes a 502. */
function guardedRecipeReader(client: PosterRecipeReader): PosterRecipeReader {
  return {
    getPrepacks: () => posterCall('menu.getPrepacks', () => client.getPrepacks()),
    getProducts: () => posterCall('menu.getProducts', () => client.getProducts()),
    getProduct: (id: number) => posterCall('menu.getProduct', () => client.getProduct(id)),
  };
}

/** The configured Poster client, guarded; 500 when the token is missing. */
export function requirePosterRecipeReader(): PosterRecipeReader {
  if (loadConfig().poster.token === '') {
    throw AppError.internal("Poster tokeni (POSTER_TOKEN) sozlanmagan — Poster integratsiyasi o'chirilgan.");
  }
  return guardedRecipeReader(createPosterClientFromConfig());
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export const notFoundMessage = (names: readonly string[]): string =>
  `Quyidagi komponentlar ERP'da topilmadi: ${names.join(', ')}. Avval Poster sinxronlashni ishga tushiring.`;

export const NO_USABLE_LINES_MESSAGE = "Poster retseptida yaroqli komponent yo'q.";

/** Uzbek text for a product whose Poster tech card could not be located. */
export const missingRecipeMessage = (reason: string): string =>
  `Poster'da bu mahsulot retsepti topilmadi (${reason}).`;

/** Bulk apply without `include_stage_resets`: the split would be lost. */
const STAGE_SPLIT_WOULD_BE_LOST_MESSAGE =
  "Hamir/Krem/Bezak bo'linishi yo'qolardi — alohida tasdiq bilan yangilang.";

/** Bulk apply: the recipe or its lock changed after the pre-audit. */
const CHANGED_SINCE_AUDIT_MESSAGE = "Retsept tekshiruvdan keyin o'zgargan";

/** A job transaction hit lock_timeout on the product / recipe rows. */
export const PRODUCT_BUSY_MESSAGE = "Mahsulot band — keyinroq urinib ko'ring";

/** recipes.qty_per_unit is NUMERIC(14,4): anything below this rounds to 0. */
const MIN_STORABLE_QTY = 0.00005;

/** SQLSTATE lock_not_available — raised when `lock_timeout` expires. */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Bounds for a background-job transaction: never wait on a row lock for more
 * than 5 s, never run one statement for more than 60 s. `SET LOCAL` cannot
 * take bind parameters, hence the literal constants.
 */
export async function boundJobTransaction(tx: { query(text: string): Promise<unknown> }): Promise<void> {
  await tx.query("SET LOCAL lock_timeout = '5s'");
  await tx.query("SET LOCAL statement_timeout = '60s'");
}

// -----------------------------------------------------------------------------
// Build + apply
// -----------------------------------------------------------------------------

type FoundLookup = Extract<PosterRecipeLookup, { found: true }>;

/**
 * Build the ERP components of a located tech card. Preview, apply and the
 * bulk audit MUST use this one call so they agree: the same id fallback order
 * as the hourly sync for this source, and no self-reference.
 */
export function buildForProduct(
  lookup: FoundLookup,
  erp: ErpProductRef,
  nameIndex?: ProductNameIndex,
): ReturnType<typeof buildComponents> {
  return buildComponents(lookup.lines, lookup.batchYieldKg, {
    order: fallbackOrderFor(lookup.source),
    parentProductId: erp.id,
    ...(nameIndex !== undefined ? { nameIndex } : {}),
  });
}

export type RecipeApplyActor = {
  readonly userId: number | null;
  readonly activeLocationId: number | null;
};

type RecipeApplyResult = {
  readonly source: 'prepack' | 'menu';
  readonly posterProductId: number;
  readonly posterName: string;
  readonly recipe: RecipeApiRow[];
  readonly stagesReset: boolean;
  readonly warnings: string[];
};

type ApplyOptions = {
  readonly nameIndex?: ProductNameIndex;
  readonly auditContext?: Record<string, unknown>;
  /** Refuse (skip) when the write would lose a Hamir/Krem/Bezak split. */
  readonly refuseStageReset?: boolean;
  /** The state the caller audited: skip if the recipe or lock changed since. */
  readonly expected?: { readonly recipe: readonly RecipeLineSnapshot[]; readonly recipeLocked: boolean };
  /** Background job: SET LOCAL lock_timeout / statement_timeout. */
  readonly boundedLocks?: boolean;
};

/**
 * Replace `erp`'s recipe with its Poster tech card and clear `recipe_locked`,
 * in ONE transaction: lock the product row, (compare with the audited state),
 * cycle check, write (stage rule of `planRecipeRows`), unlock, audit
 * `product.recipe.poster_resync`.
 *
 * Rejected (AppError, nothing written) when Poster has no recipe, a component
 * does not resolve, no usable line is left, the recipe would close a BOM
 * cycle, a row is too small for / rejected by the database, the recipe changed
 * since the audit, the split would be lost (when refused), or the row is busy.
 */
export async function applyPosterRecipe(
  erp: ErpProductRef,
  lookup: PosterRecipeLookup,
  actor: RecipeApplyActor,
  opts: ApplyOptions = {},
): Promise<RecipeApplyResult> {
  if (!lookup.found) {
    throw AppError.validation(missingRecipeMessage(lookup.reason));
  }
  const built = await buildForProduct(lookup, erp, opts.nameIndex);
  if (built.notFound.length > 0) {
    throw AppError.validation(notFoundMessage(built.notFound));
  }
  const components = built.components;
  if (components.length === 0) {
    throw AppError.validation(`${NO_USABLE_LINES_MESSAGE} O'zgartirish kiritilmadi.`);
  }
  const warnings = [...built.warnings];
  const nameOf = (id: number): string =>
    components.find((c) => c.componentProductId === id)?.name ?? `#${id}`;

  try {
    return await withTransaction(async (tx) => {
      if (opts.boundedLocks === true) await boundJobTransaction(tx);
      // Serialise with the hourly sync / other writers of this product (lock
      // order everywhere: products row first, then recipes). NO KEY UPDATE:
      // only recipes/recipe_locked change, so FK checks on the row still pass.
      const { rows: locked } = await tx.query<{ recipe_locked: boolean }>(
        'SELECT recipe_locked FROM products WHERE id = $1 FOR NO KEY UPDATE',
        [erp.id],
      );
      if (opts.expected !== undefined) {
        const current = await readRecipeSnapshot(tx, erp.id);
        if (locked[0]?.recipe_locked !== opts.expected.recipeLocked || !sameRecipeRows(current, opts.expected.recipe)) {
          throw AppError.validation(CHANGED_SINCE_AUDIT_MESSAGE);
        }
      }
      try {
        await assertNoBomCycle(tx, erp.id, components.map((c) => c.componentProductId));
      } catch (err) {
        if (err instanceof AppError) {
          throw AppError.validation(
            "Poster retsepti BOM'da sikl hosil qiladi (mahsulot o'z komponentiga aylanadi). O'zgartirish kiritilmadi.",
          );
        }
        throw err;
      }

      const written = await writePosterRecipe(tx, erp.id, components, {
        refuseStageReset: opts.refuseStageReset === true,
      });
      if (written.refused) {
        throw AppError.validation(STAGE_SPLIT_WOULD_BE_LOST_MESSAGE);
      }
      // A row the database rejected would leave a partial recipe — reject the
      // whole apply instead (the throw rolls the transaction back).
      if (written.skipped.some((s) => s.code === LOCK_NOT_AVAILABLE)) {
        throw AppError.conflict(PRODUCT_BUSY_MESSAGE);
      }
      if (written.skipped.length > 0) {
        const tooSmall = written.skipped.filter(
          (s) => (components.find((c) => c.componentProductId === s.componentProductId)?.qtyPerUnit ?? 0) < MIN_STORABLE_QTY,
        );
        const other = written.skipped.filter((s) => !tooSmall.includes(s));
        const parts: string[] = [];
        if (tooSmall.length > 0) {
          parts.push(
            "Quyidagi komponentlar miqdori juda kichik — 4 xonali kasrda saqlab bo'lmaydi (0.0001 dan kam): " +
              `${tooSmall.map((s) => nameOf(s.componentProductId)).join(', ')}.`,
          );
        }
        if (other.length > 0) {
          parts.push(
            "Quyidagi retsept qatorlarini yozib bo'lmadi: " +
              `${other.map((s) => `${nameOf(s.componentProductId)} (${s.code ?? 'xato'})`).join(', ')}.`,
          );
        }
        throw AppError.validation(`${parts.join(' ')} O'zgartirish kiritilmadi.`);
      }
      if (written.stagesReset) warnings.push(STAGES_RESET_WARNING);
      for (const r of written.roundingChanges) {
        warnings.push(roundingWarning(nameOf(r.componentProductId), r.from, r.to));
      }

      await tx.query(
        'UPDATE products SET recipe_locked = FALSE, updated_at = now() WHERE id = $1',
        [erp.id],
      );
      await writeAudit(tx, {
        actorUserId: actor.userId,
        activeLocationId: actor.activeLocationId,
        action: 'product.recipe.poster_resync',
        entity: 'recipes',
        entityId: erp.id,
        payload: {
          ...opts.auditContext,
          source: lookup.source,
          matched_by: lookup.matchedBy,
          poster_product_id: lookup.posterProductId,
          poster_name: lookup.posterName,
          batch_yield_kg: lookup.batchYieldKg,
          components: written.written,
          previous_components: written.previous,
          previous_recipe_locked: locked[0]?.recipe_locked ?? null,
          stages_reset: written.stagesReset,
          rounding_changes: written.roundingChanges,
          name_mismatches: components
            .filter((c) => c.nameMismatch)
            .map((c) => ({
              component_product_id: c.componentProductId,
              poster_name: c.posterName,
              erp_name: c.name,
            })),
          name_bindings: components
            .filter((c) => c.matchedBy === 'name')
            .map((c) => ({
              component_product_id: c.componentProductId,
              poster_ingredient_id: c.posterIngredientId,
              poster_name: c.posterName,
              erp_name: c.name,
            })),
          merged_duplicates: built.duplicates,
        },
      });
      return {
        source: lookup.source,
        posterProductId: lookup.posterProductId,
        posterName: lookup.posterName,
        recipe: await readRecipeRows(tx, erp.id),
        stagesReset: written.stagesReset,
        warnings,
      };
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw AppError.conflict(PRODUCT_BUSY_MESSAGE);
    }
    throw err;
  }
}
