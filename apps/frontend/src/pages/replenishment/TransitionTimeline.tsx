import {
  Ban,
  CheckCircle2,
  ClipboardList,
  Factory,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Sparkles,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime, formatRelative } from '@/lib/format';
import { REPLENISHMENT_STATUS_LABELS } from '@/lib/labels';
import type {
  ReplenishmentStatus,
  ReplenishmentTransition,
} from '@/lib/types';

interface TransitionTimelineProps {
  transitions: ReplenishmentTransition[];
}

/**
 * Visual tone of a timeline step. Drives the icon ring + rail colour so a
 * boshliq can scan the request's life at a glance:
 *   - `start`   — the request was raised (neutral, dashed ring);
 *   - `progress`— a normal forward step (primary/blue);
 *   - `success` — the request closed successfully (green);
 *   - `danger`  — the request was cancelled (red).
 */
type StepTone = 'start' | 'progress' | 'success' | 'danger';

const TONE_STYLES: Record<
  StepTone,
  { ring: string; icon: string; rail: string }
> = {
  start: {
    ring: 'border-border bg-muted',
    icon: 'text-muted-foreground',
    rail: 'bg-border',
  },
  progress: {
    ring: 'border-sky-500/40 bg-sky-500/10',
    icon: 'text-sky-300',
    rail: 'bg-sky-500/30',
  },
  success: {
    ring: 'border-emerald-500/40 bg-emerald-500/15',
    icon: 'text-emerald-300',
    rail: 'bg-emerald-500/30',
  },
  danger: {
    ring: 'border-red-500/40 bg-red-500/15',
    icon: 'text-red-300',
    rail: 'bg-red-500/30',
  },
};

/** Icon shown for the *resulting* status of a transition. */
const STATUS_ICON: Record<ReplenishmentStatus, LucideIcon> = {
  NEW: Sparkles,
  CHECK_STORE_SUPPLIER: Search,
  SHIP_TO_REQUESTER: Truck,
  CHECK_PRODUCTION_INPUT: Search,
  CREATE_PURCHASE_ORDER: ShoppingCart,
  CREATE_PRODUCTION_ORDER: ClipboardList,
  PRODUCING: Factory,
  DONE_TO_WAREHOUSE: PackageCheck,
  CLOSED: CheckCircle2,
  CANCELLED: Ban,
};

function toneForStatus(status: ReplenishmentStatus): StepTone {
  if (status === 'CLOSED') return 'success';
  if (status === 'CANCELLED') return 'danger';
  return 'progress';
}

/**
 * EPIC 4.2 — request transition history, redesigned for clarity.
 *
 * Each entry is one row in `replenishment_transitions`. Instead of the old
 * "badge → badge" pair, the step now reads as a single sentence: a coloured
 * icon ring (status-typed), the destination status as the headline, the
 * source status as a quiet "… holatidan" caption, then kim / qachon.
 *
 * The vertical rail connecting the dots is tinted by the *destination* tone,
 * so a successful close glows green and a cancellation glows red — the eye
 * lands on the outcome without reading every line.
 *
 * `actor_name` is embedded by `GET /api/replenishment/:id` (JOIN users) so
 * system / cron rows arrive with `actor_name = null` and render as "Tizim".
 */
export function TransitionTimeline({ transitions }: TransitionTimelineProps) {
  if (transitions.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        O‘tishlar tarixi bo‘sh.
      </p>
    );
  }

  return (
    <ol
      className="space-y-1 px-4 py-4"
      aria-label="O‘tishlar tarixi"
      aria-live="polite"
    >
      {transitions.map((t, idx) => {
        const isLast = idx === transitions.length - 1;
        const isFirst = t.from_status === null;
        const tone: StepTone = isFirst ? 'start' : toneForStatus(t.to_status);
        const styles = TONE_STYLES[tone];
        const Icon = isFirst ? Plus : STATUS_ICON[t.to_status];
        const actorLabel =
          t.actor_name ??
          (t.actor_user_id == null ? 'Tizim' : `#${t.actor_user_id}`);

        return (
          <li key={t.id} className="relative flex gap-3 pb-4 last:pb-0">
            {/* Icon ring + connecting rail */}
            <div className="relative flex flex-col items-center">
              <span
                className={cn(
                  'z-10 flex size-8 shrink-0 items-center justify-center rounded-full border',
                  styles.ring,
                )}
                aria-hidden="true"
              >
                <Icon className={cn('size-4', styles.icon)} />
              </span>
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-8 h-[calc(100%-2rem)] w-px',
                    styles.rail,
                  )}
                />
              )}
            </div>

            <div className="flex-1 pt-0.5">
              <p className="text-sm font-medium leading-tight">
                {isFirst
                  ? 'So‘rov yaratildi'
                  : REPLENISHMENT_STATUS_LABELS[t.to_status]}
              </p>
              {!isFirst && t.from_status !== null && (
                <p className="text-xs text-muted-foreground">
                  {REPLENISHMENT_STATUS_LABELS[t.from_status]} holatidan
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {actorLabel}
                </span>
                <span aria-hidden="true">·</span>
                <time dateTime={t.created_at} title={formatDateTime(t.created_at)}>
                  {formatRelative(t.created_at)}
                </time>
              </div>
              {t.reason && (
                <p className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-foreground/80">
                  {t.reason}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
