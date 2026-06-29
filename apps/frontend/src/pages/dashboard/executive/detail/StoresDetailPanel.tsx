import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ErrorState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { dateRangeToQuery, type DateRangeValue } from '@/components/DateRangeFilter';
import { formatCurrencyCompact, formatQty } from '@/lib/format';
import type { DashboardStoresDetail } from '@/lib/types';
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

/**
 * Sprint C — Stores (do'konlar) detail panel.
 *
 * 4 sub-KPI, mini store grid, daily sales area chart, top sold
 * products list. Violet tone.
 */
export function StoresDetailPanel({ range }: { range: DateRangeValue }) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardStoresDetail>(`/api/dashboard/stores?${query}`);

  if (isLoading && data === null) return <PanelSkeleton />;
  if (error && data === null)
    return <ErrorState message={error} onRetry={refetch} />;
  if (data === null) return null;

  return <StoresDetailPanelView data={data} />;
}

export function StoresDetailPanelView({
  data,
}: {
  data: DashboardStoresDetail;
}) {
  const chartData = useMemo(
    () =>
      data.daily_sales.map((p) => ({
        date: p.date,
        revenue: p.revenue,
        label: shortDate(p.date),
      })),
    [data.daily_sales],
  );

  return (
    <div className="flex flex-col gap-5" data-testid="stores-detail-panel">
      <SubKpiGrid
        tone="store"
        tiles={[
          {
            label: 'Bugungi savdo',
            value: formatCurrencyCompact(data.kpis.sales_today_sum),
            caption: "so'm",
          },
          {
            label: 'Cheklar',
            value: formatQty(data.kpis.sales_today_count),
          },
          {
            label: "Do'konlar",
            value: formatQty(data.kpis.store_count),
          },
          {
            label: "O'rtacha chek",
            value: formatCurrencyCompact(data.kpis.avg_receipt_today),
            caption: "so'm",
          },
        ]}
      />

      <PanelSection
        title="Do'konlar — bugungi holat"
        description="Har do'konning savdo va ostatka holati."
      >
        {data.store_breakdown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Do'kon yo'q.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.store_breakdown.map((store) => (
              <div
                key={store.location_id}
                className="rounded-md border border-border/40 bg-surface-2/40 p-3"
              >
                <p className="truncate text-xs font-semibold text-foreground">
                  {store.location_name}
                </p>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-lg font-semibold tabular-nums text-chain-store">
                    {formatCurrencyCompact(store.sales_sum)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    so'm
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>{store.sales_count} chek</span>
                  <span
                    className={
                      store.below_min_count > 0
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {store.below_min_count} min'dan past
                  </span>
                  <span>{store.open_replenishments} so'rov</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="Kunlik savdo"
        description="Tanlangan oraliq bo'yicha umumiy daromad."
      >
        <div
          className="h-44 w-full rounded-md border border-border/40 bg-surface-2/30 p-2"
          data-testid="stores-detail-chart"
        >
          {chartData.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Ma'lumot yo'q.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="stores-area" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--chain-store))"
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--chain-store))"
                      stopOpacity={0.03}
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
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(v: number) => formatCurrencyCompact(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number) => [
                    `${formatCurrencyCompact(v)} so'm`,
                    'Savdo',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="hsl(var(--chain-store))"
                  strokeWidth={2}
                  fill="url(#stores-area)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Top sotilgan mahsulotlar"
        description="Bugun eng ko'p sotilgan 5 mahsulot."
      >
        {data.top_products_today.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Bugun savdo yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.top_products_today.slice(0, 5).map((row) => (
              <li
                key={row.product_id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate font-medium text-foreground">
                  {row.product_name}
                </span>
                <div className="flex shrink-0 items-center gap-3 tabular-nums">
                  <span className="text-muted-foreground">
                    {formatQty(row.qty)} {row.unit}
                  </span>
                  <span className="text-foreground">
                    {formatCurrencyCompact(row.revenue)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return iso;
  return `${m[3]}.${m[2]}`;
}
