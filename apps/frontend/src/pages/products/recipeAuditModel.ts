import type { RecipeAuditItem, RecipeAuditReport, RecipeAuditState } from '@/lib/types';

/**
 * The backend's apply target rule: a differing recipe, or a matching one that
 * is still locked (applying it opens the lock so later Poster changes sync).
 * `unresolved` / `poster_missing` / `poster_error` are never targets.
 */
export function isApplyTarget(item: RecipeAuditItem): boolean {
  return item.status === 'differs' || (item.status === 'match' && item.recipe_locked);
}

/**
 * Targets split the way the confirm has to describe them. A recipe whose
 * Hamir/Krem/Bezak split would be lost is counted only in `stageResets`, so
 * nothing claims "only the lock opens" for a recipe whose stages change.
 */
export interface ApplyPlan {
  differs: number[];
  lockedMatch: number[];
  stageResets: number[];
}

export function planApply(items: readonly RecipeAuditItem[]): ApplyPlan {
  const plan: ApplyPlan = { differs: [], lockedMatch: [], stageResets: [] };
  for (const item of items) {
    if (!isApplyTarget(item)) continue;
    if (item.stages_will_reset === true) plan.stageResets.push(item.product_id);
    else if (item.status === 'differs') plan.differs.push(item.product_id);
    else plan.lockedMatch.push(item.product_id);
  }
  return plan;
}

/** The explicit ids to send; stage resets only when the user opted in. */
export function planIds(plan: ApplyPlan, includeStageResets: boolean): number[] {
  return [
    ...plan.differs,
    ...plan.lockedMatch,
    ...(includeStageResets ? plan.stageResets : []),
  ];
}

export function planSize(plan: ApplyPlan): number {
  return plan.differs.length + plan.lockedMatch.length + plan.stageResets.length;
}

/** A report older than this should be re-checked before a bulk apply. */
export const STALE_REPORT_MS = 10 * 60 * 1000;

export function isReportStale(report: RecipeAuditReport, now: number = Date.now()): boolean {
  const at = new Date(report.generated_at).getTime();
  return Number.isFinite(at) && now - at > STALE_REPORT_MS;
}

export interface ApplyCounts {
  applied: number | undefined;
  skipped: number | undefined;
  restored: number | undefined;
}

/**
 * Outcome counts of an apply/restore report, taken from `summary` so they
 * survive a report whose `items` are empty. `summary.restored` is
 * authoritative when present (then `applied` excludes restores). Without it,
 * an older report may count restores inside `applied`; if its items show
 * restores, both numbers come from the items so nothing is counted twice.
 */
export function applyCounts(report: RecipeAuditReport): ApplyCounts {
  const { summary, items } = report;
  if (summary.restored !== undefined) {
    return { applied: summary.applied, skipped: summary.skipped, restored: summary.restored };
  }
  const restoredItems = items.filter((i) => i.apply_result === 'restored').length;
  if (restoredItems > 0) {
    return {
      applied: items.filter((i) => i.apply_result === 'applied').length,
      skipped: summary.skipped,
      restored: restoredItems,
    };
  }
  return { applied: summary.applied, skipped: summary.skipped, restored: undefined };
}

/** Tolerates a backend that omits the optional parts of the envelope. */
export function normalizeState(data: Partial<RecipeAuditState>): RecipeAuditState {
  return {
    job: data.job ?? null,
    report: data.report ?? null,
    last_apply_report: data.last_apply_report ?? null,
    restorable_job_id: data.restorable_job_id ?? null,
  };
}
