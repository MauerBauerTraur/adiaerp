import { useEffect, useState } from 'react';
import { Loader2, MapPin, Package, UserPlus, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  DeliveryStatus,
  DeliveryTask,
  ReplenishmentStatus,
  User,
} from '@/lib/types';

const DELIVERY_STATUS_OPTIONS: { value: DeliveryStatus | ''; label: string }[] = [
  { value: '', label: 'Barchasi' },
  { value: 'NEW', label: 'Yangi' },
  { value: 'CHECK_STORE_SUPPLIER', label: 'Tekshiruvda' },
  { value: 'SHIP_TO_REQUESTER', label: 'Yo‘lda' },
];

/**
 * F4.10 — Yetkazib berish (delivery) — task-style queue of replenishment
 * requests in NEW / CHECK_STORE_SUPPLIER / SHIP_TO_REQUESTER. Managers
 * assign a delivery person, then advance or cancel the request via the
 * same `/api/replenishment/:id/{advance,cancel}` endpoints.
 *
 * RBAC visibility (mirrors the sidebar nav): pm, central_warehouse_manager,
 * supply_manager, store_manager. The backend further scopes the list by
 * the caller's role and active location.
 */
export function DeliveryPage() {
  const { notify } = useToast();
  const { isReadOnly, canActOn } = useCanAct();
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [assignFor, setAssignFor] = useState<DeliveryTask | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const path =
    status === ''
      ? '/api/delivery/tasks'
      : `/api/delivery/tasks?status=${status}`;
  const { data, isLoading, error, refetch } = useApiQuery<DeliveryTask[]>(path);

  const tasks = data ?? [];

  async function advance(task: DeliveryTask): Promise<void> {
    setBusyId(task.id);
    try {
      await apiRequest(`/api/replenishment/${task.replenishment_id}/advance`, {
        method: 'POST',
      });
      notify('success', 'So‘rov keyingi bosqichga o‘tdi.');
      refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(task: DeliveryTask): Promise<void> {
    setBusyId(task.id);
    try {
      await apiRequest(`/api/replenishment/${task.replenishment_id}/cancel`, {
        method: 'POST',
        body: { reason: 'Yetkazib berish bekor qilindi.' },
      });
      notify('success', 'So‘rov bekor qilindi.');
      refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Yetkazib berish"
        description="Kelgan so‘rovlar va yetkazib beruvchi hodimlar bilan koordinatsiya."
        action={
          isReadOnly ? (
            <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
              Faqat o‘qish
            </Badge>
          ) : undefined
        }
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="del-status">Holat bo‘yicha</Label>
          <Select
            id="del-status"
            className="w-full sm:w-56"
            value={status}
            onChange={(e) => setStatus(e.target.value as DeliveryStatus | '')}
          >
            {DELIVERY_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && tasks.length === 0 && (
          <EmptyState message="Yetkazib berish vazifalari yo‘q." />
        )}
        {!isLoading && !error && tasks.length > 0 && (
          <div
            className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="delivery-task-list"
          >
            {tasks.map((task) => {
              const isBusy = busyId === task.id;
              // Map delivery status onto the shared replenishment label
              // set so colour/text stay consistent across screens.
              const replStatus = task.status as ReplenishmentStatus;
              // Stage 2 RBAC (commit 25a2527):
              //   - assign / advance → either side of the chain (mirrors
              //     principalTouchesRequest on /api/replenishment/:id/advance).
              //   - cancel           → only the requester bo'g'in's manager.
              const isScoped =
                canActOn(task.requester_location_id) ||
                canActOn(task.target_location_id);
              const canCancel = canActOn(task.requester_location_id);
              return (
                <article
                  key={task.id}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm"
                  data-testid={`delivery-task-${task.id}`}
                >
                  <header className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        #{task.replenishment_id}
                      </p>
                      <p className="truncate text-sm font-semibold">
                        {task.product_name}
                      </p>
                    </div>
                    <Badge variant={REPLENISHMENT_STATUS_VARIANT[replStatus]}>
                      {REPLENISHMENT_STATUS_LABELS[replStatus]}
                    </Badge>
                  </header>
                  <dl className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Package
                        className="size-3 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <dt className="text-muted-foreground">Miqdor:</dt>
                      <dd className="tabular-nums">
                        {formatQty(task.qty_needed)} {task.product_unit}
                      </dd>
                    </div>
                    <div className="flex items-start gap-1.5">
                      <MapPin
                        className="mt-0.5 size-3 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="truncate">
                          <span className="text-muted-foreground">Manba:</span>{' '}
                          {task.target_location_name ?? '—'}
                        </p>
                        <p className="truncate">
                          <span className="text-muted-foreground">Maqsad:</span>{' '}
                          {task.requester_location_name}
                        </p>
                      </div>
                    </div>
                    <div className="text-muted-foreground">
                      {formatDateTime(task.created_at)}
                    </div>
                  </dl>
                  <div
                    className={
                      'rounded-md border px-2.5 py-1.5 text-xs ' +
                      (task.assigned_user_id
                        ? 'border-primary/30 bg-primary/5 text-foreground'
                        : 'border-amber-500/30 bg-amber-500/5 text-amber-200')
                    }
                  >
                    {task.assigned_user_id ? (
                      <>
                        <span className="text-muted-foreground">
                          Biriktirilgan:
                        </span>{' '}
                        <span className="font-medium">
                          {task.assigned_user_name ?? `#${task.assigned_user_id}`}
                        </span>
                      </>
                    ) : (
                      'Hali hodim biriktirilmagan'
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isScoped && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setAssignFor(task)}
                      >
                        <UserPlus className="size-4" aria-hidden="true" />
                        {task.assigned_user_id ? 'O‘zgartirish' : 'Biriktirish'}
                      </Button>
                    )}
                    {isScoped && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => advance(task)}
                      >
                        {isBusy && (
                          <Loader2
                            className="size-4 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        Bajarish
                      </Button>
                    )}
                    {canCancel && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => cancel(task)}
                      >
                        <X className="size-4" aria-hidden="true" />
                        Bekor
                      </Button>
                    )}
                    {!isScoped && !canCancel && (
                      <span className="text-xs text-muted-foreground">
                        Faqat ko‘rish
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      <AssignDialog
        task={assignFor}
        onOpenChange={(open) => {
          if (!open) setAssignFor(null);
        }}
        onAssigned={() => {
          refetch();
          setAssignFor(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assign dialog
// ---------------------------------------------------------------------------

function AssignDialog({
  task,
  onOpenChange,
  onAssigned,
}: {
  task: DeliveryTask | null;
  onOpenChange: (open: boolean) => void;
  onAssigned: () => void;
}) {
  const { notify } = useToast();
  const { user } = useAuth();
  const isOpen = task !== null;
  const [selectedId, setSelectedId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Candidate users — the backend already RBAC-scopes /api/users by the
  // caller, but we filter to delivery-relevant roles client-side too.
  const users = useApiQuery<User[]>(isOpen ? '/api/users' : null);
  const candidates = (users.data ?? []).filter(
    (u) =>
      u.role === 'supply_manager' ||
      u.role === 'central_warehouse_manager' ||
      u.role === 'store_manager',
  );

  async function save(): Promise<void> {
    if (!task || !selectedId) return;
    setSaving(true);
    try {
      await apiRequest(`/api/delivery/tasks/${task.id}/assign`, {
        method: 'PATCH',
        body: { user_id: Number(selectedId) },
      });
      notify('success', 'Hodim biriktirildi.');
      onAssigned();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
      );
    } finally {
      setSaving(false);
    }
  }

  // Reset the selection whenever the dialog targets a new task.
  useEffect(() => {
    if (task) {
      setSelectedId(task.assigned_user_id ? String(task.assigned_user_id) : '');
    } else {
      setSelectedId('');
    }
  }, [task]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) setSelectedId('');
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hodim biriktirish</DialogTitle>
        </DialogHeader>
        {users.isLoading && <LoadingState />}
        {!users.isLoading && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {task ? (
                <>
                  #{task.replenishment_id} · {task.product_name} →{' '}
                  {task.requester_location_name}
                </>
              ) : null}
            </p>
            <Label htmlFor="assign-user">Yetkazib beruvchi hodim</Label>
            <Select
              id="assign-user"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— tanlang —</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} (@{u.username})
                </option>
              ))}
            </Select>
            {user?.role === 'pm' && candidates.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Mos rolli hodim topilmadi. Avval{' '}
                <a className="underline" href="/employees">
                  Hodimlar
                </a>{' '}
                sahifasida hodim qo‘shing.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Bekor qilish
          </Button>
          <Button
            type="button"
            disabled={!selectedId || saving}
            onClick={save}
          >
            {saving && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
