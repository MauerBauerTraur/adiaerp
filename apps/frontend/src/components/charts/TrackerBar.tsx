import { cn } from '@/lib/utils';

/**
 * Sprint C — Tremor-style tracker grid.
 *
 * Each row carries a label and a fixed-length sequence of cells, where
 * every cell encodes one of four states: ok / warn / danger / empty.
 * Useful for "N sex × 7 days" workload heatmaps on the production
 * detail panel.
 */
export type TrackerCellStatus = 'ok' | 'warn' | 'danger' | 'empty';

export interface TrackerRow {
  label: string;
  /** Optional accessible caption rendered to the right of the row. */
  caption?: string;
  days: TrackerCellStatus[];
}

export interface TrackerBarProps {
  rows: TrackerRow[];
  /** Optional label rendered above the columns (e.g. day codes). */
  columnLabels?: string[];
  className?: string;
}

const STATUS_CLASS: Record<TrackerCellStatus, string> = {
  ok: 'bg-success/80',
  warn: 'bg-warning/80',
  danger: 'bg-destructive/80',
  empty: 'bg-surface-3 border border-border/40',
};

const STATUS_TITLE: Record<TrackerCellStatus, string> = {
  ok: 'Yaxshi',
  warn: 'Diqqat',
  danger: 'Xavf',
  empty: "Ma'lumot yo'q",
};

export function TrackerBar({ rows, columnLabels, className }: TrackerBarProps) {
  return (
    <div
      data-testid="tracker-bar"
      className={cn('flex flex-col gap-1.5', className)}
    >
      {columnLabels && columnLabels.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="w-24 shrink-0" aria-hidden="true" />
          <div className="grid flex-1 gap-1" style={gridStyle(columnLabels.length)}>
            {columnLabels.map((label, i) => (
              <span
                key={i}
                className="text-center text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
          {/* spacer for trailing caption column */}
          <div className="w-12 shrink-0" aria-hidden="true" />
        </div>
      )}
      {rows.map((row, rIdx) => (
        <div key={rIdx} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-xs font-medium text-foreground">
            {row.label}
          </span>
          <div
            className="grid flex-1 gap-1"
            style={gridStyle(row.days.length)}
            role="row"
            aria-label={`${row.label} — kunlik holat`}
          >
            {row.days.map((status, dIdx) => (
              <span
                key={dIdx}
                role="gridcell"
                aria-label={`${row.label}, ${dIdx + 1}-kun: ${STATUS_TITLE[status]}`}
                title={STATUS_TITLE[status]}
                data-status={status}
                className={cn(
                  'h-5 rounded-sm transition-opacity hover:opacity-80',
                  STATUS_CLASS[status],
                )}
              />
            ))}
          </div>
          <span className="w-12 shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground">
            {row.caption ?? ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function gridStyle(n: number): React.CSSProperties {
  return { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
}
