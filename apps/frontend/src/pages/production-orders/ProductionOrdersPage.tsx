import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_OPTIONS,
} from '@/lib/labels';
import type { Location, Product, ProductionOrder, ProductionOrderStatus } from '@/lib/types';
import { ProductionOrderFormDialog } from './ProductionOrderFormDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STATUS_DOT: Record<string, string> = {
  new: 'bg-amber-400',
  in_progress: 'bg-blue-400',
  done: 'bg-emerald-500',
  cancelled: 'bg-muted-foreground/40',
};
const STATUS_RING: Record<string, string> = {
  new: 'ring-amber-400/30',
  in_progress: 'ring-blue-400/30',
  done: 'ring-emerald-500/30',
  cancelled: 'ring-border',
};
const SEX_DOT_COLORS = [
  'bg-violet-400',
  'bg-sky-400',
  'bg-rose-400',
  'bg-orange-400',
  'bg-teal-400',
  'bg-indigo-400',
];

function getDotColor(idx: number) {
  return SEX_DOT_COLORS[idx % SEX_DOT_COLORS.length] ?? 'bg-muted-foreground';
}

function isOverdue(deadline: string | null | undefined, status: string) {
  if (!deadline || status === 'done' || status === 'cancelled') return false;
  return deadline < new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// PipelineStat
// ---------------------------------------------------------------------------
function PipelineStat({ orders }: { orders: ProductionOrder[] }) {
  const total = orders.length;
  if (total === 0) return null;
  const newCount = orders.filter((o) => o.status === 'new').length;
  const inProgress = orders.filter((o) => o.status === 'in_progress').length;
  const done = orders.filter((o) => o.status === 'done').length;
  const cancelled = orders.filter((o) => o.status === 'cancelled').length;
  const overdueCount = orders.filter(
    (o) => o.deadline && o.status !== 'done' && o.status !== 'cancelled' &&
      o.deadline < new Date().toISOString().slice(0, 10),
  ).length;

  return (
    <div className="rounded-2xl border border-border/50 bg-card px-5 pt-4 pb-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Umumiy holat
        </p>
        <div className="flex items-center gap-2">
          {overdueCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
              <AlertCircle className="size-3" />
              {overdueCount} kechikkan
            </span>
          )}
          <span className="text-sm font-bold tabular-nums">{total} ta</span>
        </div>
      </div>

      {/* Segmented progress bar */}
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/30 gap-px">
        {done > 0 && (
          <div
            className="bg-emerald-500 transition-all"
            style={{ width: `${(done / total) * 100}%` }}
          />
        )}
        {inProgress > 0 && (
          <div
            className="bg-blue-400 transition-all"
            style={{ width: `${(inProgress / total) * 100}%` }}
          />
        )}
        {newCount > 0 && (
          <div
            className="bg-amber-400 transition-all"
            style={{ width: `${(newCount / total) * 100}%` }}
          />
        )}
        {cancelled > 0 && (
          <div
            className="bg-muted-foreground/20 transition-all"
            style={{ width: `${(cancelled / total) * 100}%` }}
          />
        )}
      </div>

      {/* 4-column stats */}
      <div className="grid grid-cols-4 divide-x divide-border/40">
        <div className="pr-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
            {newCount}
          </p>
          <p className="text-xs text-muted-foreground">Boshlash</p>
        </div>
        <div className="px-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {inProgress}
          </p>
          <p className="text-xs text-muted-foreground">Topshirildi</p>
        </div>
        <div className="px-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {done}
          </p>
          <p className="text-xs text-muted-foreground">
            Qabul qildi
            {done > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground/60">
                {Math.round((done / total) * 100)}%
              </span>
            )}
          </p>
        </div>
        <div className="pl-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-muted-foreground/70">
            {cancelled}
          </p>
          <p className="text-xs text-muted-foreground">Bekor</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubOrderRow — single sub-order inside the expandable list
// ---------------------------------------------------------------------------
function SubOrderRow({
  sub,
  unit,
  canAct,
  isBusy,
  onStart,
  onDone,
  onNavigate,
}: {
  sub: ProductionOrder;
  unit: string;
  canAct: boolean;
  isBusy: boolean;
  onStart: () => void;
  onDone: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <span
        className={`size-2 shrink-0 rounded-full ${STATUS_DOT[sub.status] ?? 'bg-muted'}`}
      />
      <button
        type="button"
        onClick={onNavigate}
        className="w-10 shrink-0 text-left text-xs font-bold text-foreground hover:underline"
      >
        #{sub.id}
      </button>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {sub.product_name}
      </span>
      <span className="shrink-0 text-xs tabular-nums font-medium">
        {formatQty(sub.qty)} {unit}
      </span>
      {canAct && sub.status === 'new' && (
        <button
          type="button"
          disabled={isBusy}
          onClick={onStart}
          className="shrink-0 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
        >
          {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Boshlash'}
        </button>
      )}
      {canAct && sub.status === 'in_progress' && (
        <button
          type="button"
          disabled={isBusy}
          onClick={onDone}
          className="shrink-0 rounded-lg bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
        >
          {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Topshirish'}
        </button>
      )}
      {(sub.status === 'done' || sub.status === 'cancelled') && (
        <button
          type="button"
          onClick={onNavigate}
          className="shrink-0 rounded-lg bg-muted/40 p-1.5 hover:bg-muted/70 transition-colors"
        >
          <Eye className="size-3 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard
// ---------------------------------------------------------------------------
function OrderCard({
  order,
  unit,
  subOrders,
  productById,
  canActOnRow,
  transition,
  busyId,
  canCreate,
  onEdit,
  onDelete,
  navigate,
}: {
  order: ProductionOrder;
  unit: string;
  subOrders: ProductionOrder[];
  productById: Map<number, Product>;
  canActOnRow: (loc: number | null | undefined) => boolean;
  transition: (id: number, s: 'in_progress' | 'done' | 'cancelled') => Promise<void>;
  busyId: number | null;
  canCreate: boolean;
  onEdit: () => void;
  onDelete: () => void;
  navigate: (p: string) => void;
}) {
  const [subOpen, setSubOpen] = useState(
    subOrders.some((s) => s.status !== 'done' && s.status !== 'cancelled'),
  );
  const isBusy = busyId === order.id;
  const canAct = canActOnRow(order.location_id);
  const overdue = isOverdue(order.deadline, order.status);
  const doneSubCount = subOrders.filter((s) => s.status === 'done').length;
  const isCancelled = order.status === 'cancelled';

  const dotClass = STATUS_DOT[order.status] ?? 'bg-muted';
  const ringClass = STATUS_RING[order.status] ?? 'ring-border';

  return (
    <div
      className={`rounded-2xl border border-border/40 bg-card shadow-sm hover:shadow-md transition-shadow overflow-hidden ${isCancelled ? 'opacity-55' : ''}`}
    >
      {/* Card header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => navigate(`/production-orders/${order.id}`)}
      >
        {/* Status dot with ring */}
        <div className="mt-0.5 shrink-0">
          <span
            className={`flex size-4 items-center justify-center rounded-full ring-4 ${dotClass} ${ringClass}`}
          />
        </div>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-mono text-muted-foreground">#{order.id}</span>
            {order.parent_production_order_id != null && (
              <span className="text-[10px] text-muted-foreground/60">
                ↳ #{order.parent_production_order_id}
              </span>
            )}
          </div>
          <p className="text-[15px] font-bold leading-snug">{order.product_name}</p>
          <p className="text-xs text-muted-foreground">{order.location_name}</p>
        </div>

        {/* Right: qty + deadline */}
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold tabular-nums leading-tight">
            {formatQty(order.qty)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
          </p>
          {order.deadline && (
            <p
              className={`text-xs ${overdue ? 'text-red-500 dark:text-red-400 font-semibold' : 'text-muted-foreground'}`}
            >
              {overdue ? '⚠ ' : ''}
              {order.deadline}
            </p>
          )}
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">
            {PRODUCTION_ORDER_STATUS_LABELS[order.status]}
          </p>
        </div>
      </div>

      {/* Sub-order progress bar */}
      {subOrders.length > 0 && (
        <div className="mx-4 mb-3 space-y-1">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted/40">
            <div
              className="bg-emerald-500 transition-all"
              style={{ width: `${(doneSubCount / subOrders.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Sub-orders collapsible */}
      {subOrders.length > 0 && (
        <div className="border-t border-border/20">
          <button
            type="button"
            onClick={() => setSubOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted/20 transition-colors"
          >
            {subOpen ? (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">
              {doneSubCount}/{subOrders.length} ta zagatovka
            </span>
            {subOrders.some(
              (s) => s.status !== 'done' && s.status !== 'cancelled',
            ) && (
              <span className="ml-auto inline-flex size-2 rounded-full bg-amber-400" />
            )}
          </button>
          {subOpen && (
            <div className="mx-3 mb-3 overflow-hidden rounded-xl bg-muted/25 divide-y divide-border/20">
              {subOrders.map((sub) => {
                const subUnit = productById.get(sub.product_id)?.unit ?? '';
                const subBusy = busyId === sub.id;
                const subCanAct = canActOnRow(sub.location_id);
                return (
                  <SubOrderRow
                    key={sub.id}
                    sub={sub}
                    unit={subUnit}
                    canAct={subCanAct}
                    isBusy={subBusy}
                    onStart={() => void transition(sub.id, 'in_progress')}
                    onDone={() => void transition(sub.id, 'done')}
                    onNavigate={() => navigate(`/production-orders/${sub.id}`)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      {!isCancelled && (
        <div
          className="flex items-center gap-2 border-t border-border/20 px-4 py-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => navigate(`/production-orders/${order.id}`)}
          >
            <Eye className="size-3.5" />
            Ko'rish
          </Button>

          {canAct && order.status === 'new' && (
            <>
              <Button
                size="sm"
                className="h-7 flex-1 text-xs bg-amber-500 hover:bg-amber-600 text-white"
                disabled={isBusy}
                onClick={() => void transition(order.id, 'in_progress')}
              >
                {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Boshlash'}
              </Button>
              {canCreate && (
                <Button variant="ghost" size="sm" className="size-7 p-0" onClick={onEdit}>
                  <Pencil className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                disabled={isBusy}
                onClick={() => void transition(order.id, 'cancelled')}
              >
                ✕
              </Button>
            </>
          )}

          {canAct && order.status === 'in_progress' && (
            <>
              <Button
                size="sm"
                className="h-7 flex-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={isBusy}
                onClick={() => void transition(order.id, 'done')}
              >
                {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Topshirish'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                disabled={isBusy}
                onClick={() => void transition(order.id, 'cancelled')}
              >
                ✕
              </Button>
            </>
          )}

          {canCreate && (order.status === 'new' || order.status === 'cancelled') && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto size-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}

      {/* Cancelled — just view link */}
      {isCancelled && (
        <div
          className="flex items-center border-t border-border/20 px-4 py-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => navigate(`/production-orders/${order.id}`)}
          >
            <Eye className="size-3.5" />
            Ko'rish
          </Button>
          {canCreate && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto size-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SexSection — accordion grouping by location
// ---------------------------------------------------------------------------
function SexSection({
  locationId,
  locationName,
  dotColor,
  orders,
  ...props
}: {
  locationId: number;
  locationName: string;
  dotColor: string;
  orders: ProductionOrder[];
  productById: Map<number, Product>;
  subOrdersMap: Map<number, ProductionOrder[]>;
  canActOnRow: (loc: number | null | undefined) => boolean;
  transition: (id: number, s: 'in_progress' | 'done' | 'cancelled') => Promise<void>;
  busyId: number | null;
  canCreate: boolean;
  onEdit: (o: ProductionOrder) => void;
  onDelete: (o: ProductionOrder) => void;
  navigate: (p: string) => void;
}) {
  const activeCount = orders.filter(
    (o) => o.status !== 'done' && o.status !== 'cancelled',
  ).length;
  const doneCount = orders.filter((o) => o.status === 'done').length;
  const defaultOpen =
    activeCount > 0 || orders.some((o) => isOverdue(o.deadline, o.status));
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="space-y-1">
      {/* Section divider header */}
      <div className="flex items-center gap-3 py-1.5">
        <div className={`size-2.5 shrink-0 rounded-full ${dotColor}`} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground hover:text-foreground/80 transition-colors"
        >
          {locationName}
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
        </button>
        <div className="h-px flex-1 bg-border/30" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {doneCount}/{orders.length}
        </span>
        {activeCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
            {activeCount} aktiv
          </span>
        )}
      </div>

      {/* Cards */}
      {open && (
        <div className="space-y-2 pl-5 pb-3">
          {orders.map((order) => {
            const unit = props.productById.get(order.product_id)?.unit ?? '';
            const subOrders = props.subOrdersMap.get(order.id) ?? [];
            return (
              <OrderCard
                key={order.id}
                order={order}
                unit={unit}
                subOrders={subOrders}
                productById={props.productById}
                canActOnRow={props.canActOnRow}
                transition={props.transition}
                busyId={props.busyId}
                canCreate={props.canCreate}
                onEdit={() => props.onEdit(order)}
                onDelete={() => props.onDelete(order)}
                navigate={props.navigate}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanCard  (for production_manager)
// ---------------------------------------------------------------------------
function KanbanCard({
  order,
  unit,
  isBusy,
  canAct,
  subOrders,
  onStart,
  onComplete,
  onNavigate,
}: {
  order: ProductionOrder;
  unit: string;
  isBusy: boolean;
  canAct: boolean;
  subOrders: ProductionOrder[];
  onStart: () => void;
  onComplete: () => void;
  onNavigate: () => void;
}) {
  const overdue = isOverdue(order.deadline, order.status);
  const doneSubCount = subOrders.filter((s) => s.status === 'done').length;
  const accentBar =
    order.status === 'new'
      ? 'bg-amber-400'
      : order.status === 'in_progress'
      ? 'bg-blue-400'
      : 'bg-emerald-500';

  return (
    <div
      className="group relative flex flex-col gap-2 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm cursor-pointer hover:shadow-md transition-shadow"
      onClick={onNavigate}
    >
      <div className={`h-1 w-full ${accentBar}`} />
      <div className="flex flex-col gap-2 px-3 pb-3">
        <div>
          <p className="text-[11px] text-muted-foreground">#{order.id}</p>
          <p className="font-semibold text-sm leading-snug">{order.product_name}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatQty(order.qty)} {unit}
          </p>
        </div>
        {order.deadline && (
          <p className={`text-xs font-medium ${overdue ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'}`}>
            {overdue ? '⚠ ' : ''}Muddat: {order.deadline}
          </p>
        )}
        {subOrders.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-muted/50">
              <div
                className="h-1 rounded-full bg-emerald-500"
                style={{ width: `${(doneSubCount / subOrders.length) * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {doneSubCount}/{subOrders.length}
            </span>
          </div>
        )}
        <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {canAct && order.status === 'new' && (
            <Button
              size="sm"
              className="h-7 flex-1 text-xs bg-amber-500 hover:bg-amber-600 text-white"
              disabled={isBusy}
              onClick={onStart}
            >
              {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Boshlash'}
            </Button>
          )}
          {canAct && order.status === 'in_progress' && (
            <Button
              size="sm"
              className="h-7 flex-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={isBusy}
              onClick={onComplete}
            >
              {isBusy ? <Loader2 className="size-3 animate-spin" /> : 'Topshirish'}
            </Button>
          )}
          {order.status === 'done' && (
            <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={onNavigate}>
              <Eye className="size-3" />
              Ko'rish
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanView (for production_manager)
// ---------------------------------------------------------------------------
function KanbanView({
  rows,
  productById,
  canActOnRow,
  transition,
  navigate,
  busyId,
  subOrdersMap,
}: {
  rows: ProductionOrder[];
  productById: Map<number, Product>;
  canActOnRow: (locationId: number | null | undefined) => boolean;
  transition: (id: number, status: 'in_progress' | 'done' | 'cancelled') => Promise<void>;
  navigate: (path: string) => void;
  busyId: number | null;
  subOrdersMap: Map<number, ProductionOrder[]>;
}) {
  const [cancelledOpen, setCancelledOpen] = useState(false);
  const topLevel = rows.filter((r) => r.parent_production_order_id == null);
  const newOrders = topLevel.filter((r) => r.status === 'new');
  const inProgress = topLevel.filter((r) => r.status === 'in_progress');
  const done = topLevel.filter((r) => r.status === 'done');
  const cancelled = topLevel.filter((r) => r.status === 'cancelled');

  const columns = [
    { key: 'new', label: 'Boshlash', items: newOrders, color: 'text-amber-600 dark:text-amber-400' },
    { key: 'in_progress', label: 'Topshirildi', items: inProgress, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'done', label: 'Qabul qildi', items: done, color: 'text-emerald-600 dark:text-emerald-400' },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {columns.map((col) => (
          <div key={col.key} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h3 className={`text-sm font-semibold ${col.color}`}>{col.label}</h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                {col.items.length}
              </span>
            </div>
            {col.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                Bo'sh
              </div>
            ) : (
              col.items.map((order) => {
                const unit = productById.get(order.product_id)?.unit ?? '';
                return (
                  <KanbanCard
                    key={order.id}
                    order={order}
                    unit={unit}
                    isBusy={busyId === order.id}
                    canAct={canActOnRow(order.location_id)}
                    subOrders={subOrdersMap.get(order.id) ?? []}
                    onStart={() => void transition(order.id, 'in_progress')}
                    onComplete={() => void transition(order.id, 'done')}
                    onNavigate={() => navigate(`/production-orders/${order.id}`)}
                  />
                );
              })
            )}
          </div>
        ))}
      </div>

      {cancelled.length > 0 && (
        <div className="rounded-xl border border-border/40">
          <button
            type="button"
            onClick={() => setCancelledOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted/20 transition-colors"
          >
            {cancelledOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <span className="text-muted-foreground">Bekor qilinganlar ({cancelled.length})</span>
          </button>
          {cancelledOpen && (
            <div className="grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-3">
              {cancelled.map((order) => {
                const unit = productById.get(order.product_id)?.unit ?? '';
                return (
                  <div
                    key={order.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-2 opacity-60 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => navigate(`/production-orders/${order.id}`)}
                  >
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">#{order.id}</p>
                      <p className="truncate text-xs font-medium">{order.product_name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatQty(order.qty)} {unit}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function ProductionOrdersPage() {
  const navigate = useNavigate();
  const { isReadOnly, isOperator, canActOn } = useCanAct();
  const { user } = useAuth();
  const isPm = user?.role === 'pm' || user?.role === 'super_admin';
  const isProdManager = user?.role === 'production_manager';
  const myLocationId = isProdManager ? (user?.location_id ?? null) : null;
  const canCreate = isOperator || isPm;
  const canActOnRow = (locationId: number | null | undefined) =>
    isPm || canActOn(locationId);

  const { notify } = useToast();
  const [status, setStatus] = useState<ProductionOrderStatus | ''>('');
  const [selectedSexId, setSelectedSexId] = useState<number | null>(myLocationId);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProductionOrder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductionOrder | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const path = (() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (dateFrom) params.set('from_date', dateFrom);
    if (dateTo) params.set('to_date', dateTo);
    return `/api/production-orders${params.toString() ? '?' + params.toString() : ''}`;
  })();
  const { data, isLoading, error, refetch } = useApiQuery<ProductionOrder[]>(path);

  const products = useApiQuery<Product[]>('/api/products');
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  async function transition(
    orderId: number,
    nextStatus: 'in_progress' | 'done' | 'cancelled',
  ): Promise<void> {
    setActionError(null);
    setBusyId(orderId);
    try {
      await apiRequest(`/api/production-orders/${orderId}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      notify('success', `Zayafka holati: ${PRODUCTION_ORDER_STATUS_LABELS[nextStatus]}.`);
      // Reset status filter so the transitioned order stays visible in the list.
      setStatus('');
      refetch();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setActionError(
          "BOM komponentlari yetarli emas — avval xom-ashyoni to'ldiring.",
        );
      } else {
        setActionError(err instanceof ApiError ? err.message : "Amalni bajarib bo'lmadi.");
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await apiRequest(`/api/production-orders/${deleteTarget.id}`, { method: 'DELETE' });
      notify('success', "Zayavka o'chirildi.");
      setDeleteTarget(null);
      refetch();
    } catch (err: unknown) {
      setActionError(err instanceof ApiError ? err.message : "O'chirib bo'lmadi.");
    } finally {
      setIsDeleting(false);
    }
  }

  const rows = data ?? [];

  // Sex chips — for pm/operator (not production_manager)
  const sexChips = useMemo(() => {
    if (myLocationId !== null) return [];
    const seen = new Map<number, string>();
    for (const row of rows) seen.set(row.location_id, row.location_name);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, myLocationId]);

  const effectiveSexId = myLocationId ?? selectedSexId;
  const filteredRows =
    effectiveSexId !== null ? rows.filter((r) => r.location_id === effectiveSexId) : rows;

  const subOrdersMap = useMemo(() => {
    const m = new Map<number, ProductionOrder[]>();
    for (const r of filteredRows) {
      if (r.parent_production_order_id != null) {
        const list = m.get(r.parent_production_order_id) ?? [];
        list.push(r);
        m.set(r.parent_production_order_id, list);
      }
    }
    return m;
  }, [filteredRows]);

  // Group by location for non-production_manager view.
  // When no sex filter: only top-level orders are grouped (sub-orders appear nested inside parent cards).
  // When a sex is selected: all orders (incl. sub-orders) are shown so workers see their full task list.
  // Exception: sub-orders whose parent is NOT in filteredRows (e.g. status-filtered view where parent
  // has a different status) are shown as standalone items so they don't disappear from the list.
  const sexGroups = useMemo(() => {
    const map = new Map<number, { locationName: string; orders: ProductionOrder[] }>();
    const filteredIds = new Set(filteredRows.map((r) => r.id));
    const rowsToGroup =
      effectiveSexId !== null
        ? filteredRows
        : filteredRows.filter(
            (r) =>
              r.parent_production_order_id == null ||
              !filteredIds.has(r.parent_production_order_id),
          );
    for (const row of rowsToGroup) {
      const existing = map.get(row.location_id);
      if (existing) {
        existing.orders.push(row);
      } else {
        map.set(row.location_id, { locationName: row.location_name, orders: [row] });
      }
    }
    return [...map.entries()]
      .map(([id, { locationName, orders }]) => ({ id, locationName, orders }))
      .sort((a, b) => a.locationName.localeCompare(b.locationName));
  }, [filteredRows, effectiveSexId]);

  const sharedCardProps = {
    productById,
    subOrdersMap,
    canActOnRow,
    transition,
    busyId,
    canCreate,
    onEdit: (o: ProductionOrder) => setEditTarget(o),
    onDelete: (o: ProductionOrder) => setDeleteTarget(o),
    navigate: (p: string) => navigate(p),
  };

  return (
    <div className="mx-auto max-w-[90rem] space-y-5">
      <PageHeader
        title="Ishlab chiqarish zayafkalari"
        description="Zayafkalar holati va zagatovkalar."
        action={
          <div className="flex items-center gap-2">
            {isReadOnly && !canCreate && (
              <Badge variant="secondary">Faqat o'qish</Badge>
            )}
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" />
                Yangi zayafka
              </Button>
            )}
          </div>
        }
      />

      {/* Filter bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Holat:</span>
            {/* "Boshlash" = default all-orders view (no status filter) */}
            <button
              onClick={() => setStatus('')}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                status === ''
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Boshlash
            </button>
            {/* "Topshirildi" and "Qabul qildi" filter by their statuses; "new" removed since Boshlash covers all */}
            {PRODUCTION_ORDER_STATUS_OPTIONS.filter(
              (o) => o.value !== 'cancelled' && o.value !== 'new',
            ).map((o) => (
              <button
                key={o.value}
                onClick={() =>
                  setStatus(status === o.value ? '' : (o.value as ProductionOrderStatus))
                }
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  status === o.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-7 rounded-lg border border-border bg-background px-2 text-xs"
            />
            <span className="text-xs text-muted-foreground">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-7 rounded-lg border border-border bg-background px-2 text-xs"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(''); setDateTo(''); }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Sex chips — pm/operator only */}
        {sexChips.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Sex:</span>
            <button
              onClick={() => setSelectedSexId(null)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedSexId === null
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Barchasi ({rows.length})
            </button>
            {sexChips.map((chip, idx) => {
              const count = rows.filter((r) => r.location_id === chip.id).length;
              const dotCls = getDotColor(idx);
              return (
                <button
                  key={chip.id}
                  onClick={() =>
                    setSelectedSexId(selectedSexId === chip.id ? null : chip.id)
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    selectedSexId === chip.id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${selectedSexId === chip.id ? 'bg-primary-foreground' : dotCls}`} />
                  {chip.name} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* production_manager locked badge */}
        {myLocationId !== null && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
              {rows.find((r) => r.location_id === myLocationId)?.location_name ??
                `Sex #${myLocationId}`}{' '}
              — faqat mening sexim
            </span>
          </div>
        )}
      </div>

      {actionError && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="size-4 shrink-0" />
          {actionError}
        </p>
      )}

      {/* Loading / error states */}
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && filteredRows.length === 0 && (
        <EmptyState message="Zayafkalar topilmadi." />
      )}

      {!isLoading && !error && filteredRows.length > 0 && (
        <>
          {/* PipelineStat — always shown */}
          <PipelineStat orders={filteredRows} />

          {/* Production manager — Kanban */}
          {isProdManager ? (
            <KanbanView
              rows={filteredRows}
              productById={productById}
              canActOnRow={canActOnRow}
              transition={transition}
              navigate={navigate}
              busyId={busyId}
              subOrdersMap={subOrdersMap}
            />
          ) : (
            /* PM / Admin — grouped by sex with accordion */
            <div className="space-y-4">
              {sexGroups.map((group, idx) => (
                <SexSection
                  key={group.id}
                  locationId={group.id}
                  locationName={group.locationName}
                  dotColor={getDotColor(idx)}
                  orders={group.orders}
                  {...sharedCardProps}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Dialogs */}
      {canCreate && (
        <ProductionOrderFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          onSaved={refetch}
        />
      )}

      <ProductionOrderFormDialog
        open={editTarget !== null}
        onOpenChange={(o) => { if (!o) setEditTarget(null); }}
        products={products.data ?? []}
        editOrder={editTarget ?? undefined}
        onSaved={() => { setEditTarget(null); refetch(); }}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      >
        <DialogContent className="sm:max-w-sm">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-6 text-destructive" />
          </div>
          <div className="mt-2">
            <DialogTitle className="text-base font-semibold">Zayavkani o'chirish</DialogTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              #{deleteTarget?.id} —{' '}
              <span className="font-medium text-foreground">{deleteTarget?.product_name}</span>{' '}
              zayavkasini o'chirmoqchimisiz?
            </p>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Bekor qilish
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              O'chirish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
