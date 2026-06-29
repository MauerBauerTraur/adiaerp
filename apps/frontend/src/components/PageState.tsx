import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Inbox, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateLong } from '@/lib/format';

/** Centered loading spinner for in-progress data fetches. */
export function LoadingState({ label = 'Yuklanmoqda…' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Error panel with an optional retry action. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-16 text-center"
      role="alert"
    >
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Qayta urinish
        </Button>
      )}
    </div>
  );
}

/** Empty-list placeholder. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * EPIC 6.2 — shared sana + jonli soat widget. Every module header that
 * opts into `dateTime` renders the same live clock + long date so the
 * top of each screen is visually consistent across the app. The clock
 * ticks once per second (mirrors `DashboardHeaderSlot`'s `useClock`).
 */
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

/** Standalone sana + soat pill used inside `PageHeader`. */
export function PageHeaderClock() {
  const clock = useClock();
  const longDate = formatDateLong(new Date().toISOString());
  return (
    <span
      className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-1.5 text-xs text-muted-foreground tabular-nums"
      data-testid="page-header-datetime"
    >
      <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">{longDate}</span>
      <span aria-hidden="true" className="hidden text-border sm:inline">
        ·
      </span>
      <span className="font-medium text-foreground">{clock}</span>
    </span>
  );
}

/**
 * Page heading block used across module screens.
 *
 * EPIC 6.2 — for a consistent header across all modules, pass
 * `dateTime` to render the shared live sana/soat widget and `filter` to
 * dock a `FilterPopover` (or any control) on the same row as the actions.
 * Both slots are optional, so existing callers are unaffected.
 */
export function PageHeader({
  title,
  description,
  action,
  filter,
  dateTime = false,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Filter control (e.g. `FilterPopover`) docked next to the actions. */
  filter?: React.ReactNode;
  /** Render the shared live sana/soat widget on the right. */
  dateTime?: boolean;
}) {
  const hasRight = Boolean(action || filter || dateTime);
  return (
    <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {hasRight && (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {dateTime && <PageHeaderClock />}
          {filter}
          {action}
        </div>
      )}
    </header>
  );
}
