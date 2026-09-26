import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CloudDownload,
  ListChecks,
  Loader2,
  Play,
  Search,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime, formatPlainNumber } from '@/lib/format';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type { RecipeAuditItem, RecipeAuditJob, RecipeAuditReport } from '@/lib/types';
import { RecipeAuditRow } from './RecipeAuditRow';
import { RecipeAuditApplyDialog } from './RecipeAuditApplyDialog';
import { RecipeAuditRestoreDialog } from './RecipeAuditRestoreDialog';
import { RECIPE_AUDIT_APPLY_ROLES } from './recipeAuditAccess';
import {
  applyCounts,
  isApplyTarget,
  isReportStale,
  planApply,
  planIds,
  planSize,
  type ApplyPlan,
} from './recipeAuditModel';
import { RECIPE_AUDIT_API, RECIPE_AUDIT_POLL_MS, useRecipeAudit } from './useRecipeAudit';

interface Filter {
  key: string;
  label: string;
  test: (i: RecipeAuditItem) => boolean;
}

/** Filters of the latest dry-run report. */
const AUDIT_FILTERS: readonly Filter[] = [
  { key: 'all', label: 'Hammasi', test: () => true },
  { key: 'differs', label: 'Farqli', test: (i) => i.status === 'differs' },
  { key: 'locked', label: 'Qulflangan', test: (i) => i.recipe_locked },
  { key: 'stages', label: "Bosqichlari yo'qoladi", test: (i) => i.stages_will_reset === true },
  { key: 'unresolved', label: 'Topilmagan', test: (i) => i.status === 'unresolved' },
  { key: 'poster_missing', label: "Poster'da yo'q", test: (i) => i.status === 'poster_missing' },
  { key: 'poster_error', label: 'Poster xatosi', test: (i) => i.status === 'poster_error' },
];

const notApplied = (i: RecipeAuditItem) =>
  i.apply_result === 'skipped' || i.apply_result === 'failed';

/** Filters of the last bulk-apply outcome. `skipped` counts failed ones too. */
const APPLY_FILTERS: readonly Filter[] = [
  { key: 'all', label: 'Hammasi', test: () => true },
  { key: 'applied', label: 'Yangilandi', test: (i) => i.apply_result === 'applied' },
  { key: 'not_applied', label: 'Yangilanmagan', test: notApplied },
  { key: 'restored', label: 'Tiklandi', test: (i) => i.apply_result === 'restored' },
];

/** Rows that need a decision come first. */
const STATUS_ORDER: Record<RecipeAuditItem['status'], number> = {
  differs: 0,
  poster_error: 1,
  unresolved: 2,
  poster_missing: 3,
  match: 4,
};

const JOB_LABEL: Record<RecipeAuditJob['kind'], { running: string; name: string }> = {
  audit: { running: 'Retseptlar tekshirilmoqda…', name: 'Tekshirish' },
  apply: { running: "Retseptlar Poster'dan yangilanmoqda…", name: "Poster'dan yangilash" },
  restore: { running: 'Retseptlar tiklanmoqda…', name: 'Yangilashni bekor qilish' },
};

type View = 'audit' | 'apply';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * "Poster bilan solishtirish" — compares every semi/finished recipe with
 * Poster (a background audit job), shows the differences, and lets a PM
 * replace the targets from Poster in bulk (opening their locks) or undo the
 * last bulk apply.
 *
 * Reached from the Mahsulotlar page (route `/products/recipe-audit`, gated by
 * RECIPE_AUDIT_ROLES); only RECIPE_AUDIT_APPLY_ROLES see apply / restore.
 */
export function RecipeAuditPage({ pollMs = RECIPE_AUDIT_POLL_MS }: { pollMs?: number }) {
  const { user } = useAuth();
  const { notify } = useToast();
  const audit = useRecipeAudit(pollMs);
  const canApply = user !== null && RECIPE_AUDIT_APPLY_ROLES.includes(user.role);

  const job = audit.state?.job ?? null;
  const report = audit.state?.report ?? null;
  const applyReport = audit.state?.last_apply_report ?? null;
  const restorableJobId = audit.state?.restorable_job_id ?? null;

  const [view, setView] = useState<View>('audit');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
  const [applyPlan, setApplyPlan] = useState<ApplyPlan | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // A new report replaces the rows, so a selection made on the old one is void.
  const generatedAt = report?.generated_at;
  useEffect(() => {
    setSelected(new Set());
  }, [generatedAt]);

  // With only an apply outcome to show, show it.
  const activeView: View = report === null && applyReport !== null ? 'apply' : view;

  // Announce a job that finished while the page was watching it, and switch
  // to the view that holds its result.
  const previousJobRef = useRef<RecipeAuditJob | null>(null);
  useEffect(() => {
    const previous = previousJobRef.current;
    previousJobRef.current = job;
    if (
      previous === null ||
      job === null ||
      previous.id !== job.id ||
      previous.status !== 'running' ||
      job.status === 'running'
    ) {
      return;
    }
    if (job.status === 'failed') {
      notify('error', job.error ?? 'Jarayon muvaffaqiyatsiz tugadi.');
      return;
    }
    if (job.kind === 'audit' && report !== null) {
      const { summary } = report;
      const stages = summary.stages_will_reset ?? 0;
      notify(
        summary.differs > 0 ? 'warning' : 'success',
        `Tekshirish tugadi: ${summary.total} ta mahsulot, ${summary.differs} tasi farqli.` +
          (stages > 0 ? ` ${stages} tasida bosqichlar yo'qolardi.` : ''),
      );
      setView('audit');
    } else if (job.kind === 'apply' && applyReport !== null) {
      const counts = applyCounts(applyReport);
      const skipped = counts.skipped ?? 0;
      const notes = applyReport.warnings ?? [];
      notify(
        skipped > 0 || notes.length > 0 ? 'warning' : 'success',
        `Poster'dan yangilash tugadi: ${counts.applied ?? 0} ta yangilandi, ` +
          `${skipped} tasi yangilanmadi.` +
          (notes.length > 0 ? ` ${notes.join(' ')}` : ''),
      );
      setView('apply');
    } else if (job.kind === 'restore') {
      // A restore whose final audit failed still finishes 'done'; its counts
      // live in `summary` and the reason in the report warnings.
      const restored = applyReport === null ? 0 : (applyCounts(applyReport).restored ?? 0);
      const notes = applyReport?.warnings ?? [];
      notify(
        notes.length > 0 ? 'warning' : 'success',
        `Oxirgi ommaviy yangilash bekor qilindi: ${restored} ta retsept tiklandi.` +
          (notes.length > 0 ? ` ${notes.join(' ')}` : ''),
      );
      setView('apply');
    }
  }, [job, report, applyReport, notify]);

  const allPlan = useMemo(() => planApply(report?.items ?? []), [report]);
  const isBusy = audit.isRunning || isStarting || audit.isLoading;

  /** POSTs a job start; 409 (another job or the hourly sync holds the lock) re-reads the state. */
  async function startJob(
    path: 'run' | 'apply' | 'restore',
    body: object,
    onError: (message: string) => void,
  ): Promise<boolean> {
    setIsStarting(true);
    try {
      const res = await apiRequest<{ job: RecipeAuditJob }>(`${RECIPE_AUDIT_API}/${path}`, {
        method: 'POST',
        body,
      });
      audit.adoptJob(res.job);
      return true;
    } catch (err: unknown) {
      const message = errorMessage(err, "Jarayonni boshlab bo'lmadi.");
      if (err instanceof ApiError && err.status === 409) {
        notify('error', message);
        audit.reload();
        return true; // nothing more the dialog can do
      }
      onError(message);
      return false;
    } finally {
      setIsStarting(false);
    }
  }

  function startAudit() {
    void startJob('run', {}, (message) => notify('error', message));
  }

  function openApply(items: readonly RecipeAuditItem[]) {
    setApplyError(null);
    setApplyPlan(planApply(items));
  }

  async function confirmApply(includeStageResets: boolean) {
    if (applyPlan === null) return;
    const done = await startJob(
      'apply',
      // Always explicit ids, computed from the report on screen; the server
      // re-checks each one and skips what changed since.
      { product_ids: planIds(applyPlan, includeStageResets), include_stage_resets: includeStageResets },
      setApplyError,
    );
    if (done) setApplyPlan(null);
  }

  async function confirmRestore() {
    if (restorableJobId === null) return;
    const done = await startJob('restore', { job_id: restorableJobId }, setRestoreError);
    if (done) setRestoreOpen(false);
  }

  const appliedCount =
    applyReport === null
      ? null
      : applyReport.items.filter((i) => i.apply_result === 'applied').length;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <Link
        to="/products"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Mahsulotlar
      </Link>

      <PageHeader
        title="Poster bilan solishtirish"
        description="Har bir yarim tayyor va tayyor mahsulot retsepti Poster'dagi bilan solishtiriladi."
        action={
          <>
            {canApply && restorableJobId !== null && (
              <Button
                variant="outline"
                onClick={() => {
                  setRestoreError(null);
                  setRestoreOpen(true);
                }}
                disabled={isBusy}
              >
                <Undo2 className="size-4" aria-hidden="true" />
                Oxirgi ommaviy yangilashni bekor qilish
              </Button>
            )}
            <Button onClick={startAudit} disabled={isBusy}>
              {isStarting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
              Tekshirishni boshlash
            </Button>
          </>
        }
      />

      {audit.isLoading && <LoadingState />}

      {!audit.isLoading && audit.state === null && audit.error !== null && (
        <Card>
          <ErrorState message={audit.error} onRetry={audit.reload} />
        </Card>
      )}

      {/* Background refresh failed: the last state stays, polling retries. */}
      {audit.state !== null && audit.error !== null && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          Holatni yangilab bo'lmadi: {audit.error}
          {audit.isRunning && ' Qayta urinilmoqda…'}
        </p>
      )}

      {job !== null && job.status === 'running' && <JobProgress job={job} />}

      {job !== null && job.status === 'failed' && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <p className="font-medium">
                {JOB_LABEL[job.kind].name} muvaffaqiyatsiz tugadi
                {job.finished_at && ` (${formatDateTime(job.finished_at)})`}.
              </p>
              {job.error && <p className="mt-0.5 text-muted-foreground">{job.error}</p>}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={startAudit} disabled={isBusy}>
            Qayta tekshirish
          </Button>
        </div>
      )}

      {!audit.isLoading &&
        audit.state !== null &&
        report === null &&
        applyReport === null &&
        job?.status !== 'running' && (
          <Card>
            <EmptyState
              message={"Hali tekshiruv o'tkazilmagan. \"Tekshirishni boshlash\" tugmasini bosing."}
            />
          </Card>
        )}

      {applyReport !== null && (
        <Tabs<View>
          ariaLabel="Natija turi"
          value={activeView}
          onValueChange={setView}
          options={[
            { value: 'audit', label: 'Solishtirish' },
            { value: 'apply', label: 'Oxirgi yangilash natijasi' },
          ]}
        />
      )}

      {activeView === 'audit' && report !== null && (
        <AuditView
          report={report}
          canApply={canApply}
          isBusy={isBusy}
          selected={selected}
          onSelectedChange={setSelected}
          allPlanSize={planSize(allPlan)}
          onApplyAll={() => openApply(report.items)}
          onApplySelected={() =>
            openApply(report.items.filter((i) => selected.has(i.product_id)))
          }
        />
      )}

      {activeView === 'apply' && applyReport !== null && <ApplyView report={applyReport} />}

      {canApply && report !== null && (
        <RecipeAuditApplyDialog
          open={applyPlan !== null}
          onOpenChange={(open) => {
            if (!open) setApplyPlan(null);
          }}
          plan={applyPlan ?? { differs: [], lockedMatch: [], stageResets: [] }}
          generatedAt={report.generated_at}
          isStale={isReportStale(report)}
          onConfirm={(include) => void confirmApply(include)}
          isSubmitting={isStarting}
          error={applyError}
        />
      )}

      {canApply && (
        <RecipeAuditRestoreDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          appliedCount={appliedCount}
          onConfirm={() => void confirmRestore()}
          isSubmitting={isStarting}
          error={restoreError}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Latest dry-run report
// -----------------------------------------------------------------------------

function AuditView({
  report,
  canApply,
  isBusy,
  selected,
  onSelectedChange,
  allPlanSize,
  onApplyAll,
  onApplySelected,
}: {
  report: RecipeAuditReport;
  canApply: boolean;
  isBusy: boolean;
  selected: ReadonlySet<number>;
  onSelectedChange: (next: ReadonlySet<number>) => void;
  allPlanSize: number;
  onApplyAll: () => void;
  onApplySelected: () => void;
}) {
  const { summary } = report;
  return (
    <section aria-label="Solishtirish natijasi" className="space-y-6">
      <SummaryStrip
        tiles={[
          { label: 'Jami', value: summary.total, tone: 'text-foreground' },
          { label: 'Mos', value: summary.match, tone: 'text-success' },
          { label: 'Farqli', value: summary.differs, tone: 'text-warning' },
          { label: 'Qulflangan', value: summary.locked, tone: 'text-violet-600 dark:text-violet-400' },
          { label: "Bosqichlari yo'qoladi", value: summary.stages_will_reset, tone: 'text-warning' },
          { label: "Poster'da yo'q", value: summary.poster_missing, tone: 'text-muted-foreground' },
          { label: 'Poster xatosi', value: summary.poster_error, tone: 'text-destructive' },
          { label: 'Topilmagan komponent', value: summary.unresolved, tone: 'text-destructive' },
        ]}
      />

      <ReportWarnings warnings={report.warnings} />

      <FilteredTable
        items={report.items}
        filters={AUDIT_FILTERS}
        sortKey={(i) => STATUS_ORDER[i.status]}
        showApplyResult={false}
        selection={
          canApply
            ? { selected, onChange: onSelectedChange, isSelectable: isApplyTarget }
            : null
        }
        toolbar={
          canApply && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
              {selected.size > 0 && (
                <Button variant="outline" onClick={onApplySelected} disabled={isBusy}>
                  <ListChecks className="size-4" aria-hidden="true" />
                  Tanlanganlarni yangilash ({selected.size})
                </Button>
              )}
              <Button onClick={onApplyAll} disabled={isBusy || allPlanSize === 0}>
                <CloudDownload className="size-4" aria-hidden="true" />
                Farqlilarni Poster'dan yangilash (qulflarni ochib)
              </Button>
            </div>
          )
        }
      />

      <p className="text-xs text-muted-foreground">
        Oxirgi tekshiruv: {formatDateTime(report.generated_at)}
      </p>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Last bulk-apply outcome
// -----------------------------------------------------------------------------

function ApplyView({ report }: { report: RecipeAuditReport }) {
  const targeted = report.items.filter((i) => i.apply_result !== undefined);
  const items = targeted.length > 0 ? targeted : report.items;
  const outsideScope = report.skipped_outside_scope ?? [];
  const counts = applyCounts(report);

  // Reasons for not applying, grouped, most frequent first — the list to act
  // on. Out-of-scope ids have no row but count as skipped, so they are included.
  const reasons = (() => {
    const byReason = new Map<string, number>();
    const add = (reason: string | undefined) => {
      const key = reason ?? "Sabab ko'rsatilmagan";
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    };
    for (const i of items) if (notApplied(i)) add(i.apply_message);
    for (const o of outsideScope) add(o.apply_message);
    return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  })();

  // Summary counts come from `summary`, so they show even without items.
  const tiles: Array<{ label: string; value: number | undefined; tone: string }> = [];
  const isRestore = (counts.restored ?? 0) > 0;
  // A restore report: "Yangilandi 0" next to "Tiklandi N" would only confuse.
  if (!isRestore || (counts.applied ?? 0) > 0) {
    tiles.push({ label: 'Yangilandi', value: counts.applied, tone: 'text-success' });
  }
  if (counts.skipped !== undefined) {
    tiles.push({ label: 'Yangilanmadi', value: counts.skipped, tone: 'text-warning' });
  }
  if (isRestore) tiles.push({ label: 'Tiklandi', value: counts.restored, tone: 'text-info' });

  return (
    <section aria-label="Oxirgi ommaviy yangilash natijasi" className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Oxirgi ommaviy yangilash: {formatDateTime(report.generated_at)}. Bu natija keyingi
        tekshiruvlardan alohida saqlanadi.
      </p>

      <SummaryStrip tiles={tiles} />

      <ReportWarnings warnings={report.warnings} />

      {outsideScope.length > 0 && (
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">
            Doiradan tashqari ({formatPlainNumber(outsideScope.length)} ta)
          </h2>
          <ul className="space-y-1 text-sm">
            {outsideScope.map((o) => (
              <li key={o.product_id}>
                Doiradan tashqari: #{o.product_id} — {o.apply_message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {reasons.length > 0 && (
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">Yangilanmaganlar sabablari</h2>
          <ul className="space-y-1 text-sm">
            {reasons.map(([reason, count]) => (
              <li key={reason} className="flex items-start justify-between gap-3">
                <span>{reason}</span>
                <span className="shrink-0 font-medium tabular-nums">{count} ta</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <FilteredTable
        items={items}
        filters={APPLY_FILTERS}
        sortKey={(i) => (notApplied(i) ? 0 : i.apply_result === 'restored' ? 1 : 2)}
        showApplyResult
        selection={null}
        toolbar={null}
        emptyMessage="Mahsulotlar bo'yicha batafsil ro'yxat yo'q — yuqoridagi umumiy sonlarga qarang."
      />
    </section>
  );
}

/** Report-level notes (e.g. the final audit of a job did not run). */
function ReportWarnings({ warnings }: { warnings: readonly string[] | undefined }) {
  if (warnings === undefined || warnings.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <ul className="space-y-1">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Shared pieces
// -----------------------------------------------------------------------------

function FilteredTable({
  items,
  filters,
  sortKey,
  showApplyResult,
  selection,
  toolbar,
  emptyMessage = "Hisobotda mahsulotlar ro'yxati yo'q.",
}: {
  items: readonly RecipeAuditItem[];
  filters: readonly Filter[];
  sortKey: (i: RecipeAuditItem) => number;
  showApplyResult: boolean;
  selection: {
    selected: ReadonlySet<number>;
    onChange: (next: ReadonlySet<number>) => void;
    isSelectable: (i: RecipeAuditItem) => boolean;
  } | null;
  toolbar: ReactNode;
  /** Shown instead of filters + table when the report has no items at all. */
  emptyMessage?: string;
}) {
  const [filterKey, setFilterKey] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const visible = useMemo(() => {
    const matchesFilter = filters.find((f) => f.key === filterKey)?.test ?? (() => true);
    const query = search.trim();
    return items
      .filter(matchesFilter)
      .filter((i) => query === '' || matchesSearch(`${i.product_name} ${i.poster_name ?? ''}`, query))
      .sort((a, b) => sortKey(a) - sortKey(b) || a.product_name.localeCompare(b.product_name));
  }, [items, filters, filterKey, search, sortKey]);

  const selectableVisible = selection ? visible.filter(selection.isSelectable) : [];
  const allVisibleSelected =
    selection !== null &&
    selectableVisible.length > 0 &&
    selectableVisible.every((i) => selection.selected.has(i.product_id));

  function setMany(ids: readonly number[], on: boolean) {
    if (selection === null) return;
    const next = new Set(selection.selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    selection.onChange(next);
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const columnCount = 4 + (selection ? 1 : 0) + (showApplyResult ? 1 : 0);

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState message={emptyMessage} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => {
            const isActive = filterKey === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={isActive}
                onClick={() => setFilterKey(f.key)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground',
                )}
              >
                {f.label}{' '}
                <span
                  className={cn(
                    'min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums',
                    isActive ? 'bg-white/20' : 'bg-muted',
                  )}
                >
                  {items.filter(f.test).length}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative w-full lg:w-72">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mahsulot nomi…"
            aria-label="Mahsulot nomi bo'yicha qidirish"
            className="pl-8"
          />
        </div>
      </div>

      {toolbar}

      <Card>
        {visible.length === 0 ? (
          <EmptyState message="Tanlangan filtr bo'yicha mahsulot topilmadi." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {selection && (
                  <TableHead className="w-10">
                    {selectableVisible.length > 0 && (
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer rounded accent-primary"
                        checked={allVisibleSelected}
                        onChange={(e) =>
                          setMany(selectableVisible.map((i) => i.product_id), e.target.checked)
                        }
                        aria-label="Ko'rinayotgan yangilanadigan retseptlarni tanlash"
                      />
                    )}
                  </TableHead>
                )}
                <TableHead>Mahsulot</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Qulf</TableHead>
                <TableHead>Komponentlar</TableHead>
                {showApplyResult && <TableHead>Yangilash natijasi</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <RecipeAuditRow
                  key={item.product_id}
                  item={item}
                  expanded={expanded.has(item.product_id)}
                  onToggle={() => toggleExpanded(item.product_id)}
                  showSelect={selection !== null}
                  selectable={selection?.isSelectable(item) ?? false}
                  selected={selection?.selected.has(item.product_id) ?? false}
                  onSelectedChange={(on) => setMany([item.product_id], on)}
                  showApplyResult={showApplyResult}
                  columnCount={columnCount}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/**
 * An apply job's total grows while it runs (pre-audit + targets + final
 * audit), so nothing here assumes a fixed total, and the bar never passes 100%.
 */
function JobProgress({ job }: { job: RecipeAuditJob }) {
  const total = Math.max(0, job.progress.total);
  const done = Math.min(Math.max(0, job.progress.done), total);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const label = JOB_LABEL[job.kind].running;
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
          {label}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatPlainNumber(done)} / {formatPlainNumber(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
      </div>
    </Card>
  );
}

function SummaryStrip({
  tiles,
}: {
  tiles: ReadonlyArray<{ label: string; value: number | undefined; tone: string }>;
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-3">
          <dt className="text-xs font-medium text-muted-foreground">{t.label}</dt>
          <dd className={cn('mt-1 text-2xl font-semibold tabular-nums', t.tone)}>
            {formatPlainNumber(t.value ?? Number.NaN)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
