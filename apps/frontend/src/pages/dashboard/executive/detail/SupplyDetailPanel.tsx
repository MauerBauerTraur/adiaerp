import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
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
import type { DashboardSupplyDetail } from '@/lib/types';
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

/**
 * Sprint C — Supply (ta'minot bo'limi) detail panel.
 *
 * 4 sub-KPI tiles, received vs shipped line chart, top destination
 * locations and open request items. Emerald tone.
 */
export function SupplyDetailPanel({ range }: { range: DateRangeValue }) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardSupplyDetail>(`/api/dashboard/supply?${query}`);

  if (isLoading && data === null) return <PanelSkeleton />;
  if (error && data === null)
    return <ErrorState message={error} onRetry={refetch} />;
  if (data === null) return null;

  return <SupplyDetailPanelView data={data} />;
}

export function SupplyDetailPanelView({
  data,
}: {
  data: DashboardSupplyDetail;
}) {
  const chartData = useMemo(
    () =>
      data.daily_flow.map((p) => ({
        date: p.date,
        received: p.received,
        shipped: p.shipped,
        label: shortDate(p.date),
      })),
    [data.daily_flow],
  );

  return (
    <div className="flex flex-col gap-5" data-testid="supply-detail-panel">
      <SubKpiGrid
        tone="supply"
        tiles={[
          {
            label: 'Joriy SKU',
            value: formatQty(data.kpis.current_stock_count),
          },
          {
            label: 'Bugun kirim',
            value: formatQty(data.kpis.received_today),
          },
          {
            label: "Bugun jo'natma",
            value: formatQty(data.kpis.shipped_today),
          },
          {
            label: "Ochiq so'rovlar",
            value: formatQty(data.kpis.open_requests),
            tone: data.kpis.open_requests > 0 ? 'warn' : 'default',
          },
        ]}
      />

      <PanelSection
        title="Kirim va chiqim — 7 kun"
        description="Sexlardan kirim vs do'konlarga chiqim."
      >
        <div
          className="h-44 w-full rounded-md border border-border/40 bg-surface-2/30 p-2"
          data-testid="supply-detail-chart"
        >
          {chartData.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Ma'lumot yo'q.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              >
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
                    k === 'received' ? 'Kirim' : 'Chiqim',
                  ]}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  formatter={(v) => (v === 'received' ? 'Kirim' : 'Chiqim')}
                />
                <Line
                  type="monotone"
                  dataKey="received"
                  stroke="hsl(var(--chain-production))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="shipped"
                  stroke="hsl(var(--chain-supply))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Bugungi top yo'nalishlar"
        description="Eng ko'p jo'natma olgan lokatsiyalar."
      >
        {data.top_destinations_today.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Bugun jo'natma yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.top_destinations_today.slice(0, 5).map((row) => (
              <li
                key={row.location_id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate font-medium text-foreground">
                  {row.location_name}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {formatQty(row.qty)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Kutilayotgan so'rovlar"
        description="Sex skladi tomonidan bajarilishi kerak."
      >
        {data.open_request_items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Ochiq so'rov yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.open_request_items.slice(0, 6).map((req) => (
              <li
                key={req.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {req.product_name}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    → {req.target_location_name}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 tabular-nums">
                  <span className="text-foreground">
                    {formatQty(req.qty_needed)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatRelative(req.created_at)}
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
