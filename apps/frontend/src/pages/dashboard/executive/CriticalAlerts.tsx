import { useId } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  OctagonX,
  ShieldCheck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type {
  DashboardAlert,
  DashboardBelowMinItem,
} from '@/lib/types';
import { cn } from '@/lib/utils';

const TOP_LIMIT = 5;

type CriticalSeverity = 'out-of-stock' | 'deep' | 'alert-danger' | 'below-min' | 'alert-warning';

interface CriticalRow {
  key: string;
  title: string;
  sub: string;
  href: string;
  severity: CriticalSeverity;
}

const SEV_CONFIG: Record<CriticalSeverity, {
  bg: string;
  border: string;
  labelBg: string;
  labelText: string;
  Icon: typeof OctagonX;
  label: string;
}> = {
  'out-of-stock': {
    bg: 'bg-rose-500/5 dark:bg-rose-500/8',
    border: 'border-l-rose-500',
    labelBg: 'bg-rose-500/15',
    labelText: 'text-rose-700 dark:text-rose-400',
    Icon: OctagonX,
    label: 'Tugadi',
  },
  'deep': {
    bg: 'bg-orange-500/5 dark:bg-orange-500/8',
    border: 'border-l-orange-500',
    labelBg: 'bg-orange-500/15',
    labelText: 'text-orange-700 dark:text-orange-400',
    Icon: AlertOctagon,
    label: 'Tanqidiy',
  },
  'alert-danger': {
    bg: 'bg-rose-500/5 dark:bg-rose-500/8',
    border: 'border-l-rose-500',
    labelBg: 'bg-rose-500/15',
    labelText: 'text-rose-700 dark:text-rose-400',
    Icon: OctagonX,
    label: 'Xavf',
  },
  'below-min': {
    bg: 'bg-amber-500/5 dark:bg-amber-500/8',
    border: 'border-l-amber-400',
    labelBg: 'bg-amber-500/15',
    labelText: 'text-amber-700 dark:text-amber-400',
    Icon: AlertTriangle,
    label: "Min'dan past",
  },
  'alert-warning': {
    bg: 'bg-amber-500/5 dark:bg-amber-500/8',
    border: 'border-l-amber-400',
    labelBg: 'bg-amber-500/15',
    labelText: 'text-amber-700 dark:text-amber-400',
    Icon: AlertTriangle,
    label: 'Ogohlantirish',
  },
};

function buildRows(belowMin: DashboardBelowMinItem[], alerts: DashboardAlert[]): CriticalRow[] {
  const zero = belowMin.filter((b) => b.qty === 0);
  const deep = belowMin.filter((b) => b.qty > 0 && b.qty < (b.min_level ?? 0) * 0.5);
  const remaining = belowMin.filter((b) => !zero.includes(b) && !deep.includes(b));
  const danger = alerts.filter((a) => a.severity === 'danger');
  const warning = alerts.filter((a) => a.severity === 'warning');

  const rows: CriticalRow[] = [];
  for (const b of zero) rows.push(belowMinRow(b, 'out-of-stock'));
  for (const b of deep) rows.push(belowMinRow(b, 'deep'));
  for (const a of danger) rows.push({ key: `alert-${a.id}`, title: a.message, sub: a.location_name ?? '', href: '/replenishment', severity: 'alert-danger' });
  for (const b of remaining) rows.push(belowMinRow(b, 'below-min'));
  for (const a of warning) rows.push({ key: `alert-${a.id}`, title: a.message, sub: a.location_name ?? '', href: '/replenishment', severity: 'alert-warning' });
  return rows;
}

function belowMinRow(item: DashboardBelowMinItem, severity: CriticalSeverity): CriticalRow {
  const unit = UNIT_LABELS[item.product_unit];
  return {
    key: `below-${item.location_id}-${item.product_id}`,
    title: item.product_name,
    sub: `${item.location_name} · ${formatQty(item.qty)} ${unit} qolgan / min ${formatQty(item.min_level)}`,
    href: item.open_request_id !== null ? `/replenishment/${item.open_request_id}` : '/replenishment',
    severity,
  };
}

export function CriticalAlerts({
  belowMin,
  alerts,
  criticalCount,
  className,
}: {
  belowMin: DashboardBelowMinItem[];
  alerts: DashboardAlert[];
  criticalCount?: number;
  className?: string;
}) {
  const rows = buildRows(belowMin, alerts);
  const top = rows.slice(0, TOP_LIMIT);
  const displayCount = criticalCount ?? rows.length;
  const overflow = rows.length - top.length;
  const headingId = useId();
  const hasCritical = rows.length > 0;

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden',
        hasCritical && 'border-rose-500/30',
        className,
      )}
      data-testid="critical-alerts"
      role="region"
      aria-labelledby={headingId}
    >
      {/* Header — tinted when there are alerts */}
      <header
        className={cn(
          'flex items-center justify-between gap-3 border-b p-5',
          hasCritical
            ? 'border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-rose-500/5'
            : 'border-border/60 bg-gradient-to-br from-emerald-500/8 to-emerald-500/3',
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex size-9 items-center justify-center rounded-xl',
              hasCritical ? 'bg-rose-500/15' : 'bg-emerald-500/15',
            )}
          >
            {hasCritical ? (
              <AlertOctagon className="size-4 text-rose-600 dark:text-rose-400" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            )}
          </div>
          <div>
            <h2 id={headingId} className="text-sm font-bold leading-tight">
              Kritik signallar
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {hasCritical ? "Darhol e'tibor talab qiluvchi holatlar" : 'Barcha ko\'rsatkichlar me\'yorda'}
            </p>
          </div>
        </div>
        {displayCount > 0 && (
          <span className="inline-flex min-w-[2rem] items-center justify-center rounded-full bg-rose-500 px-2 py-0.5 text-xs font-bold tabular-nums text-white shadow-sm">
            {formatQty(displayCount)}
          </span>
        )}
      </header>

      {/* Content */}
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <CheckCircle2 className="size-10 text-emerald-500" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Hammasi me'yorda!</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Kritik stok muammolari yo'q.</p>
          </div>
        </div>
      ) : (
        <ol className="flex-1 divide-y divide-border/40">
          {top.map((row) => {
            const cfg = SEV_CONFIG[row.severity];
            const { Icon } = cfg;
            return (
              <li key={row.key}>
                <Link
                  to={row.href}
                  className={cn(
                    'group flex items-start gap-3 border-l-[3px] px-4 py-3 transition-colors',
                    cfg.border,
                    cfg.bg,
                    'hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  )}
                >
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', cfg.labelText)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-foreground group-hover:text-primary">
                      {row.title}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {row.sub}
                    </p>
                  </div>
                  <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold', cfg.labelBg, cfg.labelText)}>
                    {cfg.label}
                  </span>
                  <ArrowRight
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {overflow > 0 && (
        <footer className="border-t border-border/60 bg-rose-500/3 px-5 py-2.5 text-center">
          <Link to="/replenishment" className="text-xs font-semibold text-rose-600 hover:underline dark:text-rose-400">
            Yana {formatQty(overflow)} ta muammo →
          </Link>
        </footer>
      )}
    </Card>
  );
}
