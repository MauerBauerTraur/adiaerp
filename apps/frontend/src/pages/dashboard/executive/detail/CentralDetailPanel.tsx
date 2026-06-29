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
import { formatDateTime, formatQty, formatRelative } from '@/lib/format';
import { BlockBarList } from '@/components/charts/BlockBarList';
import type { DashboardCentralDetail } from '@/lib/types';
import { PanelSection, PanelSkeleton, SubKpiGrid } from './detailShared';

type SyncLogRow = DashboardCentralDetail['recent_sync_log'][number];

/**
 * Sprint C — Central warehouse (markaziy sklad) detail panel.
 *
 * 4 sub-KPI, top-10 block bar list, Poster sync log table, and a
 * stacked daily-sync-runs bar chart. Amber chain tone.
 */
export function CentralDetailPanel({ range }: { range: DateRangeValue }) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardCentralDetail>(`/api/dashboard/central?${query}`);

  if (isLoading && data === null) return <PanelSkeleton />;
  if (error && data === null)
    return <ErrorState message={error} onRetry={refetch} />;
  if (data === null) return null;

  return <CentralDetailPanelView data={data} />;
}

export function CentralDetailPanelView({
  data,
}: {
  data: DashboardCentralDetail;
}) {
  const blockItems = useMemo(
    () =>
      data.blocks.slice(0, 10).map((b) => ({
        id: b.location_id,
        label: b.location_name,
        value: b.total_qty,
        tone: 'central' as const,
      })),
    [data.blocks],
  );

  const blockTotal = useMemo(
    () => Math.max(1, ...data.blocks.map((b) => b.total_qty)),
    [data.blocks],
  );

  const chartData = useMemo(
    () =>
      data.daily_sync_runs.map((p) => ({
        date: p.date,
        ok: p.ok,
        partial: p.partial,
        failed: p.failed,
        label: shortDate(p.date),
      })),
    [data.daily_sync_runs],
  );

  return (
    <div className="flex flex-col gap-5" data-testid="central-detail-panel">
      <SubKpiGrid
        tone="central"
        tiles={[
          {
            label: 'Bloklar',
            value: formatQty(data.kpis.block_count),
          },
          {
            label: 'Jami SKU',
            value: formatQty(data.kpis.total_sku),
          },
          {
            label: "Min'dan past",
            value: formatQty(data.kpis.below_min_count),
            tone: data.kpis.below_min_count > 0 ? 'danger' : 'default',
          },
          {
            label: 'Oxirgi sinx',
            value:
              data.kpis.last_sync_at === null
                ? '—'
                : formatRelative(data.kpis.last_sync_at),
            tone:
              data.kpis.last_sync_status === 'failed'
                ? 'danger'
                : data.kpis.last_sync_status === 'partial'
                  ? 'warn'
                  : 'default',
          },
        ]}
      />

      <PanelSection
        title="Top bloklar — qoldiq"
        description="Eng ko'p ostatka turgan 10 blok."
      >
        {blockItems.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Blok ma'lumoti yo'q.
          </p>
        ) : (
          <BlockBarList
            items={blockItems}
            total={blockTotal}
            defaultTone="central"
          />
        )}
      </PanelSection>

      <PanelSection
        title="Poster sinx jurnali"
        description="So'nggi 10 ta sinxronizatsiya."
      >
        {data.recent_sync_log.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Sinx jurnali bo'sh.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.recent_sync_log.slice(0, 10).map((row) => (
              <SyncLogRowView key={row.id} row={row} />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Kunlik sinx ishlari"
        description="Holatlar bo'yicha taqsimlangan."
      >
        <div
          className="h-44 w-full rounded-md border border-border/40 bg-surface-2/30 p-2"
          data-testid="central-detail-chart"
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
                  width={28}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, k: string) => {
                    const label =
                      k === 'ok'
                        ? 'Muvaffaqiyatli'
                        : k === 'partial'
                          ? 'Qisman'
                          : 'Xato';
                    return [formatQty(v), label];
                  }}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  formatter={(v) =>
                    v === 'ok' ? 'OK' : v === 'partial' ? 'Qisman' : 'Xato'
                  }
                />
                <Bar
                  dataKey="ok"
                  stackId="s"
                  fill="hsl(var(--success))"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="partial"
                  stackId="s"
                  fill="hsl(var(--warning))"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="failed"
                  stackId="s"
                  fill="hsl(var(--destructive))"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelSection>
    </div>
  );
}

function SyncLogRowView({ row }: { row: SyncLogRow }) {
  const isOk = row.status === 'ok';
  const isPartial = row.status === 'partial';
  const tone = isOk
    ? 'border-success/40 text-success'
    : isPartial
      ? 'border-warning/40 text-warning'
      : 'border-destructive/40 text-destructive';
  const label = isOk ? 'OK' : isPartial ? 'Qisman' : 'Xato';
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-surface-2/40 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
        >
          {label}
        </span>
        <div className="min-w-0">
          <p className="truncate text-foreground">{row.entity}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {formatDateTime(row.started_at)}
          </p>
        </div>
      </div>
      <span className="shrink-0 tabular-nums text-foreground">
        {formatQty(row.records_applied)} / {formatQty(row.records_in)}
      </span>
    </li>
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
