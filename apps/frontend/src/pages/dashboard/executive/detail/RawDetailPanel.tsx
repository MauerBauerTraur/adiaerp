import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ErrorState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { dateRangeToQuery, type DateRangeValue } from '@/components/DateRangeFilter';
import { formatQty, formatRelative } from '@/lib/format';
import type { DashboardRawDetail } from '@/lib/types';
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

/**
 * Sprint C — Raw Warehouse (mahsulot ombori) detail panel.
 *
 * 4 sub-KPI tiles, a 7-day received-vs-issued stacked area chart, a
 * below-min list and a pending purchase orders list. Cyan tone.
 */
export function RawDetailPanel({ range }: { range: DateRangeValue }) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } = useApiQuery<DashboardRawDetail>(
    `/api/dashboard/raw?${query}`,
  );

  if (isLoading && data === null) return <PanelSkeleton />;
  if (error && data === null)
    return <ErrorState message={error} onRetry={refetch} />;
  if (data === null) return null;

  return <RawDetailPanelView data={data} />;
}

export function RawDetailPanelView({ data }: { data: DashboardRawDetail }) {
  const chartData = useMemo(
    () =>
      data.daily_movements.map((p) => ({
        date: p.date,
        received: p.received,
        issued: p.issued,
        label: shortDate(p.date),
      })),
    [data.daily_movements],
  );

  const totalQtyLabel = useMemo(() => {
    if (data.kpis.total_stock_by_unit.length === 0) return '0';
    return data.kpis.total_stock_by_unit
      .map((row) => `${formatQty(row.qty)} ${row.unit}`)
      .join(' · ');
  }, [data.kpis.total_stock_by_unit]);

  return (
    <div className="flex flex-col gap-5" data-testid="raw-detail-panel">
      <SubKpiGrid
        tone="raw"
        tiles={[
          {
            label: 'Xom-ashyo turlari',
            value: formatQty(data.kpis.raw_product_types),
          },
          {
            label: 'Umumiy ostatka',
            value: totalQtyLabel,
          },
          {
            label: "Min'dan past",
            value: formatQty(data.kpis.below_min_count),
            tone: data.kpis.below_min_count > 0 ? 'danger' : 'default',
          },
          {
            label: "Ochiq PO",
            value: formatQty(data.kpis.open_purchase_orders),
            tone: data.kpis.open_purchase_orders > 0 ? 'warn' : 'default',
          },
        ]}
      />

      <PanelSection
        title="7 kun — kirim/chiqim"
        description="Xom-ashyo qabul va chiqim oqimi."
      >
        <div
          className="h-44 w-full rounded-md border border-border/40 bg-surface-2/30 p-2"
          data-testid="raw-detail-chart"
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
                  <linearGradient id="raw-received" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--chain-raw))"
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--chain-raw))"
                      stopOpacity={0.03}
                    />
                  </linearGradient>
                  <linearGradient id="raw-issued" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--chain-supply))"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--chain-supply))"
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
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  tickFormatter={(v: number) => formatQty(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, k: string) => [
                    formatQty(v),
                    k === 'received' ? 'Qabul' : 'Chiqim',
                  ]}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  formatter={(v) => (v === 'received' ? 'Qabul' : 'Chiqim')}
                />
                <Area
                  type="monotone"
                  dataKey="received"
                  stroke="hsl(var(--chain-raw))"
                  strokeWidth={2}
                  fill="url(#raw-received)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="issued"
                  stroke="hsl(var(--chain-supply))"
                  strokeWidth={2}
                  fill="url(#raw-issued)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Min'dan past mahsulotlar"
        description="Tezkor sotib olish kerak bo'lganlar."
      >
        {data.below_min_items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Min'dan past mahsulot yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.below_min_items.slice(0, 10).map((item) => (
              <li
                key={`${item.product_id}-${item.location_id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {item.product_name}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {item.location_name}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 tabular-nums">
                  <span className="text-destructive">
                    {formatQty(item.qty)} {item.unit}
                  </span>
                  <span className="text-muted-foreground">
                    min: {formatQty(item.min_level)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Yo'lda kelayotgan sotib olishlar"
        description="Tasdiqlangan PO — qabul kutilmoqda."
      >
        {data.pending_purchase_orders.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Ochiq PO yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.pending_purchase_orders.slice(0, 6).map((po) => (
              <li
                key={po.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {po.product_name}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {formatRelative(po.created_at)}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-foreground">
                  {formatQty(po.qty)}
                </span>
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
