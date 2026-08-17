import { useState, useMemo, useEffect, useCallback } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { LoadingState, ErrorState, EmptyState, PageHeader } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { BomNode, ProductionOrder, ProductionOrderBomResponse } from '@/lib/types';
import { DestinationContext } from './WarehouseDispatchPage';
import type { DestinationContextData } from './dispatchContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type DeptProduct = {
  subOrderId: number;
  productId: number;
  productName: string;
  productUnit: string;
  qty: number;
  status: string;
  /** Which zayavka (parent order) this z/g product belongs to — a dept can
   * pool products from several zayavkas (see DeptGroup below). */
  parentId: number;
};

// Grouped by actual department (location), NOT by zayavka — a department
// can have several open zayavkas going at once (e.g. two orders both
// targeting "Оформления отдел"); the krem kaymokchi needs ONE combined
// view of everything that department needs, not one card per zayavka.
type DeptGroup = {
  /** Stable selection key — the department's location id (or the parent
   * order id as a fallback when location_id is somehow missing). */
  key: string;
  deptName: string;
  products: DeptProduct[];
  /** Every zayavka (parent order id) contributing products to this dept. */
  parentIds: number[];
};

// Backend embeds `product_unit` on production_orders rows but it isn't in
// the shared ProductionOrder type yet — same cast pattern ZagotovkaPage.tsx
// uses for the same reason.
function getUnit(o: ProductionOrder): string {
  return (o as unknown as Record<string, string | undefined>)['product_unit'] ?? '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : parseFloat(n.toFixed(1)).toString();
}

function openCreamPrint(groups: DeptGroup[], dateStr: string) {
  const thS = 'padding:5px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left';
  const thSR = thS + ';text-align:right';
  const thSC = thS + ';text-align:center';
  const tdS = 'padding:5px 8px;border:1px solid #ddd';
  const tdSR = tdS + ';text-align:right;font-variant-numeric:tabular-nums';
  const tdSC = tdS + ';text-align:center';

  const sections = groups.map(dept => {
    const rows = dept.products
      .sort((a, b) => a.productName.localeCompare(b.productName))
      .map(p => `<tr>
        <td style="${tdS}">${p.productName}</td>
        <td style="${tdSR}">${fmtQty(p.qty)} ${p.productUnit}</td>
        <td style="${tdSC}">&#9633;</td>
      </tr>`).join('');
    return `<div style="page-break-inside:avoid">
      <h3 style="margin:16px 0 6px;font-size:13px;font-weight:700;border-bottom:2px solid #333;padding-bottom:4px">${dept.deptName}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
        <thead><tr>
          <th style="${thS}">Krem mahsulot</th>
          <th style="${thSR}">Miqdor</th>
          <th style="${thSC}">Berildi</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Krem kaymok — ${dateStr}</title>
    <style>body{font-family:Arial,sans-serif;margin:20px;color:#111}h1{font-size:16px;margin-bottom:4px}p{margin:0 0 12px;color:#555;font-size:12px}@media print{@page{margin:10mm}}</style>
  </head><body>
    <h1>Krem kaymok — ${dateStr}</h1>
    <p>Jami ${groups.length} ta otdel</p>
    ${sections}
    <div style="margin-top:24px;font-size:11px;color:#555">
      <p>Tayyorladi: _____________________&nbsp;&nbsp;Sana: ${dateStr}</p>
    </div>
    <script>window.onload=function(){window.print()}<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ---------------------------------------------------------------------------
// IngredientList — fetches BOM lazily
// ---------------------------------------------------------------------------
function IngredientList({ orderId }: { orderId: number }) {
  const { data, isLoading, error } = useApiQuery<ProductionOrderBomResponse>(
    `/api/production-orders/${orderId}/bom`,
  );

  if (isLoading)
    return <p className="text-xs text-muted-foreground py-2">Retsept yuklanmoqda...</p>;
  if (error || !data)
    return <p className="text-xs text-amber-600 py-2">Retsept topilmadi</p>;

  const rawIngredients = data.bom.filter((b) => b.component_type === 'raw');
  if (rawIngredients.length === 0)
    return <p className="text-xs text-muted-foreground py-2">Xomashyo ro'yxati bo'sh</p>;

  return (
    <div className="space-y-1 mt-2">
      {rawIngredients.map((b) => (
        <div
          key={b.component_product_id}
          className="flex items-center justify-between rounded-lg bg-muted/20 px-3 py-1.5"
        >
          <span className="text-xs font-medium">{b.component_name}</span>
          <span className="tabular-nums text-xs font-bold">
            {fmtQty(b.qty)}
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              {b.component_unit}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeptBomFetcher — headless: fetches one sub-order's BOM and reports it up
// so DeptDetail can aggregate raw ingredients across the whole department.
// ---------------------------------------------------------------------------
function DeptBomFetcher({
  orderId,
  onLoaded,
}: {
  orderId: number;
  onLoaded: (orderId: number, bom: BomNode[]) => void;
}) {
  const { data } = useApiQuery<ProductionOrderBomResponse>(`/api/production-orders/${orderId}/bom`);
  useEffect(() => {
    if (data) onLoaded(orderId, data.bom);
  }, [data, orderId, onLoaded]);
  return null;
}

// ---------------------------------------------------------------------------
// ProductCard — single z/g product within a dept
// ---------------------------------------------------------------------------
function ProductCard({
  prod,
  isBusy,
  onFinish,
}: {
  prod: DeptProduct;
  isBusy: boolean;
  onFinish: () => void;
}) {
  const [showIngredients, setShowIngredients] = useState(false);
  const isDone = prod.status === 'done';

  return (
    <div className={`overflow-hidden rounded-xl border border-border/40 bg-card transition-opacity ${isDone ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{prod.productName}</p>
          <button
            type="button"
            onClick={() => setShowIngredients((v) => !v)}
            className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-0.5"
          >
            {showIngredients ? '▲ Xomashyo yashir' : "▼ Xomashyo ko'rsat"}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular-nums font-bold text-sm">
            {fmtQty(prod.qty)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">{prod.productUnit}</span>
          </span>
          <button
            type="button"
            disabled={isDone || isBusy}
            onClick={onFinish}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:cursor-default ${
              isDone
                ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                : 'bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-60'
            }`}
          >
            {isBusy && <Loader2 className="size-3 animate-spin" />}
            {isDone ? '✓ Berildi' : 'Berdim'}
          </button>
        </div>
      </div>
      {showIngredients && (
        <div className="border-t border-border/20 px-4 pb-3">
          <IngredientList orderId={prod.subOrderId} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeptDetail — right panel for a selected department
// ---------------------------------------------------------------------------
function DeptDetail({
  group,
  parentOrders,
  busyIds,
  onFinishOne,
  onFinishAll,
}: {
  group: DeptGroup;
  parentOrders: ProductionOrder[];
  busyIds: Set<number>;
  onFinishOne: (subOrderId: number) => void;
  onFinishAll: (subOrderIds: number[]) => void;
}) {
  // Faza 3 — dept-level aggregate raw-ingredient totals, summed across every
  // product's BOM (same /:id/bom endpoint IngredientList already calls per
  // card, just fetched once per product and merged here).
  const [bomByOrderId, setBomByOrderId] = useState<Map<number, BomNode[]>>(new Map());
  const handleBomLoaded = useCallback((orderId: number, bom: BomNode[]) => {
    setBomByOrderId((prev) => {
      if (prev.get(orderId) === bom) return prev;
      const next = new Map(prev);
      next.set(orderId, bom);
      return next;
    });
  }, []);

  const rawTotals = useMemo(() => {
    const map = new Map<string, { unit: string; qty: number }>();
    for (const bom of bomByOrderId.values()) {
      for (const line of bom) {
        if (line.component_type !== 'raw') continue;
        const cur = map.get(line.component_name);
        if (cur) cur.qty += line.qty;
        else map.set(line.component_name, { unit: line.component_unit, qty: line.qty });
      }
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bomByOrderId]);

  // Faza 1 — "this becomes that": the dept's zagotovka products feed into
  // whichever zayavka(s) (parent finished-good orders) are pooled here —
  // merge by product name so the same finished product ordered twice
  // today shows as one combined qty, not two separate entries.
  const destinationData: DestinationContextData = useMemo(() => {
    const zagotovkas = group.products.map((p) => ({
      product_name: p.productName,
      qty: p.qty,
      unit: p.productUnit,
    }));
    const finishedByName = new Map<string, DestinationContextData['finishedGoods'][number]>();
    for (const po of parentOrders) {
      const existing = finishedByName.get(po.product_name);
      if (existing) {
        existing.qty += po.qty;
      } else {
        finishedByName.set(po.product_name, {
          product_id: po.product_id,
          product_name: po.product_name,
          qty: po.qty,
          unit: getUnit(po),
          production_cost: po.production_cost ?? null,
        });
      }
    }
    return { zagotovkas, finishedGoods: [...finishedByName.values()] };
  }, [group.products, parentOrders]);

  const pendingProducts = group.products.filter((p) => p.status !== 'done');
  const doneCount = group.products.length - pendingProducts.length;

  return (
    <div className="space-y-3">
      {/* Headless BOM fetchers — one per product, feed rawTotals above */}
      {group.products.map((p) => (
        <DeptBomFetcher key={p.subOrderId} orderId={p.subOrderId} onLoaded={handleBomLoaded} />
      ))}

      {/* Header */}
      <div className="flex items-start justify-between rounded-xl bg-zinc-900 dark:bg-zinc-800 px-4 py-3">
        <div>
          <p className="font-bold text-white text-base">{group.deptName}</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            {doneCount}/{group.products.length} ta mahsulot tayyor
          </p>
        </div>
        <div className="flex items-center gap-3">
          {group.products.length > 1 && pendingProducts.length > 0 && (
            <button
              type="button"
              disabled={busyIds.has(-1)}
              onClick={() => onFinishAll(pendingProducts.map((p) => p.subOrderId))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors"
            >
              {busyIds.has(-1) && <Loader2 className="size-3 animate-spin" />}
              Hammasi tayyor ({pendingProducts.length})
            </button>
          )}
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              {group.parentIds.length > 1 ? 'Zayavkalar' : 'Zayavka'}
            </p>
            <p className="text-sm font-bold text-zinc-300">
              {group.parentIds.map((id) => `#${id}`).join(', ')}
            </p>
          </div>
        </div>
      </div>

      <DestinationContext data={destinationData} />

      {rawTotals.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-card px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Jami kerakli xomashyo (otdel bo'yicha)
          </p>
          <div className="space-y-1">
            {rawTotals.map((t) => (
              <div
                key={t.name}
                className="flex items-center justify-between rounded-lg bg-muted/20 px-3 py-1.5"
              >
                <span className="text-xs font-medium">{t.name}</span>
                <span className="tabular-nums text-xs font-bold">
                  {fmtQty(t.qty)}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">{t.unit}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Product cards */}
      <div className="space-y-2">
        {group.products.map((prod) => (
          <ProductCard
            key={prod.subOrderId}
            prod={prod}
            isBusy={busyIds.has(prod.subOrderId) || busyIds.has(-1)}
            onFinish={() => onFinishOne(prod.subOrderId)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KremKaymokchiPage
// ---------------------------------------------------------------------------

/**
 * This screen belongs to the kaymak maker specifically, so it is scoped to the
 * kaymak family — "крем каймак", "крем каймак (какао)", "крем каймок (варёное)",
 * "крем каймок с ичной". Both Cyrillic spellings (каймак / каймок) are in use.
 *
 * Other creams (крем масляный, крем творожный, баунти крем) and zagotovka work
 * (зувала, бисквит, з/г …) are made elsewhere and have their own screens.
 */
export function isKaymakProduct(name: string): boolean {
  const lower = name.toLowerCase();
  return ['каймак', 'каймок', 'kaymak', 'kaymok'].some((needle) => lower.includes(needle));
}

export function KremKaymokchiPage() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const dateLabel = useMemo(() => {
    const d = new Date();
    return `${d.getDate()}-${d.toLocaleString('uz-UZ', { month: 'long' })}`;
  }, []);

  const { notify } = useToast();
  const { data: orders, isLoading, error, refetch } = useApiQuery<ProductionOrder[]>(
    `/api/production-orders?from_date=${today}&to_date=${today}`,
  );

  const parentById = useMemo(() => {
    const m = new Map<number, ProductionOrder>();
    for (const o of orders ?? []) {
      if (o.parent_production_order_id == null) m.set(o.id, o);
    }
    return m;
  }, [orders]);

  // Grouped by department (location), not by zayavka — several zayavkas
  // can target the same "otdel" on the same day (e.g. two orders both
  // going to "Оформления отдел"), and the krem kaymokchi needs ONE pooled
  // view of everything that department needs, so nothing is missed by
  // only looking at whichever zayavka's card happens to be selected.
  const deptGroups = useMemo((): DeptGroup[] => {
    if (!orders) return [];

    // Only the kaymak family belongs here — see isKaymakProduct. Everything
    // else the departments order is made on another screen.
    const subOrders = orders.filter(
      (o) => o.parent_production_order_id != null && isKaymakProduct(o.product_name),
    );

    const deptMap = new Map<string, DeptGroup>();
    for (const sub of subOrders) {
      if (!sub.parent_production_order_id) continue;
      const parent = parentById.get(sub.parent_production_order_id);
      if (!parent) continue;

      const key = String(parent.location_id ?? `parent-${parent.id}`);
      if (!deptMap.has(key)) {
        deptMap.set(key, {
          key,
          deptName: parent.location_name,
          products: [],
          parentIds: [],
        });
      }
      const group = deptMap.get(key)!;
      if (!group.parentIds.includes(parent.id)) group.parentIds.push(parent.id);
      group.products.push({
        subOrderId: sub.id,
        productId: sub.product_id,
        productName: sub.product_name,
        productUnit: getUnit(sub),
        qty: sub.qty,
        status: sub.status,
        parentId: parent.id,
      });
    }

    return [...deptMap.values()].sort((a, b) => a.deptName.localeCompare(b.deptName));
  }, [orders, parentById]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const effectiveKey = selectedKey ?? (deptGroups.length > 0 ? deptGroups[0]!.key : null);
  const selectedGroup = deptGroups.find((g) => g.key === effectiveKey) ?? null;

  // Faza 3 — real "Berdim": PATCH status → 'done' (single order) or the
  // bulk-done endpoint (multiple), same client-side pattern
  // ProductionOrdersPage.tsx's handleStatusDone/handleMarkAllDone use.
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  async function handleFinishOne(subOrderId: number) {
    setBusyIds((prev) => new Set(prev).add(subOrderId));
    try {
      await apiRequest(`/api/production-orders/${subOrderId}`, {
        method: 'PATCH',
        body: { status: 'done' },
      });
      notify('success', 'Mahsulot tayyor deb belgilandi.');
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Status o'zgartirib bo'lmadi.");
    } finally {
      setBusyIds((prev) => { const s = new Set(prev); s.delete(subOrderId); return s; });
    }
  }

  async function handleFinishAll(subOrderIds: number[]) {
    if (subOrderIds.length === 0) return;
    setBusyIds((prev) => {
      const s = new Set(prev);
      s.add(-1);
      subOrderIds.forEach((id) => s.add(id));
      return s;
    });
    try {
      await apiRequest('/api/production-orders/bulk-done', {
        method: 'PATCH',
        body: { ids: subOrderIds },
      });
      notify('success', `${subOrderIds.length} ta mahsulot tayyor deb belgilandi.`);
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Bulk tayyor qilib bo'lmadi.");
    } finally {
      setBusyIds((prev) => {
        const s = new Set(prev);
        s.delete(-1);
        subOrderIds.forEach((id) => s.delete(id));
        return s;
      });
    }
  }

  if (isLoading) return <div className="p-6"><LoadingState /></div>;
  if (error) return <div className="p-6"><ErrorState message={error} onRetry={refetch} /></div>;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="Krem kaymok"
        description={dateLabel}
        action={
          deptGroups.length > 0 ? (
            <button
              type="button"
              onClick={() => openCreamPrint(deptGroups, today)}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <Printer className="size-4" />
              Chop etish
            </button>
          ) : undefined
        }
      />

      {deptGroups.length === 0 ? (
        <EmptyState message="Bugun uchun zagotovka buyurtmalari topilmadi." />
      ) : (
        <>
          <div className="rounded-xl border border-border/30 bg-muted/20 px-4 py-2.5">
            <p className="text-sm text-muted-foreground">
              Krem umumiy tayyorlanadi, keyin otdellar bo'yicha bo'linadi
            </p>
          </div>

          <div className="flex gap-3 items-start">
            {/* Left: dept list */}
            <div className="w-56 shrink-0 space-y-1">
              {deptGroups.map((group) => {
                const isSelected = effectiveKey === group.key;
                return (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => setSelectedKey(group.key)}
                    className={`w-full text-left rounded-xl px-3 py-2.5 transition-colors border ${
                      isSelected
                        ? 'bg-primary/10 border-primary/30'
                        : 'bg-card border-border/40 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="size-2 shrink-0 rounded-full bg-emerald-400 mt-1.5" />
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm truncate ${
                            isSelected ? 'font-semibold text-primary' : 'font-medium'
                          }`}
                        >
                          {group.deptName}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {group.products.length} ta mahsulot
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right: detail panel */}
            <div className="flex-1 min-w-0">
              {selectedGroup ? (
                <DeptDetail
                  key={selectedGroup.key}
                  group={selectedGroup}
                  parentOrders={selectedGroup.parentIds
                    .map((id) => parentById.get(id))
                    .filter((o): o is ProductionOrder => o != null)}
                  busyIds={busyIds}
                  onFinishOne={handleFinishOne}
                  onFinishAll={handleFinishAll}
                />
              ) : (
                <EmptyState message="Otdelni tanlang." />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
