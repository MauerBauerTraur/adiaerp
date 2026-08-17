import { useState, useMemo, useEffect, useRef } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PageHeader, LoadingState, ErrorState, EmptyState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { DailyDispatchResponse, ProductionDispatch, ProductionOrder } from '@/lib/types';

// ---------------------------------------------------------------------------
// Stock row type (from /api/stock)
// ---------------------------------------------------------------------------
type StockRow = {
  location_id: number;
  product_id: number;
  qty: number;
  product_name: string;
  product_unit: string;
  location_name: string;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ZTab = 'berish' | 'ombor';

type StoreGroup = {
  storeId: number | null;
  storeName: string;
  orders: ProductionOrder[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getUnit(o: ProductionOrder): string {
  return (o as unknown as Record<string, string | undefined>)['product_unit'] ?? '';
}

// Group zagotovka sub-orders by their own production location (otdel)
function groupSubsByStore(subOrders: ProductionOrder[]): StoreGroup[] {
  const map = new Map<string, StoreGroup>();
  for (const sub of subOrders) {
    const storeId = sub.location_id ?? null;
    const name = sub.location_name ?? "Noma'lum otdel";
    const key = String(storeId ?? '__null__');
    if (!map.has(key)) {
      map.set(key, { storeId, storeName: name, orders: [] });
    }
    map.get(key)!.orders.push(sub);
  }
  return [...map.values()].sort((a, b) => a.storeName.localeCompare(b.storeName));
}

// ---------------------------------------------------------------------------
// Real dispatch/receive wiring for the "Berish" tab — same
// production_dispatches endpoints WarehouseDispatchPage.tsx uses
// (apiBatchDispatch/apiBatchReceive + single dispatch/receive PATCH).
// A single "Berdim" click here represents the full handoff (berildi +
// qabul qilindi) since this tab only exposes one toggle per order.
// ---------------------------------------------------------------------------
type DispatchStatusSummary = {
  pendingIds: number[];
  dispatchedIds: number[];
  allReceived: boolean;
  hasDispatches: boolean;
};

function summarizeOrderDispatches(
  orderId: number,
  dispatchByOrderId: Map<number, ProductionDispatch[]>,
): DispatchStatusSummary {
  const rows = dispatchByOrderId.get(orderId) ?? [];
  return {
    pendingIds: rows.filter((r) => r.status === 'pending').map((r) => r.id),
    dispatchedIds: rows.filter((r) => r.status === 'dispatched').map((r) => r.id),
    allReceived: rows.length > 0 && rows.every((r) => r.status === 'received'),
    hasDispatches: rows.length > 0,
  };
}

async function apiDispatchOne(id: number): Promise<void> {
  await apiRequest(`/api/production-orders/dispatches/${id}/dispatch`, { method: 'PATCH' });
}

async function apiReceiveOne(id: number): Promise<void> {
  await apiRequest(`/api/production-orders/dispatches/${id}/receive`, { method: 'PATCH' });
}

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

/** Dispatch (if still pending) then immediately receive — see note above. */
async function dispatchAndReceive(ids: { pendingIds: number[]; dispatchedIds: number[] }): Promise<void> {
  if (ids.pendingIds.length === 1) await apiDispatchOne(ids.pendingIds[0]!);
  else if (ids.pendingIds.length > 1) await apiBatchDispatch(ids.pendingIds);

  const toReceive = [...ids.pendingIds, ...ids.dispatchedIds];
  if (toReceive.length === 1) await apiReceiveOne(toReceive[0]!);
  else if (toReceive.length > 1) await apiBatchReceive(toReceive);
}

function openStorePrint(group: StoreGroup, dateStr: string) {
  const rows = group.orders
    .map((o) => `<tr>
      <td style="padding:5px 8px;border:1px solid #ddd">${o.product_name}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;color:#666;font-size:11px">${(o as unknown as Record<string, unknown>)['parent_target_location_name'] as string ?? o.target_location_name ?? o.location_name ?? ''}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;text-align:right;font-variant-numeric:tabular-nums">${o.qty} ${getUnit(o)}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;text-align:center">&#9633;</td>
    </tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${group.storeName} — Zagotovka</title>
    <style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h2{margin:0 0 4px}p{margin:0 0 16px;color:#555;font-size:13px}table{width:100%;border-collapse:collapse;font-size:12px}th{padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left}.footer{margin-top:32px;font-size:12px;color:#555}@media print{@page{margin:10mm}}</style>
  </head><body>
    <h2>Zagotovka — ${group.storeName}</h2>
    <p>Sana: ${dateStr}</p>
    <table>
      <thead><tr>
        <th>Zagotovka</th><th>Do'kon</th><th style="text-align:right">Miqdor</th><th style="text-align:center">Berildi</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="footer"><p>Berdi: _____________________&nbsp;&nbsp;&nbsp;Qabul qildi: _____________________</p></div>
    <script>window.print();<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

function openGlobalPrint(storeGroups: StoreGroup[], dateStr: string) {
  const totalItems = storeGroups.reduce((s, g) => s + g.orders.length, 0);
  const sections = storeGroups.map((g) => {
    const rows = g.orders.map((o) => `<tr>
      <td style="padding:5px 8px;border:1px solid #ddd">${o.product_name}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;color:#666;font-size:11px">${(o as unknown as Record<string, unknown>)['parent_target_location_name'] as string ?? o.target_location_name ?? o.location_name ?? ''}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;text-align:right;font-variant-numeric:tabular-nums">${o.qty} ${getUnit(o)}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;text-align:center">&#9633;</td>
    </tr>`).join('');
    return `<div style="page-break-inside:avoid">
      <h3 style="margin:16px 0 6px;font-size:13px;font-weight:700;border-bottom:2px solid #333;padding-bottom:4px">${g.storeName}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
        <thead><tr>
          <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left">Zagotovka</th>
          <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left">Do'kon</th>
          <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:right">Miqdor</th>
          <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:center">Berildi</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Zagotovka — ${dateStr}</title>
    <style>body{font-family:Arial,sans-serif;margin:20px;color:#111}h1{font-size:16px;margin-bottom:4px}p{margin:0 0 12px;color:#555;font-size:12px}@media print{@page{size:A4;margin:10mm}}</style>
  </head><body>
    <h1>Zagotovka — ${dateStr}</h1>
    <p>Jami ${totalItems} ta zagotovka · ${storeGroups.length} ta maqsad</p>
    ${sections}
    <div style="margin-top:24px;font-size:11px;color:#555">
      <p>Berdi: _____________________&nbsp;&nbsp;Tekshirdi: _____________________&nbsp;&nbsp;Sana: ${dateStr}</p>
    </div>
    <script>window.onload=function(){window.print()}<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ---------------------------------------------------------------------------
// StoreDetail — right panel
// ---------------------------------------------------------------------------
function StoreDetail({
  group,
  dispatchByOrderId,
  stockMap,
  busyIds,
  onToggle,
  onCheckAll,
  dateStr,
  rootTargetMap,
}: {
  group: StoreGroup;
  dispatchByOrderId: Map<number, ProductionDispatch[]>;
  stockMap: Map<number, StockEntry>;
  busyIds: Set<number>;
  onToggle: (o: ProductionOrder) => void;
  onCheckAll: (orders: ProductionOrder[]) => void;
  dateStr: string;
  rootTargetMap: Map<number, string | null>;
}) {
  const checkedCount = group.orders.filter(
    (o) => summarizeOrderDispatches(o.id, dispatchByOrderId).allReceived,
  ).length;
  const allDone = checkedCount === group.orders.length && group.orders.length > 0;
  const remaining = group.orders.filter((o) => {
    const s = summarizeOrderDispatches(o.id, dispatchByOrderId);
    return !s.allReceived && s.hasDispatches;
  });

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-bold text-base">{group.storeName}</h2>
          <p className="text-xs text-muted-foreground">
            {checkedCount}/{group.orders.length} ta berildi
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openStorePrint(group, dateStr)}
            className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Printer className="size-3.5" />
            Chop etish
          </button>
          {!allDone && remaining.length > 0 && (
            <button
              type="button"
              disabled={busyIds.has(-1)}
              onClick={() => onCheckAll(remaining)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors"
            >
              {busyIds.has(-1) && <Loader2 className="size-3 animate-spin" />}
              Hammasi berildi ({remaining.length})
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden mb-4">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{
            width: `${group.orders.length > 0 ? Math.round((checkedCount / group.orders.length) * 100) : 0}%`,
          }}
        />
      </div>

      {/* Orders list */}
      <div className="space-y-1">
        {group.orders.map((o) => {
          const dispatchStatus = summarizeOrderDispatches(o.id, dispatchByOrderId);
          const isChecked = dispatchStatus.allReceived;
          const isBusy = busyIds.has(o.id) || busyIds.has(-1);
          const unit = getUnit(o);
          const ostatka = stockMap.get(o.product_id)?.totalQty ?? 0;
          return (
            <div
              key={o.id}
              className={`flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5 transition-all ${
                isChecked ? 'opacity-45 bg-muted/10' : 'bg-card hover:bg-muted/20'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground font-mono">#{o.id}</span>
                  <span
                    className={`font-semibold text-sm ${
                      isChecked ? 'line-through text-muted-foreground' : ''
                    }`}
                  >
                    {o.product_name}
                  </span>
                </div>
                {(() => {
                  const dest = o.parent_target_location_name ?? rootTargetMap.get(o.id) ?? o.target_location_name;
                  return dest ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="text-blue-500 dark:text-blue-400 font-medium">→</span>{' '}
                      {dest}
                    </p>
                  ) : null;
                })()}
              </div>
              <div className="text-right shrink-0 w-20">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Ostatka</p>
                <p className="tabular-nums text-xs font-semibold text-muted-foreground">
                  {Number.isInteger(ostatka) ? ostatka : ostatka.toFixed(2)} {unit}
                </p>
              </div>
              <span className="tabular-nums text-sm font-bold shrink-0">
                {o.qty}
                <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>
              </span>
              <button
                type="button"
                disabled={isBusy || !dispatchStatus.hasDispatches}
                title={!dispatchStatus.hasDispatches ? "Jo'natish yozuvi tayyorlanmoqda…" : undefined}
                onClick={() => onToggle(o)}
                className={`size-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 ${
                  isChecked
                    ? 'border-emerald-500 bg-emerald-500'
                    : 'border-border/60 hover:border-emerald-400'
                }`}
              >
                {isBusy ? (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                ) : (
                  isChecked && <span className="text-white text-[10px] font-bold leading-none">✓</span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {allDone && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 px-4 py-3">
          <span className="text-emerald-600 dark:text-emerald-400 text-sm font-medium">
            ✓ Barcha mahsulotlar berildi
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types for OmborTab
// ---------------------------------------------------------------------------
type StockEntry = { totalQty: number; bestLocationId: number };

type DeptGroup = {
  deptId: number;
  deptName: string;
  items: ProductionOrder[];
};

// ---------------------------------------------------------------------------
// DeptDetail — right panel for selected otdel
// ---------------------------------------------------------------------------
function DeptDetail({
  dept,
  stockMap,
  doneIds,
  busyIds,
  onGive,
  onGiveAll,
}: {
  dept: DeptGroup;
  stockMap: Map<number, StockEntry>;
  doneIds: Set<number>;
  busyIds: Set<number>;
  onGive: (o: ProductionOrder, stock: StockEntry) => void;
  onGiveAll: (items: ProductionOrder[]) => void;
}) {
  const givableItems = dept.items.filter((o) => {
    const s = stockMap.get(o.product_id);
    return (s?.totalQty ?? 0) >= o.qty && !doneIds.has(o.id);
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-bold text-base">{dept.deptName}</h2>
          <p className="text-xs text-muted-foreground">
            {dept.items.filter((o) => doneIds.has(o.id)).length}/{dept.items.length} ta berildi
          </p>
        </div>
        {givableItems.length > 1 && (
          <button
            type="button"
            onClick={() => onGiveAll(givableItems)}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors"
          >
            Hammasi ombordan ber ({givableItems.length})
          </button>
        )}
      </div>

      {/* Product rows */}
      <div className="space-y-2">
        {dept.items.map((o) => {
          const stock = stockMap.get(o.product_id);
          const available = stock?.totalQty ?? 0;
          const unit = getUnit(o);
          const canGive = available >= o.qty;
          const isDone = doneIds.has(o.id);
          const isBusy = busyIds.has(o.id);

          return (
            <div
              key={o.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-3 transition-all ${
                isDone
                  ? 'opacity-45 border-border/30 bg-muted/10'
                  : canGive
                  ? 'border-emerald-200/60 dark:border-emerald-800/30 bg-emerald-50/20 dark:bg-emerald-950/10'
                  : 'border-amber-200/60 dark:border-amber-800/30 bg-amber-50/20 dark:bg-amber-950/10'
              }`}
            >
              {/* Status dot */}
              <span
                className={`size-2 shrink-0 rounded-full ${
                  isDone ? 'bg-emerald-500' : canGive ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />

              {/* Product info */}
              <div className="flex-1 min-w-0">
                <span className={`font-semibold text-sm ${isDone ? 'line-through text-muted-foreground' : ''}`}>
                  {o.product_name}
                </span>
                <span className="ml-1.5 text-xs text-muted-foreground font-mono">#{o.id}</span>
              </div>

              {/* Needed */}
              <div className="text-right shrink-0">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kerak</p>
                <p className="text-sm font-bold tabular-nums">
                  {o.qty} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
                </p>
              </div>

              {/* Available */}
              <div className="text-right shrink-0 w-20">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Omborda</p>
                <p
                  className={`text-sm font-bold tabular-nums ${
                    canGive
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {Number.isInteger(available) ? available : available.toFixed(2)}{' '}
                  <span className="text-xs font-normal text-muted-foreground">{unit}</span>
                </p>
              </div>

              {/* Action */}
              <div className="shrink-0 w-36 text-right">
                {isDone ? (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    ✓ Ombordan berildi
                  </span>
                ) : canGive ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => stock && onGive(o, stock)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors"
                  >
                    {isBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                    Ombordan ber
                  </button>
                ) : (
                  <span className="inline-flex items-center rounded-lg bg-amber-100 dark:bg-amber-900/30 px-3 py-1.5 text-xs font-bold text-amber-700 dark:text-amber-400">
                    Ishlab chiqarish
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OmborTab — otdellar bo'yicha left/right panel
// ---------------------------------------------------------------------------
function OmborTab({
  subOrders,
  allOrders,
}: {
  subOrders: ProductionOrder[];
  allOrders: ProductionOrder[];
}) {
  const { notify } = useToast();

  const { data: stockData, isLoading: stockLoading, refetch: refetchStock } =
    useApiQuery<StockRow[]>('/api/stock');

  const parentMap = useMemo(() => {
    const m = new Map<number, ProductionOrder>();
    allOrders.forEach((o) => {
      if (o.parent_production_order_id == null) m.set(o.id, o);
    });
    return m;
  }, [allOrders]);

  // product_id → best stock location + total qty
  const stockMap = useMemo(() => {
    const m = new Map<number, StockEntry>();
    for (const s of stockData ?? []) {
      const cur = m.get(s.product_id);
      if (!cur) {
        m.set(s.product_id, { totalQty: s.qty, bestLocationId: s.location_id });
      } else {
        cur.totalQty += s.qty;
      }
    }
    return m;
  }, [stockData]);

  // Group sub-orders by parent department
  const deptGroups = useMemo((): DeptGroup[] => {
    const map = new Map<number, DeptGroup>();
    for (const sub of subOrders) {
      const parent = sub.parent_production_order_id
        ? parentMap.get(sub.parent_production_order_id)
        : null;
      const deptId = parent?.location_id ?? sub.location_id;
      const deptName = parent?.location_name ?? sub.location_name ?? "Noma'lum otdel";
      if (!map.has(deptId)) {
        map.set(deptId, { deptId, deptName, items: [] });
      }
      map.get(deptId)!.items.push(sub);
    }
    return [...map.values()].sort((a, b) => a.deptName.localeCompare(b.deptName));
  }, [subOrders, parentMap]);

  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const effectiveDeptId = selectedDeptId ?? (deptGroups[0]?.deptId ?? null);
  const selectedDept = deptGroups.find((g) => g.deptId === effectiveDeptId) ?? null;

  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());

  async function handleOmborBer(o: ProductionOrder, stock: StockEntry) {
    setBusyIds((prev) => new Set(prev).add(o.id));
    try {
      await apiRequest('/api/stock/movement', {
        method: 'POST',
        body: {
          from_location_id: stock.bestLocationId,
          product_id: o.product_id,
          qty: o.qty,
          note: `Zagotovka omboridan berish — #${o.id} ${o.product_name}`,
        },
      });
      notify('success', `${o.product_name} ombordan berildi va ayirildi.`);
      setDoneIds((prev) => new Set(prev).add(o.id));
      refetchStock();
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyIds((prev) => { const s = new Set(prev); s.delete(o.id); return s; });
    }
  }

  async function handleGiveAll(items: ProductionOrder[]) {
    for (const o of items) {
      const stock = stockMap.get(o.product_id);
      if (stock) await handleOmborBer(o, stock);
    }
  }

  if (stockLoading) return <LoadingState />;
  if (subOrders.length === 0) {
    return (
      <div className="rounded-xl border border-border/50 bg-card p-6">
        <EmptyState message="Zagotovka buyurtmalari topilmadi." />
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start">
      {/* Left: dept list */}
      <div className="w-56 shrink-0 space-y-1">
        {deptGroups.map((group) => {
          const total = group.items.length;
          const doneCount = group.items.filter((o) => doneIds.has(o.id)).length;
          const allDone = doneCount === total;
          const isSelected = effectiveDeptId === group.deptId;
          return (
            <button
              key={group.deptId}
              type="button"
              onClick={() => setSelectedDeptId(group.deptId)}
              className={`w-full text-left rounded-xl px-3 py-2.5 transition-colors border ${
                isSelected
                  ? 'bg-primary/10 border-primary/30'
                  : 'bg-card border-border/40 hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`size-2 shrink-0 rounded-full ${allDone ? 'bg-emerald-500' : 'bg-amber-400'}`}
                />
                <span
                  className={`text-sm flex-1 truncate ${
                    isSelected ? 'font-semibold text-primary' : 'font-medium'
                  }`}
                >
                  {group.deptName}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {doneCount}/{total}
                </span>
              </div>
              <div className="h-1 rounded-full bg-border/30 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    allDone ? 'bg-emerald-500' : 'bg-amber-400'
                  }`}
                  style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* Right: detail panel */}
      <div className="flex-1 min-w-0 rounded-xl border border-border/50 bg-card/60 p-4">
        {selectedDept ? (
          <DeptDetail
            key={effectiveDeptId ?? 0}
            dept={selectedDept}
            stockMap={stockMap}
            doneIds={doneIds}
            busyIds={busyIds}
            onGive={handleOmborBer}
            onGiveAll={handleGiveAll}
          />
        ) : (
          <EmptyState message="Otdelni tanlang." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZagotovkaPage
// ---------------------------------------------------------------------------
export function ZagotovkaPage() {
  const [tab, setTab] = useState<ZTab>('berish');

  // Date range filter — same pattern as WarehouseDispatchPage.tsx (a plain
  // dateFrom/dateTo pair with a "Bugun" reset), so zagotovka topshiriqlari
  // bugungi kundan boshqa sanada ham ko'rinadi (not hardcoded to "today").
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const dateLabel =
    dateFrom === dateTo
      ? (dateFrom === today
          ? `${new Date().getDate()}-${new Date().toLocaleString('uz-UZ', { month: 'long' })}`
          : dateFrom)
      : `${dateFrom} — ${dateTo}`;

  const { data: orders, isLoading, error, refetch } = useApiQuery<ProductionOrder[]>(
    `/api/production-orders?from_date=${dateFrom}&to_date=${dateTo}`,
  );

  // ADR-0016 — zagotovka sub-orders are 'semi' product-type orders hanging
  // off a parent (final) order. Filtering explicitly by product_type (not
  // just parent_production_order_id != null) excludes non-zagotovka
  // sub-orders that might share the same parent linkage shape.
  const subOrders = useMemo(
    () => (orders ?? []).filter((o) => o.parent_production_order_id != null && o.product_type === 'semi'),
    [orders],
  );

  // Real dispatch tracking (Faza 2) — same daily-dispatch endpoint
  // WarehouseDispatchPage.tsx uses, scoped to the selected date range.
  const { data: dispatchData, refetch: refetchDispatch } = useApiQuery<DailyDispatchResponse>(
    `/api/production-orders/daily-dispatch?from=${dateFrom}&to=${dateTo}`,
  );
  const dispatchByOrderId = useMemo(() => {
    const m = new Map<number, ProductionDispatch[]>();
    for (const item of dispatchData?.dispatch_items ?? []) {
      const list = m.get(item.production_order_id);
      if (list) list.push(item);
      else m.set(item.production_order_id, [item]);
    }
    return m;
  }, [dispatchData]);

  // Ostatka (current stock) — same pattern as OmborTab's stockMap below,
  // replicated here so the "Berish" tab can show it too (plan Faza 2).
  const { data: stockData } = useApiQuery<StockRow[]>('/api/stock');
  const stockMap = useMemo(() => {
    const m = new Map<number, StockEntry>();
    for (const s of stockData ?? []) {
      const cur = m.get(s.product_id);
      if (!cur) m.set(s.product_id, { totalQty: s.qty, bestLocationId: s.location_id });
      else cur.totalQty += s.qty;
    }
    return m;
  }, [stockData]);

  // Auto-backfill dispatch records for today's zagotovka sub-orders that
  // don't have any yet — same one-shot pattern WarehouseDispatchPage.tsx
  // uses so the checkboxes always have something to act on.
  const autoBackfillDone = useRef(false);
  useEffect(() => {
    if (autoBackfillDone.current) return;
    if (isLoading || subOrders.length === 0) return;
    const missing = subOrders.some((o) => !dispatchByOrderId.has(o.id));
    if (!missing) return;
    autoBackfillDone.current = true;
    // Mirrors WarehouseDispatchPage.tsx: backfill is keyed off dateFrom only
    // even in range mode (the endpoint takes a single ?date=).
    apiRequest(`/api/production-orders/backfill-dispatches?date=${dateFrom}`, { method: 'POST' })
      .then(() => refetchDispatch())
      .catch(() => { /* best-effort — checkboxes stay disabled until dispatch rows exist */ });
  }, [isLoading, subOrders, dispatchByOrderId, dateFrom, refetchDispatch]);

  // Reset auto-backfill guard whenever the selected range changes so a new
  // range gets its own one-shot backfill attempt.
  useEffect(() => {
    autoBackfillDone.current = false;
  }, [dateFrom, dateTo]);

  // Map each order ID → root GP's target_location_name (the final store/do'kon)
  const rootTargetMap = useMemo(() => {
    const allOrders = orders ?? [];
    const orderMap = new Map(allOrders.map(o => [o.id, o]));
    const result = new Map<number, string | null>();
    for (const o of allOrders) {
      let cur = o;
      const visited = new Set<number>();
      while (cur.parent_production_order_id != null && !visited.has(cur.parent_production_order_id)) {
        visited.add(cur.id);
        const par = orderMap.get(cur.parent_production_order_id);
        if (!par) break;
        cur = par;
      }
      result.set(o.id, cur.target_location_name);
    }
    return result;
  }, [orders]);

  const storeGroups = useMemo(() => groupSubsByStore(subOrders), [subOrders]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const effectiveKey =
    selectedKey ?? (storeGroups.length > 0 ? String(storeGroups[0]!.storeId ?? '__null__') : null);
  const selectedGroup =
    storeGroups.find((g) => String(g.storeId ?? '__null__') === effectiveKey) ?? null;

  const { notify } = useToast();
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  async function handleToggleOrder(o: ProductionOrder) {
    const status = summarizeOrderDispatches(o.id, dispatchByOrderId);
    if (!status.hasDispatches || status.allReceived) return;
    setBusyIds((prev) => new Set(prev).add(o.id));
    try {
      await dispatchAndReceive(status);
      notify('success', `${o.product_name} berildi.`);
      refetchDispatch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyIds((prev) => { const s = new Set(prev); s.delete(o.id); return s; });
    }
  }

  async function handleCheckAllOrders(ordersToGive: ProductionOrder[]) {
    if (ordersToGive.length === 0) return;
    setBusyIds((prev) => new Set(prev).add(-1));
    try {
      const summaries = ordersToGive.map((o) => summarizeOrderDispatches(o.id, dispatchByOrderId));
      const allPending = summaries.flatMap((s) => s.pendingIds);
      if (allPending.length > 0) await apiBatchDispatch(allPending);
      const allToReceive = summaries.flatMap((s) => [...s.pendingIds, ...s.dispatchedIds]);
      if (allToReceive.length > 0) await apiBatchReceive(allToReceive);
      notify('success', `${ordersToGive.length} ta zagotovka berildi.`);
      refetchDispatch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Amal bajarilmadi.');
    } finally {
      setBusyIds((prev) => { const s = new Set(prev); s.delete(-1); return s; });
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="Zagotovka"
        description={dateLabel}
        action={
          <div className="flex items-center gap-2">
            {storeGroups.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  openGlobalPrint(storeGroups, dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`)
                }
                className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <Printer className="size-4" />
                Chop etish
              </button>
            )}
            <div className="flex items-center overflow-hidden rounded-lg border border-border/60 text-sm">
              <button
                type="button"
                onClick={() => setTab('berish')}
                className={`px-4 py-2 font-medium transition-colors ${
                  tab === 'berish'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                Berish
              </button>
              <button
                type="button"
                onClick={() => setTab('ombor')}
                className={`px-4 py-2 font-medium transition-colors ${
                  tab === 'ombor'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                Zagotovka ombori
              </button>
            </div>
          </div>
        }
      />

      {/* Date range filter — same pattern as WarehouseDispatchPage.tsx */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-card/60 px-4 py-2.5">
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Sana:</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">—</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-7 rounded-lg border border-border bg-background px-2 text-sm"
        />
        {(dateFrom !== today || dateTo !== today) && (
          <button
            type="button"
            onClick={() => {
              setDateFrom(today);
              setDateTo(today);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Bugun
          </button>
        )}
      </div>

      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && tab === 'berish' && (
        storeGroups.length === 0 ? (
          <EmptyState
            message={
              dateFrom === today && dateTo === today
                ? 'Bugun uchun topshiriqlar topilmadi.'
                : "Tanlangan sana oralig'ida topshiriqlar topilmadi."
            }
          />
        ) : (
          <div className="flex gap-3 items-start">
            {/* Left: store list */}
            <div className="w-56 shrink-0 space-y-1">
              {storeGroups.map((group) => {
                const key = String(group.storeId ?? '__null__');
                const total = group.orders.length;
                const checked = group.orders.filter(
                  (o) => summarizeOrderDispatches(o.id, dispatchByOrderId).allReceived,
                ).length;
                const allDone = checked === total;
                const isSelected = effectiveKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={`w-full text-left rounded-xl px-3 py-2.5 transition-colors border ${
                      isSelected
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-card border-border/40 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`size-2 shrink-0 rounded-full ${allDone ? 'bg-emerald-500' : 'bg-amber-400'}`}
                      />
                      <span
                        className={`text-sm flex-1 truncate ${
                          isSelected ? 'font-semibold text-primary' : 'font-medium'
                        }`}
                      >
                        {group.storeName}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                        {checked}/{total}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-border/30 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          allDone ? 'bg-emerald-500' : 'bg-amber-400'
                        }`}
                        style={{
                          width: `${total > 0 ? Math.round((checked / total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right: detail panel */}
            <div className="flex-1 min-w-0 rounded-xl border border-border/50 bg-card/60 p-4">
              {selectedGroup ? (
                <StoreDetail
                  key={effectiveKey ?? ''}
                  group={selectedGroup}
                  dispatchByOrderId={dispatchByOrderId}
                  stockMap={stockMap}
                  busyIds={busyIds}
                  onToggle={handleToggleOrder}
                  onCheckAll={handleCheckAllOrders}
                  dateStr={dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`}
                  rootTargetMap={rootTargetMap}
                />
              ) : (
                <EmptyState message="Do'konni tanlang." />
              )}
            </div>
          </div>
        )
      )}

      {!isLoading && !error && tab === 'ombor' && (
        <OmborTab subOrders={subOrders} allOrders={orders ?? []} />
      )}
    </div>
  );
}
