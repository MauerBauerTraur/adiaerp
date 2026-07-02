import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  PackageCheck,
  Send,
  Truck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterPopover, type FilterValue } from '@/components/ui/filter-popover';
import { LoadingState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { DailyDispatchResponse, ProductionDispatch } from '@/lib/types';
import { fmtQty } from './BomTree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canDispatchItem(
  item: ProductionDispatch,
  isWarehouse: boolean,
  isProdManager: boolean,
): boolean {
  const fromType = item.from_location_type;
  if (fromType === 'raw_warehouse' || fromType == null) return isWarehouse;
  return isProdManager;
}

type DispatchGroup = {
  locationId: number | null;
  locationName: string;
  items: ProductionDispatch[];
};

function groupByLocation(items: ProductionDispatch[]): DispatchGroup[] {
  const map = new Map<string, DispatchGroup>();
  for (const item of items) {
    const key = String(item.to_location_id ?? '__null__');
    if (!map.has(key)) {
      map.set(key, {
        locationId: item.to_location_id ?? null,
        locationName:
          item.to_location_name ??
          (item.to_location_id ? `Sex #${item.to_location_id}` : "Noma'lum sex"),
        items: [],
      });
    }
    map.get(key)!.items.push(item);
  }
  return [...map.values()].sort((a, b) => a.locationName.localeCompare(b.locationName));
}

type ProductGroup = {
  productName: string;
  productUnit: string;
  totalQty: number;
  items: ProductionDispatch[];
};

function groupByProduct(items: ProductionDispatch[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  for (const item of items) {
    const key = item.product_name;
    if (!map.has(key)) {
      map.set(key, {
        productName: item.product_name,
        productUnit: item.product_unit,
        totalQty: 0,
        items: [],
      });
    }
    const g = map.get(key)!;
    g.totalQty += item.qty_needed;
    g.items.push(item);
  }
  return [...map.values()].sort((a, b) => a.productName.localeCompare(b.productName));
}

// ---------------------------------------------------------------------------
// StatusChip — dot + label, minimal
// ---------------------------------------------------------------------------
type StatusKey = ProductionDispatch['status'] | 'mixed';

const STATUS_CFG: Record<StatusKey, { dot: string; text: string; label: string }> = {
  pending: {
    dot: 'bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    label: 'Kutilmoqda',
  },
  dispatched: {
    dot: 'bg-blue-400',
    text: 'text-blue-600 dark:text-blue-400',
    label: 'Berildi',
  },
  received: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    label: 'Qabul qilindi',
  },
  mixed: {
    dot: 'bg-violet-400',
    text: 'text-violet-600 dark:text-violet-400',
    label: 'Aralash',
  },
};

function StatusChip({ status }: { status: StatusKey }) {
  const cfg = STATUS_CFG[status] ?? STATUS_CFG.mixed;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PipelineStat — segmented bar dashboard card (clickable status filter)
// ---------------------------------------------------------------------------
type StatusFilter = 'pending' | 'dispatched' | 'received' | null;

function PipelineStat({
  items,
  statusFilter,
  onStatusFilter,
}: {
  items: ProductionDispatch[];
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
}) {
  const pending    = items.filter((i) => i.status === 'pending').length;
  const dispatched = items.filter((i) => i.status === 'dispatched').length;
  const received   = items.filter((i) => i.status === 'received').length;
  const total = items.length;
  if (total === 0) return null;

  const pPending    = (pending / total) * 100;
  const pDispatched = (dispatched / total) * 100;
  const pReceived   = (received / total) * 100;

  function toggle(s: 'pending' | 'dispatched' | 'received') {
    onStatusFilter(statusFilter === s ? null : s);
  }

  const colBase =
    'flex-1 cursor-pointer rounded-xl px-3 py-2.5 text-left transition-all select-none';
  const colActive = (active: boolean, ring: string) =>
    active ? `${ring} ring-2 ring-offset-1` : 'hover:bg-muted/40';

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Bugungi holat
        </p>
        <span className="text-sm font-bold tabular-nums">{total} ta pozitsiya</span>
      </div>

      {/* Segmented progress bar */}
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/30" style={{ gap: '2px' }}>
        {received > 0 && (
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-700"
            style={{ width: `${pReceived}%` }}
          />
        )}
        {dispatched > 0 && (
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-700"
            style={{ width: `${pDispatched}%` }}
          />
        )}
        {pending > 0 && (
          <div
            className="h-full rounded-full bg-amber-400 transition-all duration-700"
            style={{ width: `${pPending}%` }}
          />
        )}
      </div>

      {/* 3 clickable stat columns */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => toggle('pending')}
          className={`${colBase} space-y-0.5 ${colActive(statusFilter === 'pending', 'ring-amber-400 bg-amber-50 dark:bg-amber-950/30')}`}
        >
          <p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
            {pending}
          </p>
          <p className="text-xs text-muted-foreground">Kutilmoqda</p>
        </button>

        <button
          type="button"
          onClick={() => toggle('dispatched')}
          className={`${colBase} space-y-0.5 ${colActive(statusFilter === 'dispatched', 'ring-blue-400 bg-blue-50 dark:bg-blue-950/30')}`}
        >
          <p className="text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {dispatched}
          </p>
          <p className="text-xs text-muted-foreground">Berildi</p>
        </button>

        <button
          type="button"
          onClick={() => toggle('received')}
          className={`${colBase} space-y-0.5 ${colActive(statusFilter === 'received', 'ring-emerald-500 bg-emerald-50 dark:bg-emerald-950/30')}`}
        >
          <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {received}
          </p>
          <p className="text-xs text-muted-foreground">Qabul qilindi</p>
          {received > 0 && (
            <p className="text-[10px] tabular-nums text-muted-foreground/60">
              {Math.round(pReceived)}% tayyor
            </p>
          )}
        </button>
      </div>

      {statusFilter !== null && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">{STATUS_CFG[statusFilter].label}</span> filtri faol — bekor qilish uchun qayta bosing
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiBatchDispatch(ids: number[]): Promise<number> {
  const result = await apiRequest<{ dispatched: number }>(
    '/api/production-orders/dispatches/batch-dispatch',
    { method: 'PATCH', body: { ids } },
  );
  return result.dispatched;
}

async function apiBatchReceive(ids: number[]): Promise<number> {
  const result = await apiRequest<{ received: number }>(
    '/api/production-orders/dispatches/batch-receive',
    { method: 'PATCH', body: { ids } },
  );
  return result.received;
}

// ---------------------------------------------------------------------------
// ProductRow — compact list row with expandable sub-items
// ---------------------------------------------------------------------------
function ProductRow({
  group,
  isWarehouse,
  isProdManager,
  canReceive,
  orderById,
  busyItem,
  onDispatch,
  onReceive,
}: {
  group: ProductGroup;
  isWarehouse: boolean;
  isProdManager: boolean;
  canReceive: boolean;
  orderById: Map<number, { product_name: string }>;
  busyItem: number | null;
  onDispatch: (ids: number[]) => void;
  onReceive: (ids: number[]) => void;
}) {
  const hasMultiple = group.items.length > 1;
  const allReceived = group.items.every((i) => i.status === 'received');
  const [expanded, setExpanded] = useState(false);

  const pendingIds = group.items
    .filter((i) => i.status === 'pending' && canDispatchItem(i, isWarehouse, isProdManager))
    .map((i) => i.id);
  const dispatchedIds = group.items.filter((i) => i.status === 'dispatched').map((i) => i.id);

  const statuses = new Set(group.items.map((i) => i.status));
  const combinedStatus: StatusKey =
    statuses.size === 1 ? ([...statuses][0] as ProductionDispatch['status']) : 'mixed';

  const singleItem = !hasMultiple ? group.items[0]! : null;
  const singleOrderName = singleItem
    ? orderById.get(singleItem.production_order_id)?.product_name
    : null;

  return (
    <div className={`transition-opacity ${allReceived ? 'opacity-45' : ''}`}>
      {/* Main row */}
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/30 transition-colors">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => hasMultiple && setExpanded((e) => !e)}
          className={`size-5 shrink-0 flex items-center justify-center text-muted-foreground ${hasMultiple ? 'hover:text-foreground' : 'cursor-default'}`}
        >
          {hasMultiple ? (
            expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
          ) : (
            <span className="size-1.5 rounded-full bg-border/60" />
          )}
        </button>

        {/* Name */}
        <span className={`flex-1 min-w-0 truncate text-sm font-medium ${allReceived ? 'line-through text-muted-foreground' : ''}`}>
          {group.productName}
        </span>

        {/* Status */}
        <StatusChip status={combinedStatus} />

        {/* Orders count badge */}
        {hasMultiple && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted transition-colors"
          >
            {group.items.length} ta
          </button>
        )}

        {/* Total qty */}
        <span className="shrink-0 w-20 text-right text-sm font-bold tabular-nums">
          {fmtQty(group.totalQty, group.productUnit)}
        </span>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {isWarehouse && pendingIds.length > 0 && (
            <button
              onClick={() => onDispatch(pendingIds)}
              disabled={busyItem === -1 || pendingIds.some((id) => busyItem === id)}
              className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
            >
              {(busyItem === -1 || pendingIds.some((id) => busyItem === id)) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Send className="size-3" />
              )}
              {hasMultiple ? `(${pendingIds.length})` : 'Berildi'}
            </button>
          )}
          {canReceive && dispatchedIds.length > 0 && (
            <button
              onClick={() => onReceive(dispatchedIds)}
              disabled={busyItem === -1 || dispatchedIds.some((id) => busyItem === id)}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
            >
              {(busyItem === -1 || dispatchedIds.some((id) => busyItem === id)) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <PackageCheck className="size-3" />
              )}
              {hasMultiple ? `(${dispatchedIds.length})` : 'Qabul'}
            </button>
          )}
        </div>
      </div>

      {/* Single order link */}
      {!hasMultiple && (
        <div className="ml-7 pb-0.5">
          <Link
            to={`/production-orders/${singleItem!.production_order_id}`}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            #{singleItem!.production_order_id}
            {singleOrderName && <span className="opacity-60"> · {singleOrderName}</span>}
          </Link>
        </div>
      )}

      {/* Expanded sub-items */}
      {hasMultiple && expanded && (
        <div className="ml-7 mb-1 divide-y divide-border/20 overflow-hidden rounded-lg bg-muted/20">
          {group.items.map((item) => {
            const isBusy = busyItem === item.id;
            const isReceived = item.status === 'received';
            const isDispatched = item.status === 'dispatched';
            const isPending = item.status === 'pending';
            const dotColor = isReceived
              ? 'bg-emerald-500'
              : isDispatched
              ? 'bg-blue-400'
              : 'bg-amber-400';
            const orderName = orderById.get(item.production_order_id)?.product_name;

            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 px-2.5 py-1.5 ${isReceived ? 'opacity-45' : ''}`}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${dotColor}`} />
                <Link
                  to={`/production-orders/${item.production_order_id}`}
                  className="w-9 shrink-0 text-xs font-bold text-foreground hover:underline"
                >
                  #{item.production_order_id}
                </Link>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {orderName ?? '—'}
                </span>
                <span className="shrink-0 text-xs font-medium tabular-nums">
                  {fmtQty(item.qty_needed, item.product_unit)}
                </span>
                <div className="w-6 shrink-0 text-right">
                  {isPending && canDispatchItem(item, isWarehouse, isProdManager) && (
                    <button
                      disabled={isBusy}
                      onClick={() => onDispatch([item.id])}
                      title="Berildi"
                      className="inline-flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="size-2.5 animate-spin" /> : <Send className="size-2.5" />}
                    </button>
                  )}
                  {isDispatched && canReceive && (
                    <button
                      disabled={isBusy}
                      onClick={() => onReceive([item.id])}
                      title="Qabul"
                      className="inline-flex size-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="size-2.5 animate-spin" /> : <PackageCheck className="size-2.5" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SexSection — divider-style header, product cards inside
// ---------------------------------------------------------------------------
function SexSection({
  group,
  isWarehouse,
  isProdManager,
  canReceive,
  orderById,
  onChanged,
}: {
  group: DispatchGroup;
  isWarehouse: boolean;
  isProdManager: boolean;
  canReceive: boolean;
  orderById: Map<number, { product_name: string }>;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [busyItem, setBusyItem] = useState<number | null>(null);

  const allReceived = group.items.every((i) => i.status === 'received');
  const hasPending = group.items.some((i) => i.status === 'pending');
  const [open, setOpen] = useState(!allReceived);

  const pendingIds = group.items
    .filter((i) => i.status === 'pending' && canDispatchItem(i, isWarehouse, isProdManager))
    .map((i) => i.id);
  const dispatchedIds = group.items.filter((i) => i.status === 'dispatched').map((i) => i.id);

  const receivedCount = group.items.filter((i) => i.status === 'received').length;
  const total = group.items.length;

  const dotColor = allReceived
    ? 'bg-emerald-500'
    : hasPending
    ? 'bg-amber-400'
    : 'bg-blue-400';

  const productGroups = useMemo(() => groupByProduct(group.items), [group.items]);

  async function handleDispatch(ids: number[]) {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      setBusyItem(ids[0]!);
      try {
        await apiRequest(`/api/production-orders/dispatches/${ids[0]}/dispatch`, {
          method: 'PATCH',
        });
        notify('success', 'Berildi deb belgilandi.');
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    } else {
      setBusyItem(-1);
      try {
        const count = await apiBatchDispatch(ids);
        notify('success', `${count} ta material "berildi" deb belgilandi.`);
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    }
  }

  async function handleReceive(ids: number[]) {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      setBusyItem(ids[0]!);
      try {
        await apiRequest(`/api/production-orders/dispatches/${ids[0]}/receive`, {
          method: 'PATCH',
        });
        notify('success', 'Qabul qilindi. Ombordan ayrildi.');
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    } else {
      setBusyItem(-1);
      try {
        const count = await apiBatchReceive(ids);
        notify('success', `${count} ta material qabul qilindi. Ombordan ayrildi.`);
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    }
  }

  return (
    <div className={`transition-opacity ${allReceived ? 'opacity-55' : ''}`}>
      {/* Divider-style section header */}
      <div className="flex items-center gap-3 py-1.5">
        {/* Status dot */}
        <div className={`size-2.5 shrink-0 rounded-full ${dotColor}`} />

        {/* Sex name + toggle */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex shrink-0 items-center gap-1.5 text-sm font-bold hover:text-primary transition-colors"
        >
          {group.locationName}
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
        </button>

        {/* Horizontal rule */}
        <div className="h-px flex-1 bg-border/30" />

        {/* Count */}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {receivedCount}/{total}
        </span>

        {/* Bulk action or done indicator */}
        {allReceived ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Hammasi tayyor
          </span>
        ) : isWarehouse && pendingIds.length > 0 ? (
          <button
            onClick={() => void handleDispatch(pendingIds)}
            disabled={busyItem === -1}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
          >
            {busyItem === -1 ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Send className="size-3" />
            )}
            Hammasi berildi ({pendingIds.length})
          </button>
        ) : canReceive && dispatchedIds.length > 0 ? (
          <button
            onClick={() => void handleReceive(dispatchedIds)}
            disabled={busyItem === -1}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
          >
            {busyItem === -1 ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <PackageCheck className="size-3" />
            )}
            Hammasi qabul ({dispatchedIds.length})
          </button>
        ) : null}
      </div>

      {/* Product rows */}
      {open && (
        <div className="pl-5 pb-3 pt-1">
          {productGroups.map((pg) => (
            <ProductRow
              key={pg.productName}
              group={pg}
              isWarehouse={isWarehouse}
              isProdManager={isProdManager}
              canReceive={canReceive}
              orderById={orderById}
              busyItem={busyItem}
              onDispatch={handleDispatch}
              onReceive={handleReceive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProdManagerCards — flat product cards, no sex grouping
// ---------------------------------------------------------------------------
function ProdManagerCards({
  items,
  orderById,
  canReceive,
  onChanged,
}: {
  items: ProductionDispatch[];
  orderById: Map<number, { product_name: string }>;
  canReceive: boolean;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [busyItem, setBusyItem] = useState<number | null>(null);

  const productGroups = useMemo(() => groupByProduct(items), [items]);

  async function handleReceive(ids: number[]) {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      setBusyItem(ids[0]!);
      try {
        await apiRequest(`/api/production-orders/dispatches/${ids[0]}/receive`, {
          method: 'PATCH',
        });
        notify('success', 'Qabul qilindi. Ombordan ayrildi.');
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    } else {
      setBusyItem(-1);
      try {
        const count = await apiBatchReceive(ids);
        notify('success', `${count} ta material qabul qilindi. Ombordan ayrildi.`);
        onChanged();
      } catch (err: unknown) {
        notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
      } finally {
        setBusyItem(null);
      }
    }
  }

  return (
    <div>
      {productGroups.map((pg) => (
        <ProductRow
          key={pg.productName}
          group={pg}
          isWarehouse={false}
          isProdManager={true}
          canReceive={canReceive}
          orderById={orderById}
          busyItem={busyItem}
          onDispatch={() => {}}
          onReceive={handleReceive}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const PAGE_META: Record<string, { title: string; description: string }> = {
  raw:      { title: 'Xomashyo',        description: 'Xom-ashyo omboridan sexlarga beriladigan materiallar' },
  semi:     { title: 'Yarim tayyor',    description: 'Sexlar orasida ko\'chiriladigan yarim tayyor mahsulotlar' },
  finished: { title: 'Tayyor mahsulot', description: 'Sexdan markaziy omborga yoki do\'konga jo\'natiladigan tayyor mahsulotlar' },
};

export function WarehouseDispatchPage({ productTypeFilter }: { productTypeFilter?: 'raw' | 'semi' | 'finished' }) {
  const { user } = useAuth();
  const { notify } = useToast();
  const isSuperAdmin = user?.role === 'pm' || user?.role === 'super_admin';
  const isWarehouse = user?.role === 'raw_warehouse_manager' || isSuperAdmin;
  const isProdManager = user?.role === 'production_manager' || isSuperAdmin;
  const isCentralWarehouse = user?.role === 'central_warehouse_manager' || isSuperAdmin;
  // On the finished-product tab, central_warehouse_manager can receive; elsewhere only production_manager.
  const canReceive = isProdManager || (productTypeFilter === 'finished' && isCentralWarehouse);
  const myLocationId = user?.role === 'production_manager' ? (user?.location_id ?? null) : null;

  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [ordFilter, setOrdFilter] = useState<FilterValue>({ order: [] });
  const [sexFilter, setSexFilter] = useState<FilterValue>({ sex: [] });

  const { data, isLoading, refetch } = useApiQuery<DailyDispatchResponse>(
    `/api/production-orders/daily-dispatch?from=${dateFrom}&to=${dateTo}`,
  );

  const [busyBulkAll, setBusyBulkAll] = useState(false);
  const [busyReceiveAll, setBusyReceiveAll] = useState(false);
  const [busyBackfill, setBusyBackfill] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(null);

  const allDispatchItems = data?.dispatch_items ?? [];
  const selectedOrdIds = ordFilter.order ?? [];
  const selectedSexIds = sexFilter.sex ?? [];

  const dispatchItems = allDispatchItems.filter(
    (i) =>
      (myLocationId === null || i.to_location_id === myLocationId) &&
      (productTypeFilter === undefined || i.product_type === productTypeFilter) &&
      (selectedOrdIds.length === 0 || selectedOrdIds.includes(String(i.production_order_id))) &&
      (selectedSexIds.length === 0 || selectedSexIds.includes(String(i.to_location_id ?? '__null__'))) &&
      (statusFilter === null || i.status === statusFilter),
  );

  const groups = useMemo(() => groupByLocation(dispatchItems), [dispatchItems]);

  const allPendingIds = dispatchItems.filter((i) => i.status === 'pending').map((i) => i.id);
  const allDispatchedIds = dispatchItems.filter((i) => i.status === 'dispatched').map((i) => i.id);
  const allDone =
    dispatchItems.length > 0 && dispatchItems.every((i) => i.status === 'received');

  const orders = data?.orders ?? [];

  const ordOptions = useMemo(
    () =>
      orders
        .filter((o) => productTypeFilter === undefined || o.product_type === productTypeFilter)
        .map((o) => ({ value: String(o.id), label: `#${o.id} ${o.product_name}` })),
    [orders, productTypeFilter],
  );

  const sexOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of allDispatchItems) {
      const key = String(i.to_location_id ?? '__null__');
      if (!seen.has(key)) {
        seen.set(key, i.to_location_name ?? `Sex #${i.to_location_id}`);
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [allDispatchItems]);

  const orderById = useMemo(() => {
    const m = new Map<number, { product_name: string }>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  async function batchDispatchAll() {
    if (allPendingIds.length === 0) return;
    setBusyBulkAll(true);
    try {
      const count = await apiBatchDispatch(allPendingIds);
      notify('success', `${count} ta material "berildi" deb belgilandi.`);
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyBulkAll(false);
    }
  }

  async function batchReceiveAll() {
    if (allDispatchedIds.length === 0) return;
    setBusyReceiveAll(true);
    try {
      const count = await apiBatchReceive(allDispatchedIds);
      notify('success', `${count} ta material qabul qilindi. Ombordan ayrildi.`);
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyReceiveAll(false);
    }
  }

  async function backfillDispatches() {
    setBusyBackfill(true);
    try {
      const result = await apiRequest<{ orders: number; dispatch_records_created: number }>(
        `/api/production-orders/backfill-dispatches?date=${dateFrom}`,
        { method: 'POST' },
      );
      notify(
        'success',
        `${result.dispatch_records_created} ta jo'natish yozuvi yaratildi (${result.orders} ta zayavka).`,
      );
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyBackfill(false);
    }
  }

  const myLocationName =
    myLocationId !== null
      ? (allDispatchItems.find((i) => i.to_location_id === myLocationId)?.to_location_name ??
        `Sex #${myLocationId}`)
      : null;

  // Auto-trigger backfill: when orders exist for this tab but no dispatch items, create them.
  // Uses ordOptions (already filtered by productTypeFilter) and dispatchItems (also filtered).
  const autoBackfillKey = `${dateFrom}__${dateTo}__${productTypeFilter ?? ''}`;
  const autoBackfillDone = useRef<Set<string>>(new Set());
  const canBackfill = isWarehouse || isProdManager || isCentralWarehouse;
  useEffect(() => {
    if (
      !isLoading &&
      canBackfill &&
      ordOptions.length > 0 &&
      dispatchItems.length === 0 &&
      !busyBackfill &&
      !autoBackfillDone.current.has(autoBackfillKey)
    ) {
      autoBackfillDone.current.add(autoBackfillKey);
      backfillDispatches();
    }
  }, [isLoading, ordOptions.length, dispatchItems.length, autoBackfillKey, canBackfill]);

  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-5 p-4 pb-16">
      <PageHeader
        title={myLocationName
          ? `${PAGE_META[productTypeFilter ?? 'raw']?.title ?? 'Xomashyo'} — ${myLocationName}`
          : (PAGE_META[productTypeFilter ?? 'raw']?.title ?? 'Xomashyo')}
        description={
          dateFrom === dateTo && dateFrom === today
            ? PAGE_META[productTypeFilter ?? 'raw']?.description
            : `${dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`} oralig'idagi zayavkalar`
        }
        action={
          <div className="flex items-center gap-2">
            {isWarehouse && allPendingIds.length > 0 && (
              <Button onClick={batchDispatchAll} disabled={busyBulkAll} className="gap-2">
                {busyBulkAll ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Hammasini berildi ({allPendingIds.length})
              </Button>
            )}
            {canReceive && allDispatchedIds.length > 0 && (
              <Button
                onClick={batchReceiveAll}
                disabled={busyReceiveAll}
                variant="outline"
                className="gap-2"
              >
                {busyReceiveAll ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PackageCheck className="size-4" />
                )}
                Hammasini qabul ({allDispatchedIds.length})
              </Button>
            )}
            {allDone && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-4" />
                Hammasi tugallandi
              </div>
            )}
          </div>
        }
      />

      {/* Pipeline stat card — shows unfiltered totals so counts stay stable */}
      <PipelineStat
        items={allDispatchItems.filter(
          (i) =>
            (myLocationId === null || i.to_location_id === myLocationId) &&
            (productTypeFilter === undefined || i.product_type === productTypeFilter) &&
            (selectedOrdIds.length === 0 || selectedOrdIds.includes(String(i.production_order_id))) &&
            (selectedSexIds.length === 0 || selectedSexIds.includes(String(i.to_location_id ?? '__null__'))),
        )}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-card/60 px-4 py-2.5">
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Sana:</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => {
            setDateFrom(e.target.value);
            setOrdFilter({ order: [] });
            setSexFilter({ sex: [] });
            setStatusFilter(null);
          }}
          className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">—</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => {
            setDateTo(e.target.value);
            setOrdFilter({ order: [] });
            setSexFilter({ sex: [] });
            setStatusFilter(null);
          }}
          className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
        />
        {(dateFrom !== today || dateTo !== today) && (
          <button
            onClick={() => {
              setDateFrom(today);
              setDateTo(today);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Bugun
          </button>
        )}
        {ordOptions.length > 0 && <div className="h-4 w-px bg-border/50 shrink-0 mx-0.5" />}
        {ordOptions.length > 0 && (
          <FilterPopover
            triggerLabel="Zayavka"
            groups={[{ key: 'order', label: 'Zayavka', options: ordOptions, searchable: false }]}
            value={ordFilter}
            onApply={setOrdFilter}
          />
        )}
        {myLocationId === null && sexOptions.length > 1 && (
          <>
            <div className="h-4 w-px bg-border/50 shrink-0 mx-0.5" />
            <FilterPopover
              triggerLabel="Sex"
              groups={[{ key: 'sex', label: 'Sex', options: sexOptions, searchable: false }]}
              value={sexFilter}
              onApply={setSexFilter}
            />
          </>
        )}
        {myLocationId !== null && (
          <>
            <div className="h-4 w-px bg-border/50 shrink-0 mx-0.5" />
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-3 py-1 text-xs font-medium text-primary">
              <span className="size-1.5 rounded-full bg-primary" />
              {myLocationName} — faqat mening sexim
            </span>
          </>
        )}
      </div>

      {/* Content */}
      {dispatchItems.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-4 p-12 text-center text-muted-foreground">
          <Truck className="size-10 opacity-30" />
          {ordOptions.length === 0 ? (
            <p className="text-sm">Bu sana uchun faol zayavkalar yo'q.</p>
          ) : busyBackfill ? (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Jo'natish yozuvlari yaratilmoqda…
            </div>
          ) : (
            <p className="text-sm">Bu zayavkalar uchun jo'natish yozuvlari topilmadi.</p>
          )}
        </Card>
      ) : myLocationId !== null ? (
        <ProdManagerCards items={dispatchItems} orderById={orderById} canReceive={canReceive} onChanged={refetch} />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <SexSection
              key={group.locationId ?? '__null__'}
              group={group}
              isWarehouse={isWarehouse}
              isProdManager={isProdManager}
              canReceive={canReceive}
              orderById={orderById}
              onChanged={refetch}
            />
          ))}
        </div>
      )}

      {/* BOM-derived fallback */}
      {dispatchItems.length === 0 && (data?.dispatch ?? []).length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Taxminiy miqdor (BOM bo'yicha)
          </h2>
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border/60 bg-muted/30">
                <tr>
                  <th className="py-2.5 pl-4 pr-2 text-left font-medium text-muted-foreground">
                    Mahsulot
                  </th>
                  <th className="py-2.5 pl-2 pr-4 text-right font-medium text-muted-foreground">
                    Miqdor (jami)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {(data?.dispatch ?? []).map((line) => (
                  <tr key={line.product_id} className="hover:bg-muted/20">
                    <td className="py-2.5 pl-4 pr-2 font-medium">{line.product_name}</td>
                    <td className="py-2.5 pl-2 pr-4 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {fmtQty(line.qty, line.product_unit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </div>
  );
}
