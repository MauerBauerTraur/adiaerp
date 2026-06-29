import { useMemo } from 'react';
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

/**
 * F4.4 — 30-day sales trend (phase-4.md §2.4).
 *
 * Renders an area chart with the day-level sold-quantity series. The
 * chart reads the same cobalt accent that drives `--primary`, with a
 * soft gradient fill to keep the premium dark aesthetic.
 */
export function SalesChart({
  points,
  className,
}: {
  points: DashboardSalesPoint[];
  className?: string;
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        date: p.date,
        qty: p.qty,
        label: shortDate(p.date),
      })),
    [points],
  );
  const total = useMemo(
    () => points.reduce((acc, p) => acc + p.qty, 0),
    [points],
  );

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <LineChartIcon
              className="size-4 text-primary"
              aria-hidden="true"
            />
            Sotuv — 30 kun
          </h2>
          <p className="text-xs text-muted-foreground">
            Oxirgi 30 kun davomida sotilgan miqdor.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Jami
          </p>
          <p className="text-lg font-semibold tabular-nums leading-none">
            {formatQty(total)}
          </p>
        </div>
      </header>

      <div className="p-5">
        {data.length === 0 ? (
          <EmptyState message="Sotuv ma’lumotlari yo‘q." />
        ) : (
          <div
            className="h-56 w-full"
            data-testid="sales-chart"
            aria-label="30 kunlik sotuv grafigi"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.02}
                    />
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
                  width={36}
                  tickFormatter={(value: number) => formatQty(value)}
                />
                <Tooltip
                  cursor={{
                    stroke: 'hsl(var(--primary))',
                    strokeOpacity: 0.4,
                  }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '0.5rem',
                    fontSize: '0.75rem',
                    color: 'hsl(var(--popover-foreground))',
                  }}
                  formatter={(value: number) => [formatQty(value), 'Soni']}
                  labelFormatter={(label: string) => label}
                />
                <Area
                  type="monotone"
                  dataKey="qty"
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
