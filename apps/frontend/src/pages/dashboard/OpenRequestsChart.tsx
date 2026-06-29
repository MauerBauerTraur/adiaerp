import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { formatQty } from '@/lib/format';
import type { ReplenishmentStatus } from '@/lib/types';

/**
 * Maps a status badge variant to a CSS HSL token reference. The chart
 * pulls the same hues used in `<Badge>` so the legend and slice colours
 * agree. Recharts cannot read `var(--token)` indirectly (the `fill` value
 * is passed straight to SVG), so we read from the computed style if the
 * `--*` token is defined; otherwise we fall back to literal HSL strings
 * mirroring `index.css`. The fallback keeps colours sensible inside
 * jsdom tests where computed CSS variables resolve to an empty string.
 */
type BadgeVariant = (typeof REPLENISHMENT_STATUS_VARIANT)[ReplenishmentStatus];

const VARIANT_TOKEN: Record<BadgeVariant, { token: string; fallback: string }> = {
  default: { token: '--info', fallback: 'hsl(200 88% 56%)' },
  outline: { token: '--muted-foreground', fallback: 'hsl(220 9% 64%)' },
  success: { token: '--success', fallback: 'hsl(152 56% 48%)' },
  warning: { token: '--warning', fallback: 'hsl(28 90% 58%)' },
  danger: { token: '--destructive', fallback: 'hsl(0 84% 60%)' },
};

interface ChartEntry {
  status: ReplenishmentStatus;
  label: string;
  value: number;
  colour: string;
}

function resolveColour(token: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue(token).trim();
  return raw === '' ? fallback : `hsl(${raw})`;
}

function buildEntries(
  entries: [ReplenishmentStatus, number][],
): ChartEntry[] {
  return entries
    .filter(([, value]) => value > 0)
    .map(([status, value]) => {
      const variant = REPLENISHMENT_STATUS_VARIANT[status];
      const { token, fallback } = VARIANT_TOKEN[variant];
      return {
        status,
        label: REPLENISHMENT_STATUS_LABELS[status],
        value,
        colour: resolveColour(token, fallback),
      };
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * Donut chart + textual legend for the open-requests-by-status
 * aggregate. The chart is purely decorative; the legend below it lists
 * every status so screen readers and the contract test can read the
 * data without relying on the SVG.
 */
export function OpenRequestsChart({
  entries,
  total,
}: {
  entries: [ReplenishmentStatus, number][];
  total: number;
}) {
  const chartEntries = buildEntries(entries);

  return (
    <div className="flex flex-col gap-4">
      <div
        className="relative mx-auto h-48 w-full max-w-[260px]"
        aria-hidden="true"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartEntries}
              dataKey="value"
              nameKey="label"
              innerRadius={56}
              outerRadius={84}
              paddingAngle={2}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {chartEntries.map((entry) => (
                <Cell key={entry.status} fill={entry.colour} />
              ))}
            </Pie>
            <Tooltip
              cursor={{ fill: 'transparent' }}
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '0.5rem',
                fontSize: '0.75rem',
                color: 'hsl(var(--popover-foreground))',
              }}
              formatter={(value: number) => [formatQty(value), 'Soni']}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">
            {formatQty(total)}
          </span>
          <span className="text-xs text-muted-foreground">jami</span>
        </div>
      </div>

      <ul className="space-y-1.5 text-sm" data-testid="open-requests-legend">
        {chartEntries.map((entry) => (
          <li
            key={entry.status}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: entry.colour }}
              />
              <span className="truncate text-muted-foreground">
                {entry.label}
              </span>
            </span>
            <span className="tabular-nums font-medium">
              {formatQty(entry.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
