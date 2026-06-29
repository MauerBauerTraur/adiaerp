import { MessageSquarePlus, History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import type { AssistantSessionSummary } from '@/lib/types';

interface SessionListProps {
  sessions: AssistantSessionSummary[];
  /** Currently open session, or `null` for a brand-new (unsent) conversation. */
  activeSessionId: number | null;
  /** Switch to an existing session (fetches `/sessions/:id`). */
  onSelectSession: (id: number) => void;
  /** Start a fresh, unsent conversation. */
  onNewSession: () => void;
  isLoading: boolean;
  error: string | null;
  className?: string;
}

/**
 * Past-sessions rail (the drawer's left column).
 *
 * On narrow viewports the parent drawer collapses this list to a single
 * "Yangi suhbat" button — see `AssistantDrawer` for the responsive switch.
 */
export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  isLoading,
  error,
  className,
}: SessionListProps) {
  return (
    <aside
      className={cn(
        'flex h-full w-60 shrink-0 flex-col border-r border-border/60 bg-card/30',
        className,
      )}
      aria-label="Suhbatlar tarixi"
    >
      <div className="border-b border-border/60 p-3">
        <Button
          variant="default"
          size="sm"
          className="w-full justify-start"
          onClick={onNewSession}
        >
          <MessageSquarePlus className="size-4" aria-hidden="true" />
          Yangi suhbat
        </Button>
      </div>

      <div className="flex items-center gap-2 px-3 pt-3 text-xs uppercase tracking-wider text-muted-foreground">
        <History className="size-3" aria-hidden="true" />
        Suhbatlar
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Yuklanmoqda…
          </div>
        )}
        {error !== null && !isLoading && (
          <p className="px-2 py-4 text-xs text-destructive">{error}</p>
        )}
        {!isLoading && error === null && sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            Hali suhbatlar yo‘q.
          </p>
        )}
        <ul className="space-y-1">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onSelectSession(session.id)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-primary/15 text-foreground ring-1 ring-primary/30'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <span className="line-clamp-2 w-full text-sm font-medium text-foreground">
                    {session.title ?? 'Nomsiz suhbat'}
                  </span>
                  <time
                    dateTime={session.updated_at}
                    className="text-[10px] tabular-nums text-muted-foreground"
                  >
                    {formatDateTime(session.updated_at)}
                  </time>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
