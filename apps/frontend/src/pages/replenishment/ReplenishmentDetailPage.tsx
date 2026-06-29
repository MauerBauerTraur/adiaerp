import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import {
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { ApiError, apiRequest } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  ReplenishmentAdvanceResponse,
  ReplenishmentDetail,
} from '@/lib/types';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import { CancelDialog } from './CancelDialog';
import { TransitionTimeline } from './TransitionTimeline';
import {
  RequestActionDialog,
  type RequestActionMode,
  type RequestActionPayload,
} from '@/pages/requests/RequestActionDialog';

/**
 * Detail screen for one replenishment_request. The page wraps two
 * mutating actions:
 *
 *   - `POST /api/replenishment/:id/advance` — step the state machine once;
 *     a 409 `INVALID_TRANSITION` is shown as a friendly Uzbek message.
 *   - `POST /api/replenishment/:id/cancel` — only the requesting bo'g'in's
 *     manager may cancel (RBAC Stage 1, commit c2ed012). PM is no longer
 *     allowed — the backend returns 403 with `auth.forbidden.pm_write_blocked`.
 *
 * Action visibility uses `useCanAct()` so we mirror the server guards
 * exactly — a user never sees a button the backend will 403.
 *
 *   - "Keyingi qadam" → visible iff the user is a scoped operator on
 *     either the requester OR the target bo'g'in (matches
 *     `principalTouchesRequest` on the backend).
 *   - "Bekor qilish"  → visible iff the user is a scoped operator on
 *     the requester bo'g'in (matches `requireLocationOperator`).
 *
 * Terminal requests (`CLOSED` / `CANCELLED`) hide both actions.
 */
export function ReplenishmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isReadOnly, canActOn } = useCanAct();
  const { notify } = useToast();

  const path = id ? `/api/replenishment/${id}` : null;
  const detail = useApiQuery<ReplenishmentDetail>(path);
  // `/api/replenishment/:id` embeds product_name, product_unit,
  // requester_location_name, target_location_name on the request and
  // actor_name on every transition — no extra `/api/products`,
  // `/api/locations`, or `/api/users` round trips needed. The user lookup
  // is also blocked by RBAC for non-pm roles, so calling it here would
  // 403 for store/production/supply managers viewing a request that
  // touches them.

  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // F4.14 — receiver-side actions (accept full / partial / reject / return).
  const [actionMode, setActionMode] = useState<RequestActionMode | null>(null);
  const [isActionSubmitting, setIsActionSubmitting] = useState(false);

  async function handleAdvance(): Promise<void> {
    if (!id) return;
    setActionError(null);
    setIsAdvancing(true);
    try {
      const result = await apiRequest<ReplenishmentAdvanceResponse>(
        `/api/replenishment/${id}/advance`,
        { method: 'POST' },
      );
      if (result.advanced) {
        notify(
          'success',
          `Holat o‘zgartirildi: ${REPLENISHMENT_STATUS_LABELS[result.status]}.`,
        );
      } else {
        notify('success', `Kutish holati: ${result.reason}`);
      }
      detail.refetch();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INVALID_TRANSITION') {
        setActionError(
          'Bu holatda o‘tishni amalga oshirib bo‘lmaydi. So‘rovning hozirgi holatini tekshiring.',
        );
      } else {
        setActionError(
          err instanceof ApiError ? err.message : 'O‘tishni bajarib bo‘lmadi.',
        );
      }
    } finally {
      setIsAdvancing(false);
    }
  }

  async function handleCancelConfirm(
    reason: string | undefined,
  ): Promise<void> {
    if (!id) return;
    setActionError(null);
    setIsCancelling(true);
    try {
      await apiRequest(`/api/replenishment/${id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      notify('success', 'So‘rov bekor qilindi.');
      setIsCancelDialogOpen(false);
      detail.refetch();
    } catch (err: unknown) {
      setActionError(
        err instanceof ApiError ? err.message : 'Bekor qilib bo‘lmadi.',
      );
      // Keep the dialog open so the operator can read the inline error
      // and either retry or close manually.
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleReceiverAction(
    payload: RequestActionPayload,
  ): Promise<void> {
    if (!id) return;
    setActionError(null);
    setIsActionSubmitting(true);
    try {
      switch (payload.mode) {
        case 'accept_full':
        case 'accept_partial':
          await apiRequest(`/api/replenishment/${id}/accept`, {
            method: 'POST',
            body: { qty_accepted: payload.qty, note: payload.note },
          });
          notify(
            'success',
            payload.mode === 'accept_full'
              ? "So‘rov to‘liq qabul qilindi."
              : "Qisman qabul qayd etildi.",
          );
          break;
        case 'reject':
          await apiRequest(`/api/replenishment/${id}/reject`, {
            method: 'POST',
            body: { reason: payload.reason },
          });
          notify('success', "So‘rov rad etildi.");
          break;
        case 'return':
          await apiRequest(`/api/replenishment/${id}/return`, {
            method: 'POST',
            body: { qty_returned: payload.qty, reason: payload.reason },
          });
          notify('success', "Tovar qaytarish qayd etildi.");
          break;
      }
      setActionMode(null);
      detail.refetch();
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.status === 404
            ? "Endpoint tayyor emas, biroz keyin urinib ko‘ring."
            : err.message
          : "Amalni bajarib bo‘lmadi.";
      notify('error', message);
    } finally {
      setIsActionSubmitting(false);
    }
  }

  if (detail.isLoading) return <LoadingState />;
  if (detail.error)
    return <ErrorState message={detail.error} onRetry={detail.refetch} />;
  if (!detail.data) return null;

  const { request, transitions } = detail.data;
  const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(request.status);
  // Advance: either side of the chain (requester or target) may step
  // the state machine. Mirrors `principalTouchesRequest` on the backend.
  const canAdvance =
    !isTerminal &&
    (canActOn(request.requester_location_id) ||
      canActOn(request.target_location_id));
  // Cancel: only the requesting bo'g'in may close its own request
  // (`requireLocationOperator(requester_location_id)` on the backend).
  const canCancel = !isTerminal && canActOn(request.requester_location_id);
  // F4.14 — receiver-side actions (accept / reject / partial / return).
  // The requester is the bo'g'in that ASKED for stock; on
  // SHIP_TO_REQUESTER (or DONE_TO_WAREHOUSE) they are the receiver and
  // confirm what arrived. Return is only sensible after CLOSED.
  const canReceiverAct =
    canActOn(request.requester_location_id) &&
    (request.status === 'SHIP_TO_REQUESTER' ||
      request.status === 'DONE_TO_WAREHOUSE');
  const canReturn =
    canActOn(request.requester_location_id) && request.status === 'CLOSED';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/replenishment')}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        So‘rovlar ro‘yxati
      </Button>

      <PageHeader
        title={`So‘rov #${request.id}`}
        description={request.product_name}
        action={
          <div className="flex items-center gap-2">
            {isReadOnly && (
              <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            {canAdvance && (
              <Button onClick={handleAdvance} disabled={isAdvancing}>
                {isAdvancing && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Keyingi qadam
              </Button>
            )}
            {canReceiverAct && (
              <>
                <Button
                  onClick={() => setActionMode('accept_full')}
                  disabled={isActionSubmitting}
                >
                  To‘liq qabul
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setActionMode('accept_partial')}
                  disabled={isActionSubmitting}
                >
                  Qisman qabul
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setActionMode('reject')}
                  disabled={isActionSubmitting}
                >
                  Kelmadi
                </Button>
              </>
            )}
            {canReturn && (
              <Button
                variant="outline"
                onClick={() => setActionMode('return')}
                disabled={isActionSubmitting}
              >
                Qaytarish
              </Button>
            )}
            {canCancel && (
              <Button
                variant="outline"
                onClick={() => {
                  setActionError(null);
                  setIsCancelDialogOpen(true);
                }}
                disabled={isCancelling}
              >
                {isCancelling && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Bekor qilish
              </Button>
            )}
          </div>
        }
      />

      {actionError && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <Card className="space-y-4 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Holat">
            <Badge variant={REPLENISHMENT_STATUS_VARIANT[request.status]}>
              {REPLENISHMENT_STATUS_LABELS[request.status]}
            </Badge>
          </Field>
          <Field label="Kerakli miqdor">
            <span className="tabular-nums">
              {formatQty(request.qty_needed)} {request.product_unit}
            </span>
          </Field>
          <Field label="So‘rovchi bo‘g‘in">
            {request.requester_location_name}
          </Field>
          <Field label="Maqsadli bo‘g‘in">
            {request.target_location_name ?? '—'}
          </Field>
          <Field label="Bog‘langan zayafka">
            {request.production_order_id != null ? (
              <Link
                to={`/production-orders`}
                className="text-primary hover:underline"
              >
                #{request.production_order_id}
              </Link>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Bog‘langan sotib olish">
            {request.purchase_order_id != null ? (
              <Link
                to={`/purchase-orders`}
                className="text-primary hover:underline"
              >
                #{request.purchase_order_id}
              </Link>
            ) : (
              '—'
            )}
          </Field>
          <Field label="Yaratilgan">{formatDateTime(request.created_at)}</Field>
          <Field label="Yangilangan">{formatDateTime(request.updated_at)}</Field>
        </div>
        {request.note && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            {request.note}
          </div>
        )}
      </Card>

      <Card>
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          O‘tishlar tarixi
        </div>
        <TransitionTimeline transitions={transitions} />
      </Card>

      {canCancel && (
        <CancelDialog
          open={isCancelDialogOpen}
          onOpenChange={(next) => {
            if (!isCancelling) setIsCancelDialogOpen(next);
          }}
          onConfirm={handleCancelConfirm}
          isSubmitting={isCancelling}
        />
      )}

      {actionMode !== null && (
        <RequestActionDialog
          open
          mode={actionMode}
          request={request}
          onOpenChange={(next) => {
            if (!isActionSubmitting && !next) setActionMode(null);
          }}
          onConfirm={handleReceiverAction}
          isSubmitting={isActionSubmitting}
        />
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
