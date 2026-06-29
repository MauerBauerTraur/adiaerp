import { useEffect, useState } from 'react';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { formatDateLong, getGreeting } from '@/lib/format';

function useClock(): string {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString('uz-UZ', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface DashboardHeaderSlotProps {
  userName: string;
  isoDate: string;
  range: DateRangeValue;
  onRangeChange: (next: DateRangeValue) => void;
}

/**
 * Dashboard content for the global app header (rendered via HeaderSlot).
 * Greeting on the left, date-range filter in the middle, date + live
 * clock on the right.
 */
export function DashboardHeaderSlot({
  userName,
  isoDate,
  range,
  onRangeChange,
}: DashboardHeaderSlotProps) {
  const greeting = getGreeting();
  const longDate = formatDateLong(isoDate);
  const clock = useClock();

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-x-6">
      {/* Left — greeting */}
      <h1 className="min-w-0 truncate text-sm font-medium text-foreground sm:text-base">
        <span className="text-muted-foreground">{greeting},</span>{' '}
        <span className="font-semibold">{userName}</span>
      </h1>

      {/* Middle — date + clock, true-centered in the viewport */}
      <p
        className="hidden items-center gap-2.5 text-sm text-muted-foreground tabular-nums xl:flex"
        data-testid="dashboard-header-datetime"
      >
        <span>{longDate}</span>
        <span aria-hidden="true" className="text-border">
          ·
        </span>
        <span
          className="text-base font-semibold text-foreground"
          data-testid="dashboard-header-clock"
        >
          {clock}
        </span>
      </p>
      {/* Mobile / tablet placeholder so the grid keeps three columns even
          when the center datetime is hidden below xl. */}
      <span aria-hidden="true" className="xl:hidden" />

      {/* Right — filter + calendar */}
      <div className="flex justify-end">
        <DateRangeFilter value={range} onChange={onRangeChange} />
      </div>
    </div>
  );
}
