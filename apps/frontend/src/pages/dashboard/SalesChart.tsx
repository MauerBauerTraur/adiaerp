import { useMemo, useState } from 'react';
import { LineChart as LineChartIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { formatQty } from '@/lib/format';
import type { DashboardSalesPoint } from '@/lib/types';
import { cn } from '@/lib/utils';

type Metric = 'revenue' | 'receipts' | 'qty';

const METRIC_LABELS: Record<Metric, string> = {
  revenue: 'Tushum',
  receipts: 'Cheklar',
  qty: 'Miqdor',
};

const RANGE_LABELS: Record<string, string> = {
  today: 'Bugun',
  week: 'Bu hafta',
  month: 'Bu oy',
  '6m': '6 oy',
};

function formatRevenue(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} mlrd`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} mln`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

function formatMetricValue(metric: Metric, value: number): string {
  if (metric === 'revenue') return formatRevenue(value);
  return formatQty(value);
}

export function SalesChart({
  points,
  rangePreset,
  className,
}: {
  points: DashboardSalesPoint[];
  rangePreset?: string;
  className?: string;
}) {
  const [metric, setMetric] = useState<Metric>('revenue');

  const data = useMemo(
    () =>
      points.map((p) => ({
        date: p.date,
        label: shortDate(p.date),
        revenue: p.revenue,
        receipts: p.receipts,
        qty: p.qty,
      })),
    [points],
  );

  const totals = useMemo(
    () => ({
      revenue: points.reduce((a, p) => a + p.revenue, 0),
      receipts: points.reduce((a, p) => a + p.receipts, 0),
      qty: points.reduce((a, p) => a + p.qty, 0),
    }),
    [points],
  );

  const rangeLabel = (rangePreset && RANGE_LABELS[rangePreset]) ?? 'Sotuv';

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <LineChartIcon className="size-4 text-primary" aria-hidden="true" />
            {rangeLabel} savdolari
          </h2>
          <p className="text-xs text-muted-foreground">Posterdan sinxronlangan ma'lumotlar</p>
        </div>
        {/* Metric selector */}
        <div className="flex overflow-hidden rounded-lg border border-border text-xs font-medium">
          {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                metric === m
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      </header>

      {/* Summary stat cards */}
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border/60">
        {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMetric(m)}
            className={cn(
              'flex flex-col items-center gap-0.5 px-4 py-3 text-center transition-colors',
              metric === m ? 'bg-primary/5' : 'hover:bg-muted/50',
            )}
          >
            <span className="text-xs text-muted-foreground">{METRIC_LABELS[m]}</span>
            <span
              className={cn(
                'text-base font-semibold tabular-nums leading-none',
                metric === m && 'text-primary',
              )}
            >
              {formatMetricValue(m, totals[m])}
            </span>
            {m === 'revenue' && (
              <span className="text-[10px] text-muted-foreground">so'm</span>
            )}
          </button>
        ))}
      </div>

      <div className="p-5">
        {data.length === 0 ? (
          <EmptyState message="Sotuv ma'lumotlari yo'q." />
        ) : (
          <div className="h-48 w-full" aria-label="Sotuv grafigi">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="hsl(var(--border))"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(v: number) => formatMetricValue(metric, v)}
                />
                <Tooltip
                  cursor={{ stroke: 'hsl(var(--primary))', strokeOpacity: 0.4 }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '0.5rem',
                    fontSize: '0.75rem',
                    color: 'hsl(var(--popover-foreground))',
                  }}
                  formatter={(value: number) => [
                    metric === 'revenue'
                      ? `${value.toLocaleString('uz-UZ')} so'm`
                      : formatQty(value),
                    METRIC_LABELS[metric],
                  ]}
                  labelFormatter={(label: string) => label}
                />
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#sales-fill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}

function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  const [, , m, d] = match;
  return `${d}.${m}`;
}
