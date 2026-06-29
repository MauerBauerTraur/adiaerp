import { Wallet, CreditCard, Smartphone, Zap } from 'lucide-react';
import type { ComponentType } from 'react';
import type { DateRangePreset } from '@/components/DateRangeFilter';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber } from '@/lib/format';
import { revenueTitleForRange } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { DashboardRevenueBreakdown } from '@/lib/types';

/**
 * F4.14 — "BUGUNGI TUSHUM" breakdown widget.
 *
 * Hits `GET /api/dashboard/revenue-breakdown?date=YYYY-MM-DD` and renders
 * the day's total revenue plus chips for each payment method (cash, card,
 * payme, click — and an "other" bucket when present). The widget is
 * tolerant of a missing endpoint: when the call returns 404, it falls
 * back to showing the `fallbackTotal` (Poster `sales_today_sum`) and a
 * subtle inline note instead of an error state.
 */
export interface RevenueBreakdownProps {
  /** Used as the `?date=` query param; ISO `YYYY-MM-DD`. */
  isoDate: string;
  /**
   * Total revenue surfaced by the existing Poster status block — used as
   * the fallback when the breakdown endpoint is unavailable so the user
   * still sees an answer to "bugun qancha tushdi".
   */
  fallbackTotal?: number;
  /**
   * Active period filter. Drives the headline copy ("Bugungi tushum" /
   * "Bu haftalik tushum" / …) so the title tracks the selected range
   * instead of staying frozen on "Bugungi tushum" (EPIC 0.4). The data
   * fetch is still day-scoped via `isoDate` — only the wording follows
   * the range until the backend exposes a ranged breakdown endpoint.
   */
  range?: DateRangePreset;
  className?: string;
}

interface ChipDef {
  key: keyof DashboardRevenueBreakdown['byMethod'];
  label: string;
  Icon: ComponentType<{ className?: string }>;
  // Direct Tailwind classes for tone — kept inline so we don't depend
  // on the chain-token palette (this widget is payment-method coded,
  // not chain-coded).
  toneClass: string;
}

const CHIPS: ChipDef[] = [
  {
    key: 'cash',
    label: 'Naqd',
    Icon: Wallet,
    toneClass: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  },
  {
    key: 'card',
    label: 'Karta',
    Icon: CreditCard,
    toneClass: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
  },
  {
    key: 'payme',
    label: 'Payme',
    Icon: Smartphone,
    toneClass: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
  },
  {
    key: 'click',
    label: 'Click',
    Icon: Zap,
    toneClass: 'text-violet-400 border-violet-500/30 bg-violet-500/10',
  },
];

// `formatSum` is the shared uz-UZ grouped-integer formatter (NaN-guarded);
// kept as a local alias so the JSX below reads in terms of "sum".
const formatSum = formatPlainNumber;

// Zero-revenue fallback: a successful but empty response (or a quiet
// zero-revenue day) renders all-zero chips rather than a perpetual
// "yuklanmoqda…" note.
const EMPTY_BY_METHOD: DashboardRevenueBreakdown['byMethod'] = {
  cash: 0,
  card: 0,
  payme: 0,
  click: 0,
};

function formatPct(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(part)) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export function RevenueBreakdown({
  isoDate,
  fallbackTotal,
  range,
  className,
}: RevenueBreakdownProps) {
  const title = revenueTitleForRange(range);
  const { data, isLoading, error } = useApiQuery<DashboardRevenueBreakdown>(
    `/api/dashboard/revenue-breakdown?date=${isoDate}`,
  );

  // Graceful degradation: when the endpoint isn't wired yet (or any
  // other error), still render the total from the Poster status feed
  // so the boshliq doesn't lose the headline number.
  const isMissing = error !== null;
  const total = data?.total ?? fallbackTotal ?? 0;
  const byMethod = data?.byMethod ?? null;
  // The breakdown note (below the total) only renders while genuinely
  // loading or when the endpoint is missing. A SUCCESSFUL response —
  // even one with zero revenue and an absent `byMethod` — must NOT keep
  // the "yuklanmoqda…" spinner up forever (defect: stuck loading on a
  // zero-revenue day). In that loaded-but-empty case we fall through to
  // a real zero-state set of chips.
  const showLoadingNote = isLoading && data === null && !isMissing;
  // Render chips whenever we have a breakdown, OR when the request has
  // resolved without an error (loaded-but-empty → all-zero chips). This
  // resolves the headline + a proper empty state instead of an infinite
  // spinner.
  const chips = byMethod ?? (!isLoading && !isMissing ? EMPTY_BY_METHOD : null);

  return (
    <Card
      data-testid="revenue-breakdown"
      className={cn('space-y-4 p-5 sm:p-6', className)}
      role="region"
      aria-label={`${title} brekdown`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p
            className="mt-1 text-3xl font-bold leading-none tabular-nums xl:text-4xl"
            data-testid="revenue-breakdown-total"
          >
            {formatSum(total)}
            <span className="ml-2 text-base font-normal text-muted-foreground">
              so&apos;m
            </span>
          </p>
        </div>
        {showLoadingNote && (
          <span
            className="text-xs text-muted-foreground"
            aria-live="polite"
          >
            Yuklanmoqda…
          </span>
        )}
      </header>

      {chips !== null ? (
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((chip) => {
            const value = chips[chip.key] ?? 0;
            return (
              <MethodChip
                key={chip.key}
                testId={`revenue-chip-${chip.key}`}
                label={chip.label}
                value={value}
                pct={formatPct(value, total)}
                Icon={chip.Icon}
                toneClass={chip.toneClass}
              />
            );
          })}
          {chips.other !== undefined && chips.other > 0 && (
            <MethodChip
              testId="revenue-chip-other"
              label="Boshqa"
              value={chips.other}
              pct={formatPct(chips.other, total)}
              Icon={Wallet}
              toneClass="text-slate-300 border-slate-500/30 bg-slate-500/10"
            />
          )}
        </div>
      ) : (
        <p
          className="rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          role="note"
        >
          {isMissing
            ? "Tushum brekdown ma'lumotlari tayyor emas."
            : 'Tushum brekdown yuklanmoqda…'}
        </p>
      )}
    </Card>
  );
}

interface MethodChipProps {
  testId: string;
  label: string;
  value: number;
  pct: string;
  Icon: ComponentType<{ className?: string }>;
  toneClass: string;
}

function MethodChip({
  testId,
  label,
  value,
  pct,
  Icon,
  toneClass,
}: MethodChipProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs',
        toneClass,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{label}</span>
      <span className="tabular-nums">{formatSum(value)}</span>
      <span className="text-[10px] opacity-70 tabular-nums">{pct}</span>
    </div>
  );
}
