/**
 * Two-phase confirm card for AI write actions (Faza-3 F3.2).
 *
 * The card has three visual states:
 *   1. `pending` — header in warning tone, summary, collapsible args,
 *      countdown timer, [Tasdiqlash] [Rad qilish] buttons.
 *   2. `executed` / `rejected` / `expired` / `superseded` — read-only
 *      outcome strip (no buttons), in a tone that matches the status.
 *   3. `loading` while a `/confirm` or `/reject` request is in flight.
 *
 * The component is intentionally **stateless** with respect to the action
 * lifecycle — the parent (`useAssistantChat`) owns the truth and re-renders
 * with the resolved `action_result` when a request lands. The card only
 * owns its local UI state (collapsed args, "request in flight", local
 * error from a failed confirm/reject).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock,
  Loader2,
  TimerReset,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { assistantWriteToolLabel } from '@/lib/labels';
import type {
  AssistantActionResult,
  AssistantActionStatus,
  AssistantPendingAction,
} from '@/lib/types';

interface PendingActionCardProps {
  /** Either an in-flight pending action or a resolved outcome (mutually exclusive). */
  action: AssistantPendingAction | AssistantActionResult;
  /** Status — derived from the union: `pending` for AssistantPendingAction, else the resolved status. */
  status: AssistantActionStatus;
  /** Confirm handler — receives the action id. Called only when status is `pending`. */
  onConfirm?: (actionId: number) => Promise<void>;
  /** Reject handler — receives the action id. Called only when status is `pending`. */
  onReject?: (actionId: number) => Promise<void>;
  /** Whether a confirm/reject request is currently in flight (parent-owned). */
  isLoading?: boolean;
  /** Error from the last confirm/reject attempt (parent-owned). */
  error?: string | null;
  className?: string;
}

/**
 * Computes `mm:ss` (or `ss soniya`) remaining until `expiresAt`, refreshing every second.
 * Returns `null` if `expiresAt` is missing (e.g. the action is already resolved).
 */
function useCountdown(expiresAt: string | undefined): {
  label: string;
  isExpired: boolean;
} | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(tick);
    };
  }, [expiresAt]);

  return useMemo(() => {
    if (expiresAt === undefined) return null;
    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresMs)) return null;
    const deltaMs = expiresMs - now;
    if (deltaMs <= 0) {
      return { label: 'eskirdi', isExpired: true };
    }
    const totalSeconds = Math.ceil(deltaMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const padded = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    return { label: padded, isExpired: false };
  }, [expiresAt, now]);
}

function isPendingAction(
  action: AssistantPendingAction | AssistantActionResult,
): action is AssistantPendingAction {
  return 'expires_at' in action;
}

export function PendingActionCard({
  action,
  status,
  onConfirm,
  onReject,
  isLoading = false,
  error = null,
  className,
}: PendingActionCardProps) {
  const expiresAt = isPendingAction(action) ? action.expires_at : undefined;
  const countdown = useCountdown(expiresAt);

  const [argsExpanded, setArgsExpanded] = useState(false);

  const toolLabel = assistantWriteToolLabel(action.tool_name);
  const isPending = status === 'pending';
  // Derived "effective" status: once the countdown has visually hit zero we
  // disable the buttons even if the parent has not yet had a chance to flip
  // the status to `expired` (the next `/confirm` would 410 anyway).
  const isLocallyExpired = countdown?.isExpired === true && isPending;

  const headerTone = getHeaderTone(status, isLocallyExpired);

  function handleConfirm(): void {
    if (!isPending || isLoading || isLocallyExpired) return;
    void onConfirm?.(action.action_id);
  }

  function handleReject(): void {
    if (!isPending || isLoading) return;
    void onReject?.(action.action_id);
  }

  // `args` are only present on the live pending action — the resolved
  // outcome strip omits them (the JSON is no longer load-bearing once
  // the action has executed/rejected). When absent, the details panel
  // simply shows `{}`.
  const argsForDisplay = isPendingAction(action) ? action.args : {};
  const argsJson = useMemo(() => {
    try {
      return JSON.stringify(argsForDisplay ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [argsForDisplay]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm',
        headerTone.border,
        className,
      )}
      role="region"
      aria-label="AI yordamchi tasdiq so‘rovi"
      data-testid="pending-action-card"
      data-action-id={action.action_id}
      data-action-status={isLocallyExpired ? 'expired' : status}
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-b px-4 py-2.5 text-sm font-medium',
          headerTone.bg,
          headerTone.text,
          headerTone.border,
        )}
      >
        <span className="flex items-center gap-2">
          <StatusIcon status={status} isLocallyExpired={isLocallyExpired} />
          <span>{getHeaderTitle(status, isLocallyExpired)}</span>
        </span>
        {isPending && !isLocallyExpired && countdown !== null && (
          <span
            className="inline-flex items-center gap-1 text-xs font-normal tabular-nums"
            data-testid="pending-action-countdown"
          >
            <Clock className="size-3.5" aria-hidden="true" />
            <span>{countdown.label} da eskirayidi</span>
          </span>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {toolLabel}
          </p>
          <p className="text-sm font-medium leading-relaxed text-foreground">
            {action.summary}
          </p>
        </div>

        <details
          className="rounded-md border border-border/60 bg-muted/30"
          open={argsExpanded}
          onToggle={(e) => setArgsExpanded((e.target as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {argsExpanded ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
            <span>Tafsilotlarni ko‘rsatish</span>
          </summary>
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-all border-t border-border/60 px-2.5 py-2 font-mono text-[11px] leading-snug text-muted-foreground"
            data-testid="pending-action-args"
          >
            {argsJson}
          </pre>
        </details>

        {error !== null && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          >
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="flex-1">{error}</span>
          </p>
        )}

        {isPending && (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleReject}
              disabled={isLoading}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
              data-testid="pending-action-reject"
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CircleX className="size-3.5" aria-hidden="true" />
              )}
              <span>Rad qilish</span>
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isLoading || isLocallyExpired}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground ring-offset-background transition-colors',
                'hover:bg-primary/90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
              data-testid="pending-action-confirm"
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
              )}
              <span>Tasdiqlash</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface HeaderTone {
  bg: string;
  text: string;
  border: string;
}

function getHeaderTone(
  status: AssistantActionStatus,
  isLocallyExpired: boolean,
): HeaderTone {
  if (isLocallyExpired || status === 'expired') {
    return {
      bg: 'bg-muted/50',
      text: 'text-muted-foreground',
      border: 'border-border/70',
    };
  }
  switch (status) {
    case 'pending':
      return {
        bg: 'bg-warning/10',
        text: 'text-warning',
        border: 'border-warning/30',
      };
    case 'executed':
      return {
        bg: 'bg-success/10',
        text: 'text-success',
        border: 'border-success/30',
      };
    case 'rejected':
      return {
        bg: 'bg-destructive/10',
        text: 'text-destructive',
        border: 'border-destructive/30',
      };
    case 'superseded':
      return {
        bg: 'bg-muted/50',
        text: 'text-muted-foreground',
        border: 'border-border/70',
      };
    default:
      return {
        bg: 'bg-muted/40',
        text: 'text-muted-foreground',
        border: 'border-border/70',
      };
  }
}

function getHeaderTitle(
  status: AssistantActionStatus,
  isLocallyExpired: boolean,
): string {
  if (isLocallyExpired || status === 'expired') return '⌛ Eskirgan';
  switch (status) {
    case 'pending':
      return 'Bajarilishi kutilmoqda';
    case 'executed':
      return '✅ Bajarildi';
    case 'rejected':
      return '❌ Rad qilindi';
    case 'superseded':
      return '↩ Almashtirilgan';
    default:
      return status;
  }
}

function StatusIcon({
  status,
  isLocallyExpired,
}: {
  status: AssistantActionStatus;
  isLocallyExpired: boolean;
}) {
  if (isLocallyExpired || status === 'expired') {
    return <TimerReset className="size-4" aria-hidden="true" />;
  }
  switch (status) {
    case 'pending':
      return <Clock className="size-4" aria-hidden="true" />;
    case 'executed':
      return <CheckCircle2 className="size-4" aria-hidden="true" />;
    case 'rejected':
      return <CircleX className="size-4" aria-hidden="true" />;
    case 'superseded':
      return <TimerReset className="size-4" aria-hidden="true" />;
    default:
      return null;
  }
}
