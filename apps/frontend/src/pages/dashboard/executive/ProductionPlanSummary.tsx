import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, CheckCircle2, Factory } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { formatQty } from '@/lib/format';
import type {
  DashboardProductionPlanItem,
  ProductionOrderStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_PILL_ORDER: readonly ProductionOrderStatus[] = ['new', 'in_progress', 'done'] as const;

type StatusCfgEntry = { label: string; bg: string; text: string; barColor: string };
const STATUS_CFG: Record<ProductionOrderStatus, StatusCfgEntry> = {
  new: {
    label: 'Yangi',
    bg: 'bg-slate-500/12',
    text: 'text-slate-600 dark:text-slate-400',
    barColor: 'bg-slate-400',
  },
  in_progress: {
    label: 'Jarayonda',
    bg: 'bg-sky-500/12',
    text: 'text-sky-700 dark:text-sky-400',
    barColor: 'bg-sky-500',
  },
  done: {
    label: 'Bajarildi',
    bg: 'bg-emerald-500/12',
    text: 'text-emerald-700 dark:text-emerald-400',
    barColor: 'bg-emerald-500',
  },
  cancelled: {
    label: 'Bekor',
    bg: 'bg-muted/30',
    text: 'text-muted-foreground',
    barColor: 'bg-muted',
  },
};

export interface ProductionPlanSummaryProps {
  items: DashboardProductionPlanItem[];
  className?: string;
}

export function ProductionPlanSummary({ items, className }: ProductionPlanSummaryProps) {
  const counts = useMemo(() => {
    const acc: Record<ProductionOrderStatus, number> = { new: 0, in_progress: 0, done: 0, cancelled: 0 };
    for (const item of items) acc[item.status] += 1;
    return acc;
  }, [items]);

  const total = counts.new + counts.in_progress + counts.done;
  const donePct = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const inProgressPct = total > 0 ? Math.round((counts.in_progress / total) * 100) : 0;

  const upcoming = useMemo(
    () =>
      [...items]
        .filter((item) => item.status !== 'done' && item.status !== 'cancelled')
        .sort((a, b) => {
          if (a.deadline === b.deadline) return 0;
          if (a.deadline === null) return 1;
          if (b.deadline === null) return -1;
          return a.deadline < b.deadline ? -1 : 1;
        })
        .slice(0, 3),
    [items],
  );

  return (
    <Card className={cn('flex h-full flex-col overflow-hidden', className)}>
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-border/60 bg-gradient-to-br from-violet-500/8 to-violet-500/3 p-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-violet-500/15">
            <Factory className="size-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xs font-bold leading-tight text-violet-700 dark:text-violet-300">
              Ishlab chiqarish
            </h2>
            <p className="text-[10px] text-muted-foreground">Bugungi reja</p>
          </div>
        </div>
        <Link
          to="/production-orders"
          className="inline-flex items-center gap-1 rounded-lg bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-700 hover:bg-violet-500/20 dark:text-violet-400"
        >
          Reja
          <ArrowRight className="size-2.5" aria-hidden="true" />
        </Link>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState message="Bugungi reja bo'sh." />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          {/* Status count pills */}
          <div className="grid grid-cols-3 gap-1.5" data-testid="prod-summary-counts">
            {STATUS_PILL_ORDER.map((status) => {
              const cfg: StatusCfgEntry = STATUS_CFG[status];
              return (
                <div key={status} className={cn('flex flex-col items-center rounded-lg py-2', cfg.bg)}>
                  <span className={cn('text-lg font-extrabold tabular-nums leading-none', cfg.text)}>
                    {counts[status]}
                  </span>
                  <span className={cn('mt-0.5 text-[9px] font-semibold', cfg.text)}>
                    {cfg.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Progress bar */}
          {total > 0 && (
            <div className="space-y-1.5">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/40 gap-px">
                <div
                  className="bg-emerald-500 transition-all"
                  style={{ width: `${donePct}%` }}
                />
                <div
                  className="bg-sky-500 transition-all"
                  style={{ width: `${inProgressPct}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-[10px] tabular-nums text-muted-foreground">
                  {counts.done}/{total} bajarildi
                </p>
                <div className="flex items-center gap-1">
                  {counts.done === total && total > 0 ? (
                    <CheckCircle2 className="size-3 text-emerald-500" />
                  ) : null}
                  <span className="text-[10px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {donePct}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Upcoming items */}
          {upcoming.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Keyingi muddatlar
              </p>
              <ul className="space-y-1">
                {upcoming.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/30 bg-muted/20 px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate text-[11px] font-semibold">
                      {item.product_name}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="tabular-nums">{formatQty(item.qty)}</span>
                      {item.deadline !== null && (
                        <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-400">
                          <CalendarClock className="size-2.5" aria-hidden="true" />
                          {item.deadline}
                        </span>
                      )}
                      {item.deadline === null && (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

