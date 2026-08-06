import { useState, useMemo } from 'react';
import { Printer } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { LoadingState, ErrorState, EmptyState, PageHeader } from '@/components/PageState';
import type { ProductionOrder, ProductionOrderBomResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type DeptProduct = {
  subOrderId: number;
  productId: number;
  productName: string;
  productUnit: string;
  qty: number;
};

type DeptGroup = {
  parentId: number;
  deptName: string;
  products: DeptProduct[];
};

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
// ProductCard — single z/g product within a dept
// ---------------------------------------------------------------------------
function ProductCard({ prod }: { prod: DeptProduct }) {
  const [showIngredients, setShowIngredients] = useState(false);
  const [berdi, setBerdi] = useState(false);

  return (
    <div className={`overflow-hidden rounded-xl border border-border/40 bg-card transition-opacity ${berdi ? 'opacity-50' : ''}`}>
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
            onClick={() => setBerdi((v) => !v)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
              berdi
                ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }`}
          >
            {berdi ? '✓ Berildi' : 'Berdim'}
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
function DeptDetail({ group }: { group: DeptGroup }) {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between rounded-xl bg-zinc-900 dark:bg-zinc-800 px-4 py-3">
        <div>
          <p className="font-bold text-white text-base">{group.deptName}</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            {group.products.length} ta mahsulot tayyorlanadi
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Zayavka
          </p>
          <p className="text-sm font-bold text-zinc-300">#{group.parentId}</p>
        </div>
      </div>

      {/* Product cards */}
      <div className="space-y-2">
        {group.products.map((prod) => (
          <ProductCard key={prod.subOrderId} prod={prod} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KremKaymokchiPage
// ---------------------------------------------------------------------------
export function KremKaymokchiPage() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const dateLabel = useMemo(() => {
    const d = new Date();
    return `${d.getDate()}-${d.toLocaleString('uz-UZ', { month: 'long' })}`;
  }, []);

  const { data: orders, isLoading, error, refetch } = useApiQuery<ProductionOrder[]>(
    `/api/production-orders?from_date=${today}&to_date=${today}`,
  );

  const deptGroups = useMemo((): DeptGroup[] => {
    if (!orders) return [];

    const parentMap = new Map<number, ProductionOrder>();
    const subOrders: ProductionOrder[] = [];

    for (const o of orders) {
      if (o.parent_production_order_id == null) {
        parentMap.set(o.id, o);
      } else {
        subOrders.push(o);
      }
    }

    const deptMap = new Map<number, DeptGroup>();
    for (const sub of subOrders) {
      if (!sub.parent_production_order_id) continue;
      const parent = parentMap.get(sub.parent_production_order_id);
      if (!parent) continue;

      const parentId = parent.id;
      if (!deptMap.has(parentId)) {
        deptMap.set(parentId, {
          parentId,
          deptName: parent.location_name,
          products: [],
        });
      }
      const unit = (sub as unknown as Record<string, string | undefined>)['product_unit'] ?? '';
      deptMap.get(parentId)!.products.push({
        subOrderId: sub.id,
        productId: sub.product_id,
        productName: sub.product_name,
        productUnit: unit,
        qty: sub.qty,
      });
    }

    return [...deptMap.values()].sort((a, b) => a.deptName.localeCompare(b.deptName));
  }, [orders]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? (deptGroups.length > 0 ? deptGroups[0]!.parentId : null);
  const selectedGroup = deptGroups.find((g) => g.parentId === effectiveId) ?? null;

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
                const isSelected = effectiveId === group.parentId;
                return (
                  <button
                    key={group.parentId}
                    type="button"
                    onClick={() => setSelectedId(group.parentId)}
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
                <DeptDetail key={selectedGroup.parentId} group={selectedGroup} />
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
