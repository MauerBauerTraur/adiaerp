import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ClipboardList,
  Receipt,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type {
  DateRangePreset,
  DateRangeValue,
} from '@/components/DateRangeFilter';
import { formatPlainNumber, formatQty } from '@/lib/format';
import {
  COMPARISON_LABEL_BY_RANGE,
  RECEIPTS_TITLE_BY_RANGE,
  REVENUE_TITLE_BY_RANGE,
} from '@/lib/labels';
import type { DashboardEcosystem, DashboardOverview } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface HeroStripProps {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
  range?: DateRangeValue;
  onNavigate?: (href: string) => void;
  className?: string;
}

interface RangeCopy {
  revenueTitle: string;
  receiptsTitle: string;
  comparisonLabel: string;
}

function rangeCopy(preset: DateRangePreset): RangeCopy {
  return {
    revenueTitle: REVENUE_TITLE_BY_RANGE[preset],
    receiptsTitle: RECEIPTS_TITLE_BY_RANGE[preset],
    comparisonLabel: COMPARISON_LABEL_BY_RANGE[preset],
  };
}

type Tone = 'emerald' | 'sky' | 'amber' | 'rose';

interface HeroKpi {
  testId: string;
  label: string;
  value: string;
  caption?: string;
  tone: Tone;
  Icon: ComponentType<{ className?: string }>;
  href?: string;
  detailHint?: string;
  direction: 'up-good' | 'down-good';
  deltaPct: number | null;
  prevLabel?: string;
  subStats?: Array<{ label: string; value: string }>;
}

const CARD_THEME: Record<Tone, {
  bg: string;
  iconBg: string;
  iconColor: string;
  valueColor: string;
  badgeBg: string;
  badgeText: string;
  border: string;
}> = {
  emerald: {
    bg: 'bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 dark:from-emerald-500/15 dark:to-emerald-500/5',
    iconBg: 'bg-emerald-500/15',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    valueColor: 'text-emerald-700 dark:text-emerald-300',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-700 dark:text-emerald-400',
    border: 'border-emerald-500/20',
  },
  sky: {
    bg: 'bg-gradient-to-br from-sky-500/10 to-sky-500/5 dark:from-sky-500/15 dark:to-sky-500/5',
    iconBg: 'bg-sky-500/15',
    iconColor: 'text-sky-600 dark:text-sky-400',
    valueColor: 'text-sky-700 dark:text-sky-300',
    badgeBg: 'bg-sky-500/10',
    badgeText: 'text-sky-700 dark:text-sky-400',
    border: 'border-sky-500/20',
  },
  amber: {
    bg: 'bg-gradient-to-br from-amber-500/10 to-amber-500/5 dark:from-amber-500/15 dark:to-amber-500/5',
    iconBg: 'bg-amber-500/15',
    iconColor: 'text-amber-600 dark:text-amber-400',
    valueColor: 'text-amber-700 dark:text-amber-300',
    badgeBg: 'bg-amber-500/10',
    badgeText: 'text-amber-700 dark:text-amber-400',
    border: 'border-amber-500/20',
  },
  rose: {
    bg: 'bg-gradient-to-br from-rose-500/10 to-rose-500/5 dark:from-rose-500/15 dark:to-rose-500/5',
    iconBg: 'bg-rose-500/15',
    iconColor: 'text-rose-600 dark:text-rose-400',
    valueColor: 'text-rose-700 dark:text-rose-300',
    badgeBg: 'bg-rose-500/10',
    badgeText: 'text-rose-700 dark:text-rose-400',
    border: 'border-rose-500/20',
  },
};

const formatFullNumber = formatPlainNumber;

function computeDeltaPct(today: number, prev: number): number | null {
  if (prev > 0) return ((today - prev) / prev) * 100;
  if (today > 0) return 100;
  return 0;
}

export function HeroStrip({
  overview,
  ecosystem,
  range,
  onNavigate,
  className,
}: HeroStripProps) {
  const copy = rangeCopy(range?.range ?? 'today');
  const salesToday = ecosystem?.poster_status.sales_today_sum ?? 0;
  const receiptsToday = ecosystem?.poster_status.sales_today_count ?? 0;
  const activeRequests =
    overview.kpis.active_production_orders +
    overview.kpis.total_open_requests +
    overview.kpis.pending_approvals;
  const belowMin = overview.kpis.below_min_count;

  const days = ecosystem?.sales_chart.days ?? [];
  const todayQty = days.length > 0 ? (days[days.length - 1]?.qty ?? 0) : 0;
  const yesterdayQty = days.length > 1 ? (days[days.length - 2]?.qty ?? 0) : 0;
  const revenueDelta = computeDeltaPct(todayQty, yesterdayQty);

  const kpis: HeroKpi[] = [
    {
      testId: 'hero-strip-revenue',
      tone: 'emerald',
      label: copy.revenueTitle,
      value: formatFullNumber(salesToday),
      caption: "so'm",
      Icon: Wallet,
      direction: 'up-good',
      deltaPct: revenueDelta,
      prevLabel: copy.comparisonLabel,
      href: '/dashboard/operations',
      detailHint: 'Sotuv tafsilotlari',
      subStats: [
        { label: 'Kecha', value: formatFullNumber(yesterdayQty > 0 ? yesterdayQty : 0) },
      ],
    },
    {
      testId: 'hero-strip-receipts',
      tone: 'sky',
      label: copy.receiptsTitle,
      value: formatFullNumber(receiptsToday),
      caption: 'cheklar',
      Icon: Receipt,
      direction: 'up-good',
      deltaPct: revenueDelta,
      prevLabel: copy.comparisonLabel,
      href: '/cashier/receipts',
      detailHint: 'Cheklar',
    },
    {
      testId: 'hero-strip-requests',
      tone: 'amber',
      label: "Faol so'rovlar",
      value: formatQty(activeRequests),
      caption: 'vazifa',
      Icon: ClipboardList,
      direction: 'down-good',
      deltaPct: null,
      subStats: [
        { label: 'Ishlab chiqarish', value: formatQty(overview.kpis.active_production_orders) },
        { label: "So'rovlar", value: formatQty(overview.kpis.total_open_requests) },
        { label: 'Tasdiq kutmoqda', value: formatQty(overview.kpis.pending_approvals) },
      ],
      href: '/sorovnomalar',
      detailHint: "Barcha so'rovlar",
    },
    {
      testId: 'hero-strip-critical',
      tone: 'rose',
      label: 'Kritik qoldiq',
      value: formatQty(belowMin),
      caption: belowMin > 0 ? "min'dan past" : 'muammo yo\'q',
      Icon: belowMin > 0 ? AlertTriangle : TrendingUp,
      direction: 'down-good',
      deltaPct: null,
      href: '/stock-alerts',
      detailHint: belowMin > 0 ? 'Stok ogohlantirishlar' : "Qoldiqni ko'rish",
    },
  ];

  return (
    <div
      data-testid="hero-strip"
      className={cn(
        'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {kpis.map((kpi) => (
        <HeroKpiCard key={kpi.testId} kpi={kpi} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function HeroKpiCard({
  kpi,
  onNavigate,
}: {
  kpi: HeroKpi;
  onNavigate?: (href: string) => void;
}) {
  const { Icon } = kpi;
  const theme = CARD_THEME[kpi.tone];
  const isClickable = kpi.href !== undefined && onNavigate !== undefined;

  const body = (
    <div className="flex h-full flex-col gap-3">
      {/* Top row: icon badge + label */}
      <div className="flex items-center justify-between">
        <div className={cn('flex size-9 items-center justify-center rounded-xl', theme.iconBg)}>
          <Icon className={cn('size-4', theme.iconColor)} aria-hidden="true" />
        </div>
        {isClickable && (
          <span className={cn(
            'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            theme.badgeBg, theme.badgeText,
          )}>
            {kpi.detailHint}
            <ArrowRight className="size-2.5" />
          </span>
        )}
      </div>

      {/* Value block */}
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            className={cn('text-3xl font-extrabold leading-none tabular-nums xl:text-4xl', theme.valueColor)}
            data-testid={`${kpi.testId}-value`}
          >
            {kpi.value}
          </span>
          {kpi.caption !== undefined && (
            <span className="text-xs font-medium text-muted-foreground">{kpi.caption}</span>
          )}
        </div>

        {/* Delta pill */}
        <DeltaPill kpi={kpi} />

        {/* Sub-stats breakdown */}
        {kpi.subStats !== undefined && kpi.subStats.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/30 pt-2">
            {kpi.subStats.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1 text-[10px]">
                <span className={cn('font-bold tabular-nums', theme.valueColor)}>{s.value}</span>
                <span className="text-muted-foreground">{s.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Bottom: card label */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {kpi.label}
      </p>
    </div>
  );

  const surfaceClass = cn(
    'rounded-2xl border p-5 shadow-sm transition-all duration-200',
    theme.bg,
    theme.border,
    'min-h-[160px]',
  );

  if (isClickable) {
    return (
      <button
        type="button"
        data-testid={kpi.testId}
        data-tone={kpi.tone}
        aria-label={`${kpi.label} — batafsil`}
        onClick={() => onNavigate?.(kpi.href as string)}
        className={cn(
          surfaceClass,
          'w-full cursor-pointer text-left hover:scale-[1.02] hover:shadow-md',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      data-testid={kpi.testId}
      data-tone={kpi.tone}
      role="region"
      aria-label={kpi.label}
      className={surfaceClass}
    >
      {body}
    </div>
  );
}

function DeltaPill({ kpi }: { kpi: HeroKpi }) {
  if (kpi.deltaPct === null) return null;
  const pct = Math.round(kpi.deltaPct * 10) / 10;
  if (!Number.isFinite(pct) || pct === 0) {
    return (
      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid={`${kpi.testId}-delta`}>
        <ArrowRight className="size-3" aria-hidden="true" />
        kecha bilan teng
      </span>
    );
  }
  const positive = pct > 0;
  const isGood = kpi.direction === 'up-good' ? positive : !positive;
  const DeltaIcon = positive ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'mt-1 inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums',
        isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
      )}
      data-testid={`${kpi.testId}-delta`}
    >
      <DeltaIcon className="size-3" aria-hidden="true" />
      {positive ? '+' : ''}{pct.toFixed(1)}%
      {kpi.prevLabel !== undefined && (
        <span className="font-normal text-muted-foreground">{kpi.prevLabel}</span>
      )}
    </span>
  );
}
