/**
 * Bulk Poster recipe audit / apply / restore — "every recipe must match Poster".
 *
 * The owner runs it in-app after deploy (we cannot reach production from the
 * dev machine):
 *
 *   1. AUDIT (dry run): compare every active, linked semi/finished product's
 *      ERP recipe with its Poster tech card and produce a report. Read-only:
 *      it takes no advisory lock, so it never makes the hourly sync skip.
 *   2. APPLY (confirmed product_ids): re-audit, then re-sync each confirmed id
 *      that is STILL a target ('differs', or 'match' + locked) with EXACTLY the
 *      single-product transaction (services/posterRecipeApply.ts) — after ONE
 *      restorable snapshot — and re-audit so the report shows the new state.
 *   3. RESTORE (job_id): put back what an apply job replaced, from its
 *      snapshot in audit_log (works after a restart).
 *
 * One job at a time, kept in memory (single PM2 process; a restart loses the
 * job and the reports — the UI offers to run again; restore still works from
 * audit_log). Apply and restore hold the shared recipe advisory lock, so the
 * hourly recipe sync never writes alongside them; if the lock's connection
 * drops they stop before the next product. A job never throws out of its
 * promise: every failure ends as `status: 'failed'` with a message. Only a
 * failure of the writes fails a job — a closing audit that cannot reach
 * Poster still ends 'done' with a report built from the outcomes.
 *
 * Ops note: the restore lookups filter audit_log on payload->>'job_id' /
 * payload->>'bulk_job_id'; if audit_log grows large, an expression index on
 * those keys (per action) is the fix — no migration needed yet.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db/index.js';
import { AppError, ErrorCode } from '../errors/index.js';
import { poolRunner, writeAudit } from '../lib/audit.js';
import {
  ProductNameIndex,
  cachedRecipeReader,
  findPosterRecipe,
  planRecipeRows,
  readRecipeSnapshot,
  round4,
  sameRecipeRows,
  type ErpProductRef,
  type PosterRecipeLookup,
  type PosterRecipeReader,
  type RecipeLineSnapshot,
} from '../integrations/poster/posterRecipe.js';
import { acquirePosterRecipeLock, type HeldPosterRecipeLock } from '../integrations/poster/recipeLock.js';
import { redactUrl } from '../integrations/poster/syncLog.js';
import { assertNoBomCycle, readRecipeRows } from './bom.js';
import {
  LOCK_NOT_AVAILABLE,
  PRODUCT_BUSY_MESSAGE,
  applyPosterRecipe,
  boundJobTransaction,
  buildForProduct,
  type RecipeApplyActor,
} from './posterRecipeApply.js';

// -----------------------------------------------------------------------------
// Contract types (the frontend codes against these names)
// -----------------------------------------------------------------------------

type JobStatus = {
  id: string;
  kind: 'audit' | 'apply' | 'restore';
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  progress: { done: number; total: number };
  error?: string;
};

type ReportLine = {
  component_product_id: number | null;
  component_name: string;
  erp_qty: number | null;
  poster_qty: number | null;
  stage: string | null;
  diff: 'same' | 'changed' | 'erp_only' | 'poster_only';
};

type ReportItem = {
  product_id: number;
  product_name: string;
  product_type: string;
  product_unit: string;
  recipe_locked: boolean;
  status: 'match' | 'differs' | 'poster_missing' | 'unresolved' | 'poster_error';
  poster_name: string | null;
  source: 'prepack' | 'menu' | null;
  lines: ReportLine[];
  not_found: string[];
  warnings: string[];
  /** Applying Poster now would drop this recipe's Hamir/Krem/Bezak split. */
  stages_will_reset: boolean;
  apply_result?: 'applied' | 'skipped' | 'failed' | 'restored';
  apply_message?: string;
};

type Report = {
  generated_at: string;
  summary: {
    total: number;
    match: number;
    differs: number;
    locked: number;
    poster_missing: number;
    unresolved: number;
    poster_error: number;
    /** Default targets whose apply would drop a stage split. */
    stages_will_reset: number;
    /** Apply reports: products re-synced. */
    applied?: number;
    /** Restore reports: products put back. */
    restored?: number;
    /** Apply/restore reports: not written (skipped, failed or outside the scope). */
    skipped?: number;
  };
  items: ReportItem[];
  /** Apply/restore only: requested ids that are not (any more) in the scope. */
  skipped_outside_scope?: { product_id: number; apply_message: string }[];
  /** Report-level notes (e.g. the closing audit could not run). */
  warnings?: string[];
};

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

const STATE_CHANGED_MESSAGE = "Holati o'zgargan — qayta tekshiring";
const OUTSIDE_SCOPE_MESSAGE =
  "Tekshiruv doirasida emas (topilmadi, nofaol, xom-ashyo yoki Poster bilan bog'lanmagan)";
const NOT_CHANGED_BY_JOB_MESSAGE = "Bu mahsulot o'sha yangilashda o'zgartirilmagan";
const CHANGED_SINCE_APPLY_MESSAGE = "Retsept yangilashdan keyin o'zgargan — tiklanmadi";
const ALREADY_RESTORED_MESSAGE = 'Allaqachon tiklangan';
const RESTORE_CYCLE_MESSAGE =
  "Tiklash BOM'da sikl hosil qiladi (mahsulot o'z komponentiga aylanadi) — tiklanmadi.";
const LOCK_LOST_MESSAGE =
  "Retsept qulfi (ma'lumotlar bazasi aloqasi) uzildi — ish to'xtatildi. Natijalarni tekshirib, qayta ishga tushiring.";
const finalAuditFailedMessage = (detail: string): string =>
  `Yakuniy tekshiruv bajarilmadi (${detail}) — qayta tekshiring`;

// -----------------------------------------------------------------------------
// Scope + comparison
// -----------------------------------------------------------------------------

type ScopeProduct = ErpProductRef & { readonly unit: string; readonly recipe_locked: boolean };

/** What the audit saw for one product — compared again inside the apply tx. */
type AuditedState = { readonly recipe: RecipeLineSnapshot[]; readonly recipeLocked: boolean };

/**
 * Products in scope: ACTIVE semi / finished (and gp — the "Г/П" ready goods,
 * a finished-type product) with a Poster link. Raw materials have no recipe.
 */
export async function loadAuditScope(): Promise<ScopeProduct[]> {
  const { rows } = await query<ScopeProduct>(
    `SELECT id, name, type::text AS type, unit::text AS unit, batch_yield,
            poster_product_id, poster_ingredient_id, recipe_locked
       FROM products
      WHERE type IN ('semi', 'finished', 'gp')
        AND is_active = TRUE
        AND (poster_product_id IS NOT NULL OR poster_ingredient_id IS NOT NULL)
      ORDER BY id`,
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Locate a product's Poster tech card; a per-product Poster error is reported. */
async function lookupSafe(
  reader: PosterRecipeReader,
  p: ErpProductRef,
): Promise<{ lookup: PosterRecipeLookup; error: string | null }> {
  try {
    return { lookup: await findPosterRecipe(reader, p), error: null };
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.POSTER_SYNC_ERROR) {
      return { lookup: { found: false, reason: err.message }, error: err.message };
    }
    throw err;
  }
}

/** A product "apply all" would touch: it differs, or it matches but is locked. */
const isDefaultTarget = (i: ReportItem): boolean =>
  i.status === 'differs' || (i.status === 'match' && i.recipe_locked);

/**
 * Compare one product's ERP recipe with Poster. The item is null when both
 * sides are known to be empty. Stage is shown but ignored for equality; a
 * component split across stages is compared by its summed quantity. The ERP
 * value is compared EXACTLY with Poster's value rounded the way PostgreSQL
 * stores it (`round4`), i.e. with what a write would store.
 *
 * Caveat (ADR-0018 R7): for a stage-split recipe this compares TOTALS, while
 * a final production order consumes only the decoration part (ADR-0016).
 */
async function auditProduct(
  p: ScopeProduct,
  reader: PosterRecipeReader,
  nameIndex: ProductNameIndex,
): Promise<{ item: ReportItem | null; state: AuditedState }> {
  const { lookup, error } = await lookupSafe(reader, p);
  const built = lookup.found ? await buildForProduct(lookup, p, nameIndex) : null;

  const apiRows = await readRecipeRows(poolRunner, p.id);
  const { rows: lockRows } = await query<{ recipe_locked: boolean }>(
    'SELECT recipe_locked FROM products WHERE id = $1',
    [p.id],
  );
  const state: AuditedState = {
    recipe: apiRows.map((r) => ({
      component_product_id: Number(r.component_product_id),
      qty_per_unit: r.qty_per_unit,
      brutto: r.brutto,
      stage: r.stage ?? 'base',
    })),
    recipeLocked: lockRows[0]?.recipe_locked ?? p.recipe_locked,
  };

  const erp = new Map<number, { name: string; qty: number; stage: string | null }>();
  for (const r of apiRows) {
    const id = Number(r.component_product_id);
    const prev = erp.get(id);
    if (prev === undefined) erp.set(id, { name: r.component_name, qty: r.qty_per_unit, stage: r.stage });
    else prev.qty += r.qty_per_unit;
  }

  const posterEmpty = built === null || (built.components.length === 0 && built.unresolved.length === 0);
  if (error === null && erp.size === 0 && posterEmpty) return { item: null, state };

  const poster = new Map((built?.components ?? []).map((c) => [c.componentProductId, c]));
  const lines: ReportLine[] = [];
  for (const [id, e] of erp) {
    const erpQty = round4(e.qty);
    const c = poster.get(id);
    const posterQty = c === undefined ? null : round4(c.qtyPerUnit);
    lines.push({
      component_product_id: id,
      component_name: e.name,
      erp_qty: erpQty,
      poster_qty: posterQty,
      stage: e.stage,
      diff: posterQty === null ? 'erp_only' : Math.abs(erpQty - posterQty) < 1e-9 ? 'same' : 'changed',
    });
  }
  for (const c of built?.components ?? []) {
    if (erp.has(c.componentProductId)) continue;
    lines.push({
      component_product_id: c.componentProductId,
      component_name: c.name,
      erp_qty: null,
      poster_qty: round4(c.qtyPerUnit),
      stage: null,
      diff: 'poster_only',
    });
  }
  for (const u of built?.unresolved ?? []) {
    lines.push({
      component_product_id: null,
      component_name: u.posterName,
      erp_qty: null,
      poster_qty: round4(u.qtyPerUnit),
      stage: null,
      diff: 'poster_only',
    });
  }

  const status: ReportItem['status'] =
    error !== null
      ? 'poster_error'
      : !lookup.found
        ? 'poster_missing'
        : built !== null && built.notFound.length > 0
          ? 'unresolved'
          : lines.every((l) => l.diff === 'same')
            ? 'match'
            : 'differs';
  const writable = (status === 'match' || status === 'differs') && built !== null;

  return {
    item: {
      product_id: p.id,
      product_name: p.name,
      product_type: p.type,
      product_unit: p.unit,
      recipe_locked: state.recipeLocked,
      status,
      poster_name: lookup.found ? lookup.posterName : null,
      source: lookup.found ? lookup.source : null,
      lines,
      not_found: built?.notFound ?? [],
      warnings: [...(error === null ? [] : [error]), ...(built?.warnings ?? [])],
      stages_will_reset: writable ? planRecipeRows(state.recipe, built.components, p.id).stagesReset : false,
    },
    state,
  };
}

async function auditAll(
  scope: readonly ScopeProduct[],
  reader: PosterRecipeReader,
  nameIndex: ProductNameIndex,
  tick: () => void,
): Promise<{ items: ReportItem[]; states: Map<number, AuditedState> }> {
  const items: ReportItem[] = [];
  const states = new Map<number, AuditedState>();
  for (const p of scope) {
    const { item, state } = await auditProduct(p, reader, nameIndex);
    states.set(p.id, state);
    if (item !== null) items.push(item);
    tick();
  }
  return { items, states };
}

type ApplyOutcome = { apply_result: NonNullable<ReportItem['apply_result']>; apply_message?: string };

type WriteResults = {
  readonly kind: 'apply' | 'restore';
  readonly outcomes: ReadonlyMap<number, ApplyOutcome>;
  readonly outside?: readonly { product_id: number; apply_message: string }[];
};

function buildReport(source: readonly ReportItem[], results?: WriteResults, warnings: readonly string[] = []): Report {
  const items = source.map((i) => ({ ...i }));
  const count = (s: ReportItem['status']): number => items.filter((i) => i.status === s).length;
  const summary: Report['summary'] = {
    total: items.length,
    match: count('match'),
    differs: count('differs'),
    locked: items.filter((i) => i.recipe_locked).length,
    poster_missing: count('poster_missing'),
    unresolved: count('unresolved'),
    poster_error: count('poster_error'),
    stages_will_reset: items.filter((i) => isDefaultTarget(i) && i.stages_will_reset).length,
  };
  const report: Report = { generated_at: new Date().toISOString(), summary, items };
  if (results !== undefined) {
    const all = [...results.outcomes.values()];
    const outside = results.outside ?? [];
    const written = all.filter((o) => o.apply_result === (results.kind === 'apply' ? 'applied' : 'restored')).length;
    if (results.kind === 'apply') summary.applied = written;
    else summary.restored = written;
    summary.skipped = all.length - written + outside.length;
    for (const item of items) {
      const o = results.outcomes.get(item.product_id);
      if (o === undefined) continue;
      item.apply_result = o.apply_result;
      if (o.apply_message !== undefined) item.apply_message = o.apply_message;
    }
    if (outside.length > 0) report.skipped_outside_scope = [...outside];
  }
  if (warnings.length > 0) report.warnings = [...warnings];
  return report;
}

/**
 * The closing audit could not run (e.g. Poster down) but the writes are done:
 * report every written/skipped product from the database (names, locks), with
 * status 'poster_error' and the reason, so the report is never empty.
 */
async function reportWithoutAudit(results: WriteResults, err: unknown): Promise<Report> {
  const warning = finalAuditFailedMessage(err instanceof AppError ? err.message : errorText(err));
  const ids = [...results.outcomes.keys()];
  const { rows } = await query<{ id: number; name: string; type: string; unit: string; recipe_locked: boolean }>(
    `SELECT id, name, type::text AS type, unit::text AS unit, recipe_locked
       FROM products WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  const items: ReportItem[] = rows.map((r) => ({
    product_id: Number(r.id),
    product_name: r.name,
    product_type: r.type,
    product_unit: r.unit,
    recipe_locked: r.recipe_locked,
    status: 'poster_error',
    poster_name: null,
    source: null,
    lines: [],
    not_found: [],
    warnings: [warning],
    stages_will_reset: false,
  }));
  return buildReport(items, results, [warning]);
}

/** An error while applying/restoring one product -> its outcome (never thrown). */
function outcomeOfError(err: unknown): ApplyOutcome {
  if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
    return { apply_result: 'skipped', apply_message: PRODUCT_BUSY_MESSAGE };
  }
  if (
    err instanceof AppError &&
    (err.code === ErrorCode.VALIDATION_ERROR || err.code === ErrorCode.POSTER_SYNC_ERROR || err.code === ErrorCode.CONFLICT)
  ) {
    return { apply_result: 'skipped', apply_message: err.message };
  }
  return { apply_result: 'failed', apply_message: `Kutilmagan xato: ${errorText(err)}` };
}

function errorText(err: unknown): string {
  return redactUrl(err instanceof Error ? err.message : String(err));
}

// -----------------------------------------------------------------------------
// Job bodies
// -----------------------------------------------------------------------------

/** Per-job runtime: partial results for a failed job, the lock's health. */
type Runtime = { partial: Report | null; readonly lock: HeldPosterRecipeLock | null };

/** Stop writing once the lock's connection is gone (review R2). */
function assertLockHeld(rt: Runtime): void {
  if (rt.lock?.lost === true) throw AppError.conflict(LOCK_LOST_MESSAGE);
}

/** Fetch the Poster lists ONCE per job; every lookup then reads from memory. */
async function preloadCatalog(reader: PosterRecipeReader): Promise<PosterRecipeReader> {
  const catalog = cachedRecipeReader(reader);
  await catalog.getPrepacks();
  await catalog.getProducts();
  return catalog;
}

async function runAudit(job: JobStatus, reader: PosterRecipeReader): Promise<Report> {
  const catalog = await preloadCatalog(reader);
  const scope = await loadAuditScope();
  job.progress.total = scope.length;
  const { items } = await auditAll(scope, catalog, new ProductNameIndex(), () => {
    job.progress.done += 1;
  });
  return buildReport(items);
}

type ApplyRequest = { readonly productIds: readonly number[]; readonly includeStageResets: boolean };

async function runApply(
  job: JobStatus,
  rt: Runtime,
  reader: PosterRecipeReader,
  req: ApplyRequest,
  actor: RecipeApplyActor,
): Promise<Report> {
  const catalog = await preloadCatalog(reader);
  const nameIndex = new ProductNameIndex();
  const tick = (): void => {
    job.progress.done += 1;
  };
  const scope = await loadAuditScope();
  job.progress.total = scope.length * 2 + req.productIds.length;

  // Fresh pre-audit: only ids that are STILL targets are applied.
  const pre = await auditAll(scope, catalog, nameIndex, tick);
  const scopeById = new Map(scope.map((p) => [p.id, p]));
  const itemById = new Map(pre.items.map((i) => [i.product_id, i]));
  const outcomes = new Map<number, ApplyOutcome>();
  const outside: { product_id: number; apply_message: string }[] = [];
  const results: WriteResults = { kind: 'apply', outcomes, outside };
  const targets: ScopeProduct[] = [];
  for (const id of req.productIds) {
    const p = scopeById.get(id);
    const item = itemById.get(id);
    if (p === undefined) {
      outside.push({ product_id: id, apply_message: OUTSIDE_SCOPE_MESSAGE });
      tick();
    } else if (item === undefined || !isDefaultTarget(item)) {
      outcomes.set(id, { apply_result: 'skipped', apply_message: STATE_CHANGED_MESSAGE });
      tick();
    } else {
      targets.push(p);
    }
  }
  rt.partial = buildReport(pre.items, results);

  if (targets.length > 0) {
    assertLockHeld(rt);
    await writeSnapshot(job.id, targets, pre.states, actor);
  }

  for (const p of targets) {
    assertLockHeld(rt); // outside the per-product catch: stops the whole job
    try {
      const { lookup, error } = await lookupSafe(catalog, p);
      if (error !== null) {
        outcomes.set(p.id, { apply_result: 'skipped', apply_message: error });
      } else {
        await applyPosterRecipe(p, lookup, actor, {
          nameIndex,
          auditContext: { bulk_job_id: job.id },
          refuseStageReset: !req.includeStageResets,
          expected: pre.states.get(p.id)!,
          boundedLocks: true,
        });
        outcomes.set(p.id, { apply_result: 'applied' });
      }
    } catch (err) {
      // One product's failure never stops the job; its transaction rolled back.
      outcomes.set(p.id, outcomeOfError(err));
    }
    tick();
    rt.partial = buildReport(pre.items, results);
  }

  // Fresh audit (locks and recipes changed) -> the post-apply report.
  try {
    const fin = await auditAll(await loadAuditScope(), catalog, nameIndex, tick);
    return buildReport(fin.items, results);
  } catch (err) {
    return reportWithoutAudit(results, err);
  }
}

/**
 * ONE audit row holding, for every target, the recipe rows (incl. stage) and
 * the lock AS THE PRE-AUDIT SAW THEM — the state each product's apply is
 * checked against, so the run can be restored exactly (after a restart too).
 */
async function writeSnapshot(
  jobId: string,
  targets: readonly ScopeProduct[],
  states: ReadonlyMap<number, AuditedState>,
  actor: RecipeApplyActor,
): Promise<void> {
  await writeAudit(poolRunner, {
    actorUserId: actor.userId,
    activeLocationId: actor.activeLocationId,
    action: 'poster.recipe.bulk_resync.snapshot',
    entity: 'recipes',
    entityId: null,
    payload: {
      job_id: jobId,
      products: targets.map((p) => ({
        product_id: p.id,
        product_name: p.name,
        recipe_locked: states.get(p.id)!.recipeLocked,
        recipe: states.get(p.id)!.recipe,
      })),
    },
  });
}

type SnapshotProduct = {
  readonly product_id: number;
  readonly product_name?: string;
  readonly recipe_locked: boolean;
  readonly recipe: RecipeLineSnapshot[];
};

/** The snapshot an apply job wrote, or null (unknown job / nothing to apply). */
export async function loadBulkSnapshot(jobId: string): Promise<SnapshotProduct[] | null> {
  const { rows } = await query<{ payload: { products?: SnapshotProduct[] } }>(
    `SELECT payload FROM audit_log
      WHERE action = 'poster.recipe.bulk_resync.snapshot' AND payload->>'job_id' = $1
      ORDER BY id DESC LIMIT 1`,
    [jobId],
  );
  const products = rows[0]?.payload.products;
  return products === undefined ? null : products;
}

/** What the apply job wrote per product (from its per-product audit rows). */
async function loadWrittenByJob(jobId: string): Promise<Map<number, RecipeLineSnapshot[]>> {
  const { rows } = await query<{ entity_id: number; components: RecipeLineSnapshot[] }>(
    `SELECT entity_id, payload->'components' AS components FROM audit_log
      WHERE action = 'product.recipe.poster_resync' AND payload->>'bulk_job_id' = $1
      ORDER BY id`,
    [jobId],
  );
  return new Map(rows.map((r) => [Number(r.entity_id), r.components]));
}

/**
 * The most recent apply job that still has something to restore: at least one
 * product it re-synced without a restore row for that job yet (review R3).
 */
async function findRestorableJobId(): Promise<string | null> {
  const { rows } = await query<{ job_id: string }>(
    `SELECT r.payload->>'bulk_job_id' AS job_id
       FROM audit_log r
      WHERE r.action = 'product.recipe.poster_resync'
        AND r.payload ? 'bulk_job_id'
        AND EXISTS (
          SELECT 1 FROM audit_log s
           WHERE s.action = 'poster.recipe.bulk_resync.snapshot'
             AND s.payload->>'job_id' = r.payload->>'bulk_job_id')
        AND NOT EXISTS (
          SELECT 1 FROM audit_log x
           WHERE x.action = 'poster.recipe.bulk_resync.restore'
             AND x.payload->>'job_id' = r.payload->>'bulk_job_id'
             AND x.entity_id = r.entity_id)
      ORDER BY r.id DESC
      LIMIT 1`,
  );
  return rows[0]?.job_id ?? null;
}

type RestoreRequest = { readonly jobId: string; readonly productIds?: readonly number[] };

/**
 * Put one product back to its snapshot — only if it still holds exactly what
 * the apply job wrote (and is still unlocked); a later edit is never undone.
 * A product already equal to its snapshot is reported (and marked restored).
 */
async function restoreProduct(
  jobId: string,
  snap: SnapshotProduct,
  written: readonly RecipeLineSnapshot[],
  actor: RecipeApplyActor,
): Promise<'restored' | 'already'> {
  return withTransaction(async (tx) => {
    await boundJobTransaction(tx);
    const { rows } = await tx.query<{ recipe_locked: boolean }>(
      'SELECT recipe_locked FROM products WHERE id = $1 FOR NO KEY UPDATE',
      [snap.product_id],
    );
    if (rows[0] === undefined) throw AppError.validation('Mahsulot topilmadi.');
    const current = await readRecipeSnapshot(tx, snap.product_id);
    const audit = (payload: Record<string, unknown>): Promise<void> =>
      writeAudit(tx, {
        actorUserId: actor.userId,
        activeLocationId: actor.activeLocationId,
        action: 'poster.recipe.bulk_resync.restore',
        entity: 'recipes',
        entityId: snap.product_id,
        payload: { job_id: jobId, ...payload },
      });

    if (rows[0].recipe_locked === snap.recipe_locked && sameRecipeRows(current, snap.recipe)) {
      await audit({ already_restored: true });
      return 'already';
    }
    if (rows[0].recipe_locked || !sameRecipeRows(current, written)) {
      throw AppError.validation(CHANGED_SINCE_APPLY_MESSAGE);
    }
    try {
      await assertNoBomCycle(tx, snap.product_id, snap.recipe.map((r) => Number(r.component_product_id)));
    } catch (err) {
      if (err instanceof AppError) throw AppError.validation(RESTORE_CYCLE_MESSAGE);
      throw err;
    }
    await tx.query('DELETE FROM recipes WHERE product_id = $1', [snap.product_id]);
    for (const r of snap.recipe) {
      await tx.query(
        `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
         VALUES ($1, $2, $3, $4, $5)`,
        [snap.product_id, r.component_product_id, r.qty_per_unit, r.brutto, r.stage],
      );
    }
    await tx.query(
      'UPDATE products SET recipe_locked = $2, updated_at = now() WHERE id = $1',
      [snap.product_id, snap.recipe_locked],
    );
    await audit({
      restored_components: snap.recipe,
      restored_recipe_locked: snap.recipe_locked,
      replaced_components: current,
    });
    return 'restored';
  });
}

async function runRestore(
  job: JobStatus,
  rt: Runtime,
  reader: PosterRecipeReader,
  req: RestoreRequest,
  actor: RecipeApplyActor,
): Promise<Report> {
  const snapshot = await loadBulkSnapshot(req.jobId);
  if (snapshot === null) throw AppError.notFound('Bu yangilash uchun tiklash nuqtasi (snapshot) topilmadi.');
  const written = await loadWrittenByJob(req.jobId);
  const snapById = new Map(snapshot.map((p) => [Number(p.product_id), p]));
  const ids = req.productIds ?? snapshot.map((p) => Number(p.product_id));
  job.progress.total = ids.length;
  const tick = (): void => {
    job.progress.done += 1;
  };

  // Restore first — it needs no Poster; the closing audit does.
  const outcomes = new Map<number, ApplyOutcome>();
  const results: WriteResults = { kind: 'restore', outcomes };
  for (const id of ids) {
    assertLockHeld(rt); // outside the per-product catch: stops the whole job
    const snap = snapById.get(id);
    const wrote = written.get(id);
    if (snap === undefined || wrote === undefined) {
      outcomes.set(id, { apply_result: 'skipped', apply_message: NOT_CHANGED_BY_JOB_MESSAGE });
    } else {
      try {
        const done = await restoreProduct(req.jobId, snap, wrote, actor);
        outcomes.set(
          id,
          done === 'restored'
            ? { apply_result: 'restored' }
            : { apply_result: 'skipped', apply_message: ALREADY_RESTORED_MESSAGE },
        );
      } catch (err) {
        outcomes.set(id, outcomeOfError(err));
      }
    }
    tick();
    rt.partial = buildReport([], results);
  }

  try {
    const catalog = await preloadCatalog(reader);
    const scope = await loadAuditScope();
    job.progress.total += scope.length;
    const fin = await auditAll(scope, catalog, new ProductNameIndex(), tick);
    return buildReport(fin.items, results);
  } catch (err) {
    return reportWithoutAudit(results, err);
  }
}

// -----------------------------------------------------------------------------
// In-memory job manager (one job at a time; writers under the advisory lock)
// -----------------------------------------------------------------------------

/** The job reserved or running right now (null when idle). */
let current: JobStatus | null = null;
let latestJob: JobStatus | null = null;
/** Latest audit report — dry run, post-apply or post-restore. */
let latestReport: Report | null = null;
/** Report of the latest apply/restore job (not wiped by a later dry run). */
let lastApplyReport: Report | null = null;
let running: Promise<void> | null = null;

const snapshotJob = (job: JobStatus): JobStatus => ({ ...job, progress: { ...job.progress } });

export type StartOutcome =
  | { readonly outcome: 'started' | 'running'; readonly job: JobStatus }
  | { readonly outcome: 'sync_busy' };

async function start(
  kind: JobStatus['kind'],
  work: (job: JobStatus, rt: Runtime) => Promise<Report>,
): Promise<StartOutcome> {
  if (current !== null) return { outcome: 'running', job: snapshotJob(current) };
  const job: JobStatus = {
    id: randomUUID(),
    kind,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: { done: 0, total: 0 },
  };
  current = job; // reserved synchronously: a concurrent request sees it
  // Writers take the shared advisory lock; the read-only dry run does not
  // (so it never makes the hourly sync skip a whole hour) — review N5.
  let lock: HeldPosterRecipeLock | null = null;
  if (kind !== 'audit') {
    try {
      lock = await acquirePosterRecipeLock();
    } catch (err) {
      current = null;
      throw err;
    }
    if (lock === null) {
      current = null;
      return { outcome: 'sync_busy' };
    }
  }
  latestJob = job;
  const rt: Runtime = { partial: null, lock };
  running = (async () => {
    try {
      const report = await work(job, rt);
      latestReport = report;
      if (kind !== 'audit') lastApplyReport = report;
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof AppError ? err.message : `Kutilmagan xato: ${errorText(err)}`;
      if (kind !== 'audit' && rt.partial !== null) lastApplyReport = rt.partial;
      console.error('[poster:recipe-audit] job failed:', job.error);
    } finally {
      job.finished_at = new Date().toISOString();
      await lock?.release();
    }
  })()
    .catch(() => undefined) // belt and braces: never an unhandled rejection
    .finally(() => {
      running = null;
      current = null;
    });
  return { outcome: 'started', job: snapshotJob(job) };
}

/** Start a dry-run audit (or report the job that is already running). */
export function startRecipeAudit(reader: PosterRecipeReader): Promise<StartOutcome> {
  return start('audit', (job) => runAudit(job, reader));
}

/** Start a bulk apply of confirmed product ids. */
export function startRecipeApply(
  reader: PosterRecipeReader,
  req: ApplyRequest,
  actor: RecipeApplyActor,
): Promise<StartOutcome> {
  return start('apply', (job, rt) => runApply(job, rt, reader, req, actor));
}

/** Start restoring an apply job's snapshot. */
export function startRecipeRestore(
  reader: PosterRecipeReader,
  req: RestoreRequest,
  actor: RecipeApplyActor,
): Promise<StartOutcome> {
  return start('restore', (job, rt) => runRestore(job, rt, reader, req, actor));
}

/** The latest job only (cheap — for polling). */
export function getRecipeAuditJob(): { job: JobStatus | null } {
  return { job: latestJob === null ? null : snapshotJob(latestJob) };
}

/** The latest job, the latest audit report, the latest apply/restore report. */
export async function getRecipeAuditState(): Promise<{
  job: JobStatus | null;
  report: Report | null;
  last_apply_report: Report | null;
  restorable_job_id: string | null;
}> {
  return {
    ...getRecipeAuditJob(),
    report: latestReport,
    last_apply_report: lastApplyReport,
    restorable_job_id: await findRestorableJobId(),
  };
}

/**
 * Resolves when no job is running. Used by tests; NOT wired into graceful
 * shutdown on purpose — a bulk job can run for minutes, PM2 kills the process
 * long before, and an interrupted job is safe: each product is its own
 * transaction (Postgres rolls back the one in flight) and the snapshot is
 * already in audit_log.
 */
export async function whenRecipeAuditIdle(): Promise<void> {
  while (running !== null) await running;
}

/** TEST-ONLY — forget the latest job and reports (simulates a restart). */
export function resetRecipeAuditForTests(): void {
  latestJob = null;
  latestReport = null;
  lastApplyReport = null;
}
