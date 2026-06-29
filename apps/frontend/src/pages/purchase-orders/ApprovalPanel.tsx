import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, PackageCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import type { PurchaseApprovalStep, PurchaseOrder } from '@/lib/types';

interface ApprovalPanelProps {
  order: PurchaseOrder;
  onChanged: () => void;
}

/**
 * Two-step approval UI (D5, OS-5).
 *
 * Post Stage-1 RBAC (commit da5aebe) — PM is read-and-recommend. The
 * backend rules:
 *
 *   - Manager step (`POST /:id/approve {step:'manager'}`)
 *       → role must be `supply_manager` AND the user must be the
 *         original PO creator (`purchase_orders.created_by = user.id`).
 *   - Keeper step  (`POST /:id/approve {step:'keeper'}`)
 *       → role must be `raw_warehouse_manager` AND the user must be a
 *         scoped operator on `target_location_id`.
 *   - Receive      (`POST /:id/receive`)
 *       → role must be `raw_warehouse_manager` AND scoped operator on
 *         `target_location_id`.
 *   - Reject       (`POST /:id/reject`, draft only)
 *       → role must be `supply_manager` (no per-PO scoping; any supply
 *         manager may reject any draft).
 */
export function ApprovalPanel({ order, onChanged }: ApprovalPanelProps) {
  const { user } = useAuth();
  const { canActOn } = useCanAct();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const role = user?.role;
  // Manager step — the supply manager who DRAFTED the request is the
  // one who can sign it off. Backend enforces created_by = user.id, so
  // we mirror that here to keep the button off other supply managers'
  // screens (avoids a confusing 403).
  const canManager =
    role === 'supply_manager' && user?.id === order.created_by;
  // Keeper step + Receive — same scoping (raw_warehouse_manager owning
  // the target raw warehouse).
  const isKeeperRole = role === 'raw_warehouse_manager';
  const isScopedKeeper = canActOn(order.target_location_id);
  const canKeeper = isKeeperRole && isScopedKeeper;
  const canReceive = isKeeperRole && isScopedKeeper;
  // Reject — any supply manager (no per-PO scoping on the backend).
  const canReject = role === 'supply_manager';

  const managerSigned = order.manager_approved_by !== null;
  const keeperSigned = order.keeper_approved_by !== null;
  const isDraft = order.status === 'draft';
  const isApproved = order.status === 'approved';

  async function run(
    op: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ): Promise<void> {
    setError(null);
    setBusy(op);
    try {
      await fn();
      notify('success', successMsg);
      onChanged();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
      );
    } finally {
      setBusy(null);
    }
  }

  function approve(step: PurchaseApprovalStep): void {
    void run(
      `approve-${step}`,
      () =>
        apiRequest(`/api/purchase-orders/${order.id}/approve`, {
          method: 'POST',
          body: { step },
        }),
      step === 'manager' ? 'Sex skladi boshlig‘i tasdig‘i.' : 'Skladchi tasdig‘i.',
    );
  }

  function receive(): void {
    void run(
      'receive',
      () =>
        apiRequest(`/api/purchase-orders/${order.id}/receive`, {
          method: 'POST',
        }),
      'So‘rov qabul qilindi, ombor qoldig‘i yangilandi.',
    );
  }

  function reject(): void {
    void run(
      'reject',
      () =>
        apiRequest(`/api/purchase-orders/${order.id}/reject`, {
          method: 'POST',
        }),
      'So‘rov rad etildi.',
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Always stack vertically. The previous lg:grid-cols-2 split looked
          fine in the standalone detail view, but the PO listing renders
          this panel inside a 3-up card grid where each column is only a
          third of the viewport — the two step cards collide there. A
          single column reads well in both placements. */}
      <div className="grid grid-cols-1 gap-3">
        <StepCard
          title="Sex skladi boshlig‘i tasdig‘i"
          signed={managerSigned}
          actorId={order.manager_approved_by}
          actorName={order.manager_approved_name}
          at={order.manager_approved_at}
          actionLabel="Tasdiqlash"
          ariaActionLabel="Tasdiqlash (boshliq)"
          canAct={canManager && isDraft && !managerSigned}
          isBusy={busy === 'approve-manager'}
          onAct={() => approve('manager')}
        />
        <StepCard
          title="Skladchi tasdig‘i"
          signed={keeperSigned}
          actorId={order.keeper_approved_by}
          actorName={order.keeper_approved_name}
          at={order.keeper_approved_at}
          actionLabel="Tasdiqlash"
          ariaActionLabel="Tasdiqlash (skladchi)"
          canAct={canKeeper && isDraft && !keeperSigned}
          isBusy={busy === 'approve-keeper'}
          onAct={() => approve('keeper')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {isApproved && canReceive && (
          <Button
            size="sm"
            disabled={busy === 'receive'}
            onClick={receive}
          >
            {busy === 'receive' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <PackageCheck className="size-4" aria-hidden="true" />
            )}
            Qabul qilish
          </Button>
        )}
        {isDraft && canReject && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy === 'reject'}
            onClick={reject}
          >
            {busy === 'reject' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <X className="size-4" aria-hidden="true" />
            )}
            Rad etish
          </Button>
        )}
        {!isDraft && !isApproved && (
          <p className="text-xs text-muted-foreground">
            Bu holatda yangi amallar mavjud emas.
          </p>
        )}
      </div>

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

interface StepCardProps {
  title: string;
  signed: boolean;
  actorId: number | null;
  /** Backend-embedded approver name; `null` if the FK has not been signed. */
  actorName: string | null;
  at: string | null;
  actionLabel: string;
  /** Verbose label fed to `aria-label` so assistive tech (and tests) can
   *  distinguish the two same-text buttons in the panel. */
  ariaActionLabel: string;
  canAct: boolean;
  isBusy: boolean;
  onAct: () => void;
}

function StepCard({
  title,
  signed,
  actorId,
  actorName,
  at,
  actionLabel,
  ariaActionLabel,
  canAct,
  isBusy,
  onAct,
}: StepCardProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3',
        signed
          ? 'border-success/30 bg-success/5'
          : 'border-border bg-card',
      )}
    >
      {signed ? (
        <CheckCircle2
          className="mt-0.5 size-5 shrink-0 text-success"
          aria-hidden="true"
        />
      ) : (
        <Circle
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="break-words text-sm font-medium">{title}</div>
        {signed ? (
          <div className="text-xs text-muted-foreground">
            <span>{actorName ?? `Foydalanuvchi #${actorId ?? '—'}`}</span>
            {at && (
              <>
                <span aria-hidden="true"> · </span>
                <span>{formatDateTime(at)}</span>
              </>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Hali tasdiqlanmagan.</div>
        )}
        {canAct && (
          <Button
            size="sm"
            disabled={isBusy}
            onClick={onAct}
            aria-label={ariaActionLabel}
          >
            {isBusy && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
