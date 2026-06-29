import { useMemo } from 'react';
import {
  Bar,
  BarChart,
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
import type { DashboardProductionDetail } from '@/lib/types';
import {
  TrackerBar,
  type TrackerCellStatus,
  type TrackerRow,
} from '@/components/charts/TrackerBar';
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

type SexLoad = DashboardProductionDetail['sex_load'][number];

/**
 * Sprint C — Production (ishlab chiqarish) detail panel.
 *
 * 4 sub-KPI tiles, a 7-day input vs output bar chart, an active orders
 * list and a sex-workload tracker. Coral chain tone.
 */
export function ProductionDetailPanel({
  range,
}: {
  range: DateRangeValue;
}) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardProductionDetail>(
      `/api/dashboard/production?${query}`,
    );

  if (isLoading && data === null) return <PanelSkeleton />;
  if (error && data === null)
    return <ErrorState message={error} onRetry={refetch} />;
  if (data === null) return null;

  return <ProductionDetailPanelView data={data} />;
}

export function ProductionDetailPanelView({
  data,
}: {
  data: DashboardProductionDetail;
}) {
  const chartData = useMemo(
    () =>
      data.daily_io.map((p) => ({
        date: p.date,
        input: p.input,
        output: p.output,
        label: shortDate(p.date),
      })),
    [data.daily_io],
  );

  const trackerRows = useMemo<TrackerRow[]>(
    () => buildTrackerRows(data.sex_load),
    [data.sex_load],
  );

  return (
    <div className="flex flex-col gap-5" data-testid="production-detail-panel">
      <SubKpiGrid
        tone="production"
        tiles={[
          {
            label: 'Faol zayafkalar',
            value: formatQty(data.kpis.active_orders),
          },
          {
            label: 'Bugun bajarildi',
            value: formatQty(data.kpis.done_today),
            tone: 'success',
          },
          {
            label: "Muddat o'tgan",
            value: formatQty(data.kpis.overdue),
            tone: data.kpis.overdue > 0 ? 'danger' : 'default',
          },
          {
            label: 'Sex soni',
            value: formatQty(data.kpis.sex_count),
          },
        ]}
      />

      <PanelSection
        title="Kirim va chiqim — 7 kun"
        description="Sex kirimini (input) va chiqimini (output) solishtirish."
      >
        <div
          className="h-44 w-full rounded-md border border-border/40 bg-surface-2/30 p-2"
          data-testid="production-detail-chart"
        >
          {chartData.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Ma'lumot yo'q.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
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
                  formatter={(v: number, key: string) => [
                    formatQty(v),
                    key === 'input' ? 'Kirim' : 'Chiqim',
                  ]}
                />
                <Legend
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  iconSize={8}
                  formatter={(v) => (v === 'input' ? 'Kirim' : 'Chiqim')}
                />
                <Bar
                  dataKey="input"
                  fill="hsl(var(--chain-production))"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="output"
                  fill="hsl(var(--chain-supply))"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Faol zayafkalar"
        description="Top-5 davom etayotgan ishlab chiqarish."
      >
        {data.active_orders.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Faol zayafka yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.active_orders.slice(0, 5).map((order) => (
              <li
                key={order.id}
                className="rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {order.product_name}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {order.location_name}
                      {order.deadline
                        ? ` · ${formatRelative(order.deadline)}`
                        : ''}
                      {order.is_overdue ? ' · muddat o\'tgan' : ''}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-[11px] tabular-nums ${
                      order.is_overdue ? 'text-destructive' : 'text-foreground'
                    }`}
                  >
                    {formatQty(order.qty)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Sex yuklamasi"
        description="Har sexning ochiq zayafkalari va rejalashtirilgan hajmi."
      >
        {data.sex_load.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Sex yo'q.
          </p>
        ) : (
          <TrackerBar
            rows={trackerRows}
            columnLabels={['1', '2', '3', '4', '5', '6', '7']}
          />
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

/**
 * Build tracker rows from sex-load. Until per-day workload arrives from
 * the backend, encode a deterministic visual proxy: rows of seven cells
 * where intensity reflects `open_orders / planned_qty`.
 */
function buildTrackerRows(loads: SexLoad[]): TrackerRow[] {
  return loads.slice(0, 6).map((load) => {
    const ratio =
      load.planned_qty > 0 ? load.open_orders / load.planned_qty : 0;
    let status: TrackerCellStatus = 'empty';
    if (load.open_orders === 0) status = 'empty';
    else if (ratio < 0.5) status = 'ok';
    else if (ratio < 1) status = 'warn';
    else status = 'danger';
    return {
      label: load.location_name,
      caption: `${load.open_orders}/${formatQty(load.planned_qty)}`,
      days: Array.from({ length: 7 }, () => status),
    };
  });
}
