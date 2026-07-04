import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

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
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

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

  function goTo(params: Record<string, string>) {
    const q = new URLSearchParams({ ...params, from: 'dashboard' });
    navigate(`/production-orders?${q.toString()}`);
  }

  return (
    <div className="flex flex-col gap-5" data-testid="production-detail-panel">
      <SubKpiGrid
        tone="production"
        tiles={[
          {
            label: 'Faol zayafkalar',
            value: formatQty(data.kpis.active_orders),
            onClick: () => goTo({ status: 'in_progress' }),
          },
          {
            label: 'Bugun bajarildi',
            value: formatQty(data.kpis.done_today),
            tone: 'success',
            onClick: () => goTo({ status: 'done', date_from: today, date_to: today }),
          },
          {
            label: "Muddat o'tgan",
            value: formatQty(data.kpis.overdue),
            tone: data.kpis.overdue > 0 ? 'danger' : 'default',
            onClick: data.kpis.overdue > 0 ? () => goTo({ overdue: '1' }) : undefined,
          },
          {
            label: 'Barcha zayafkalar',
            value: formatQty(data.kpis.active_orders + data.kpis.overdue),
            onClick: () => goTo({}),
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
        title="Sexlar — yuklamasi"
        description="Bosing — shu sexning barcha zayafkalari ochiladi."
      >
        {data.sex_load.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Sex yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.sex_load.map((load) => {
              const ratio = load.planned_qty > 0 ? load.open_orders / load.planned_qty : 0;
              const barColor = load.open_orders === 0 ? 'bg-muted/40' : ratio < 0.5 ? 'bg-emerald-500' : ratio < 1 ? 'bg-amber-400' : 'bg-destructive';
              const pct = Math.min(Math.round(ratio * 100), 100);

              return (
                <li key={load.location_id}>
                  <button
                    type="button"
                    onClick={() => goTo({ location_id: String(load.location_id) })}
                    className="w-full rounded-md border border-border/40 bg-surface-2/40 px-3 py-2.5 text-left transition-colors hover:bg-accent hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xs font-medium text-foreground">
                        {load.location_name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {load.open_orders} zayafka
                      </span>
                    </div>
                    {load.planned_qty > 0 && (
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/30">
                        <div
                          className={`h-full rounded-full transition-all ${barColor}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
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

