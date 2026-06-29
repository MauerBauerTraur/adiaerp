import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, TrendingUp } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import type { ForecastItem, ForecastsResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F3.4 — Dashboard forecasts widget (phase-3.md §2.4, ADR-0010).
 *
 * Lists up to 5 products whose 14-day Prophet forecast predicts a
 * stockout within the next 7 days, ranked by `expected_stockout_date`.
 * A "Hammasini ko'rish" link points at the full `/forecasts` page.
 *
 * Each row carries a tiny inline sparkline of `daily_predictions.yhat`
 * so the manager sees the demand curve at a glance. A "ESKI" badge
 * surfaces sidecar lag (`stale === true`).
 */
const TOP_LIMIT = 5;
const STOCKOUT_WINDOW_DAYS = 7;

export function ForecastsPanel({ className }: { className?: string }) {
  const { data, isLoading, error, refetch } = useApiQuery<ForecastsResponse>(
    '/api/forecasts',
  );

  const items = data?.items ?? [];
  const today = startOfToday();
  const horizon = addDays(today, STOCKOUT_WINDOW_DAYS);
  const imminent = items
    .filter((f) => {
      if (f.expected_stockout_date === null) return false;
      const due = parseDate(f.expected_stockout_date);
      return due !== null && due >= today && due <= horizon;
    })
    .sort((a, b) => {
      // Both stockout dates are non-null due to the filter above.
      const da = parseDate(a.expected_stockout_date!)!.getTime();
      const db = parseDate(b.expected_stockout_date!)!.getTime();
      return da - db;
    })
    .slice(0, TOP_LIMIT);

  const anyStale = items.some((f) => f.stale);

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <TrendingUp className="size-4 text-primary" aria-hidden="true" />
            Bashorat
          </h2>
          <p className="text-xs text-muted-foreground">
            Keyingi 14 kun — tugashga yaqin mahsulotlar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyStale && (
            <Badge variant="warning" className="gap-1">
              <AlertCircle className="size-3" aria-hidden="true" />
              Eski ma’lumot
            </Badge>
          )}
          <Link
            to="/forecasts"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Hammasini ko‘rish
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className="flex-1">
        {isLoading && data === null && <LoadingState />}
        {error && data === null && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {data !== null && imminent.length === 0 && (
          <EmptyState message="Yaqin 7 kun ichida tugaydigan mahsulot yo‘q." />
        )}
        {data !== null && imminent.length > 0 && (
          <ol
            className="divide-y divide-border/60"
            data-testid="forecasts-imminent"
          >
            {imminent.map((f) => (
              <ForecastRow
                key={`${f.location_id}-${f.product_id}`}
                forecast={f}
                today={today}
              />
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function ForecastRow({
  forecast,
  today,
}: {
  forecast: ForecastItem;
  today: Date;
}) {
  // `expected_stockout_date` is non-null here — the parent filtered.
  const due = parseDate(forecast.expected_stockout_date!)!;
  const daysLeft = Math.max(
    0,
    Math.round((due.getTime() - today.getTime()) / 86_400_000),
  );
  const urgent = daysLeft <= 2;

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">{forecast.product_name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {forecast.location_name}
        </p>
      </div>

      <div
        className="hidden h-10 w-24 shrink-0 sm:block"
        aria-hidden="true"
        data-testid="forecast-sparkline"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={forecast.daily_predictions}>
            <Line
              type="monotone"
              dataKey="yhat"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <Badge
        variant={urgent ? 'danger' : 'warning'}
        className="shrink-0 tabular-nums"
      >
        {daysLeft === 0 ? 'Bugun' : `${daysLeft} kun qoldi`}
      </Badge>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Date helpers — pure & timezone-safe for `YYYY-MM-DD` strings.
// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}
