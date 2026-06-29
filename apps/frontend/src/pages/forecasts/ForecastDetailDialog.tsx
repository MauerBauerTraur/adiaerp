import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, CalendarClock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { UNIT_LABELS } from '@/lib/labels';
import { formatDateTime, formatQty } from '@/lib/format';
import type { ForecastItem } from '@/lib/types';

/**
 * F3.4 — full 14-day forecast detail dialog (phase-3.md §2.4).
 *
 * Shows the daily predicted demand as an area chart with the lower /
 * upper confidence bands. Header surfaces the expected stockout date,
 * sidecar staleness, and the `generated_at` timestamp.
 */
export function ForecastDetailDialog({
  forecast,
  onOpenChange,
}: {
  forecast: ForecastItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={forecast !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {forecast !== null && <Body forecast={forecast} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ forecast }: { forecast: ForecastItem }) {
  const totalPredicted = forecast.daily_predictions.reduce(
    (acc, d) => acc + d.yhat,
    0,
  );
  const unit = UNIT_LABELS[forecast.product_unit];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{forecast.product_name}</DialogTitle>
        <DialogDescription>{forecast.location_name}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {forecast.expected_stockout_date !== null ? (
          <Badge variant="warning" className="gap-1">
            <CalendarClock className="size-3" aria-hidden="true" />
            Stockout: {forecast.expected_stockout_date}
          </Badge>
        ) : (
          <Badge variant="outline">14 kun ichida tugamaydi</Badge>
        )}
        {forecast.stale && (
          <Badge variant="warning" className="gap-1">
            <AlertCircle className="size-3" aria-hidden="true" />
            Eski ma’lumot
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Hisoblangan: {formatDateTime(forecast.generated_at)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryStat
          label="Jami bashorat (14 kun)"
          value={`${formatQty(totalPredicted)} ${unit}`}
        />
        <SummaryStat
          label="O‘rtacha kunlik"
          value={`${formatQty(totalPredicted / forecast.daily_predictions.length)} ${unit}`}
        />
      </div>

      <div className="h-64 w-full" data-testid="forecast-detail-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={forecast.daily_predictions}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => v.slice(5)}
              stroke="hsl(var(--muted-foreground))"
              tick={{ fontSize: 11 }}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              tick={{ fontSize: 11 }}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '0.5rem',
                fontSize: '0.75rem',
                color: 'hsl(var(--popover-foreground))',
              }}
              formatter={(value: number, name: string) => [
                `${formatQty(value)} ${unit}`,
                LABEL[name] ?? name,
              ]}
            />
            <Area
              type="monotone"
              dataKey="yhat_upper"
              stroke="transparent"
              fill="hsl(var(--primary))"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="yhat_lower"
              stroke="transparent"
              fill="hsl(var(--card))"
              fillOpacity={1}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="yhat"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

const LABEL: Record<string, string> = {
  yhat: 'Bashorat',
  yhat_lower: 'Past chegara',
  yhat_upper: 'Yuqori chegara',
};

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
