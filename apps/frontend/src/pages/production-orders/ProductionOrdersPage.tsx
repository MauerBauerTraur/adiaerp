import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Printer,
  Send,
  Trash2,
} from 'lucide-react';
import { FilterSheet, FilterField, FilterTrigger } from '@/components/ui/filter-sheet';
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
import { PRODUCTION_ORDER_STATUS_LABELS } from '@/lib/labels';
import type { Location, Product, ProductionOrder, ProductionOrderStatus } from '@/lib/types';
import { ProductionOrderFormDialog } from './ProductionOrderFormDialog';
import { QuickCostDialog } from './QuickCostDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STATUS_DOT: Record<string, string> = {
  new: 'bg-amber-400',
  in_progress: 'bg-blue-400',
  done: 'bg-emerald-500',
  cancelled: 'bg-muted-foreground/40',
};

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
  const done = orders.filter((o) => o.status === 'done').length;
  const overdueCount = orders.filter(
    (o) =>
      o.deadline &&
      o.status !== 'done' &&
      o.status !== 'cancelled' &&
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

      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted/30 gap-px">
        {done > 0 && (
          <div className="bg-emerald-500 transition-all" style={{ width: `${(done / total) * 100}%` }} />
        )}
        {newCount > 0 && (
          <div className="bg-amber-400 transition-all" style={{ width: `${(newCount / total) * 100}%` }} />
        )}
      </div>

      <div className="grid grid-cols-2 divide-x divide-border/40">
        <div className="pr-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{newCount}</p>
          <p className="text-xs text-muted-foreground">Yaratildi</p>
        </div>
        <div className="pl-4 space-y-0.5">
          <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{done}</p>
          <p className="text-xs text-muted-foreground">
            Tayyor
            {done > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground/60">
                {Math.round((done / total) * 100)}%
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print helper — opens a new window with formatted order info
// ---------------------------------------------------------------------------
function openPrintWindow(order: ProductionOrder, unit: string) {
  const win = window.open('', '_blank', 'width=700,height=600');
  if (!win) return;
  const deadline = order.deadline
    ? `<div class="row"><span class="label">Muddat</span><span class="value">${order.deadline}</span></div>`
    : '';
  const note = order.note
    ? `<div class="row"><span class="label">Izoh</span><span class="value">${order.note}</span></div>`
    : '';
  const created = new Date(order.created_at).toLocaleDateString('uz-UZ', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Zayafka #${order.id}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; padding: 30px; color: #111; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .divider { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f0f0f0; }
  .label { color: #888; font-size: 13px; }
  .value { font-weight: 600; font-size: 14px; }
  .big { font-size: 22px; color: #1a56db; }
  .footer { margin-top: 24px; color: #aaa; font-size: 11px; }
  .print-btn { margin-top: 20px; padding: 8px 20px; background: #1a56db; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  @media print { .print-btn { display: none; } }
</style>
</head><body>
<h1>Ishlab chiqarish zayafkasi</h1>
<p class="sub">ADIA ERP · Yaratilgan: ${created}</p>
<hr class="divider">
<div class="row"><span class="label"># Zayafka</span><span class="value">#${order.id}</span></div>
<div class="row"><span class="label">Mahsulot</span><span class="value">${order.product_name}</span></div>
<div class="row"><span class="label">Miqdor</span><span class="value big">${formatQty(order.qty)} ${unit}</span></div>
<div class="row"><span class="label">Bo'g'in (Sex)</span><span class="value">${order.location_name}</span></div>
<div class="row"><span class="label">Holat</span><span class="value">${PRODUCTION_ORDER_STATUS_LABELS[order.status] ?? order.status}</span></div>
${deadline}${note}
<p class="footer">ADIA ERP — avtomatik hujjat</p>
<button class="print-btn" onclick="window.print()">Chop etish / PDF</button>
</body></html>`);
  win.document.close();
  win.focus();
}

// ---------------------------------------------------------------------------
// Global list print — all visible orders as a matrix (rows=products, cols=sexlar)
// ---------------------------------------------------------------------------
function openOrdersListPrint(orders: ProductionOrder[], dateStr: string) {
  // Unique locations (sexlar), sorted
  const locMap = new Map<string, string>();
  for (const o of orders) locMap.set(o.location_name, o.location_name);
  const locs = [...locMap.keys()].sort((a, b) => a.localeCompare(b));

  // Products aggregated: name → { byLoc: Map<locName, qty>, total }
  type ProdRow = { byLoc: Map<string, number>; total: number };
  const prodMap = new Map<string, ProdRow>();
  for (const o of orders) {
    if (!prodMap.has(o.product_name)) prodMap.set(o.product_name, { byLoc: new Map(), total: 0 });
    const row = prodMap.get(o.product_name)!;
    row.byLoc.set(o.location_name, (row.byLoc.get(o.location_name) ?? 0) + o.qty);
    row.total += o.qty;
  }
  const prods = [...prodMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  function fmtN(n: number) {
    if (n === 0) return '';
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
  }

  const thStyle = 'border:1px solid #d0d7de;padding:6px 8px;background:#f5c518;font-size:11px;text-align:center;font-weight:700;white-space:nowrap;';
  const th0Style = 'border:1px solid #d0d7de;padding:6px 8px;background:#1a56db;color:#fff;font-size:11px;font-weight:700;white-space:nowrap;min-width:160px;';
  const thTotalStyle = 'border:1px solid #d0d7de;padding:6px 8px;background:#0e7490;color:#fff;font-size:11px;font-weight:700;text-align:center;';

  const headerCols = locs.map((loc) => `<th style="${thStyle}">${loc}</th>`).join('');
  const bodyRows = prods.map(([name, row], idx) => {
    const bg = idx % 2 === 0 ? '#fff' : '#f8fafc';
    const cells = locs.map((loc) => {
      const q = row.byLoc.get(loc) ?? 0;
      const dim = q === 0 ? 'background:#f1f5f9;' : '';
      return `<td style="border:1px solid #d0d7de;padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;${dim}">${fmtN(q)}</td>`;
    }).join('');
    const totalCellStyle = 'border:1px solid #d0d7de;padding:5px 8px;text-align:right;font-weight:700;font-size:12px;background:#e0f2fe;font-variant-numeric:tabular-nums;';
    return `<tr style="background:${bg}"><td style="border:1px solid #d0d7de;padding:5px 8px;font-size:12px;font-weight:600;">${name}</td>${cells}<td style="${totalCellStyle}">${fmtN(row.total)}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Zayavkalar — ${dateStr}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Arial',sans-serif;margin:20px;color:#111}
      h1{font-size:16px;font-weight:700;margin-bottom:4px}
      .subtitle{color:#6b7280;font-size:12px;margin-bottom:16px}
      table{border-collapse:collapse;width:100%}
      @media print{body{margin:10px}@page{size:landscape;margin:10mm}}
      .footer{margin-top:28px;display:flex;gap:60px;font-size:11px;color:#555}
      .sig{border-top:1px solid #555;padding-top:4px;min-width:180px}
    </style>
  </head><body>
    <h1>Ishlab chiqarish zayavkalari — ${dateStr}</h1>
    <p class="subtitle">Jami ${prods.length} ta mahsulot · ${locs.length} ta sex · ${orders.length} ta zayavka</p>
    <table>
      <thead>
        <tr>
          <th style="${th0Style}">Mahsulot</th>
          ${headerCols}
          <th style="${thTotalStyle}">Jami</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="footer">
      <div class="sig">Tuzuvchi: _________________________</div>
      <div class="sig">Tasdiqladi: _________________________</div>
      <div class="sig">Sana: ${dateStr}</div>
    </div>
    <script>window.onload=function(){window.print()}<\/script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ---------------------------------------------------------------------------
// StoreOrdersMatrix — Do'kon zayavkalari matrix view
// ---------------------------------------------------------------------------
type MatrixProduct = {
  productId: number;
  productName: string;
  byStore: Map<string, number>;
  totalQty: number;
};

type MatrixDept = {
  locationId: number | string;
  locationName: string;
  products: MatrixProduct[];
};

// Returns a stable string key for a "store" (do'kon) column.
// Prefers target_location_id when set; falls back to requester_location_name.
function storeKeyOf(o: ProductionOrder): string | null {
  if (o.target_location_id != null) return `loc:${o.target_location_id}`;
  if (o.requester_location_name) return `req:${o.requester_location_name}`;
  return null;
}

function storeNameOf(o: ProductionOrder): string | null {
  return o.target_location_name ?? o.requester_location_name ?? null;
}

function buildMatrix(orders: ProductionOrder[]) {
  const storeMap = new Map<string, string>();
  const deptMap = new Map<string, { name: string; prods: Map<string, MatrixProduct> }>();

  for (const o of orders) {
    if (o.parent_production_order_id != null) continue;
    const sk = storeKeyOf(o);
    const sn = storeNameOf(o);
    if (sk && sn) storeMap.set(sk, sn);

    const deptKey = String(o.location_id);
    if (!deptMap.has(deptKey)) {
      deptMap.set(deptKey, { name: o.location_name, prods: new Map() });
    }
    const dept = deptMap.get(deptKey)!;
    const prodKey = String(o.product_id);
    if (!dept.prods.has(prodKey)) {
      dept.prods.set(prodKey, {
        productId: o.product_id,
        productName: o.product_name,
        byStore: new Map(),
        totalQty: 0,
      });
    }
    const prod = dept.prods.get(prodKey)!;
    if (sk) {
      prod.byStore.set(sk, (prod.byStore.get(sk) ?? 0) + o.qty);
    }
    prod.totalQty += o.qty;
  }

  const stores = [...storeMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const depts: MatrixDept[] = [...deptMap.entries()]
    .map(([locationId, { name, prods }]) => ({
      locationId,
      locationName: name,
      products: [...prods.values()].sort((a, b) => a.productName.localeCompare(b.productName)),
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName));

  return { stores, depts };
}

function StoreOrdersMatrix({
  orders,
  productById,
}: {
  orders: ProductionOrder[];
  productById: Map<number, Product>;
}) {
  const { stores, depts } = useMemo(() => buildMatrix(orders), [orders]);
  const [skladQty, setSkladQty] = useState<Record<string, string>>({});

  const storeOrderCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) {
      if (o.parent_production_order_id != null) continue;
      const sk = storeKeyOf(o);
      if (!sk) continue;
      m.set(sk, (m.get(sk) ?? 0) + 1);
    }
    return m;
  }, [orders]);

  if (depts.length === 0) {
    return <EmptyState message="Do'kon zayavkalari topilmadi. Zayavkalar manzil (target) bilan yaratilgan bo'lishi kerak." />;
  }

  return (
    <div className="space-y-4">
      {/* Store cards */}
      {stores.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {stores.map((store) => (
            <div
              key={store.id}
              className="min-w-[160px] flex-shrink-0 rounded-2xl border border-border/60 bg-card p-4 shadow-sm space-y-1"
            >
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-500" />
                <span className="text-sm font-bold truncate">{store.name}</span>
              </div>
              <p className="text-2xl font-bold tabular-nums">{storeOrderCount.get(store.id) ?? 0}</p>
              <p className="text-xs text-muted-foreground">pozitsiya</p>
            </div>
          ))}
          {stores.length === 0 && (
            <div className="min-w-[160px] flex-shrink-0 rounded-2xl border border-amber-300/40 bg-amber-50/30 dark:bg-amber-950/10 p-4 shadow-sm">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Zayavkalar do'kon manziliga (target) biriktirilmagan
              </p>
            </div>
          )}
        </div>
      )}

      {/* Department sections */}
      {depts.map((dept, deptIdx) => {
        const deptIshlab = dept.products.reduce((sum, prod) => {
          const key = `${dept.locationId}_${prod.productId}`;
          const sklad = Number(skladQty[key] ?? 0);
          return sum + Math.max(0, prod.totalQty - sklad);
        }, 0);

        return (
          <div key={dept.locationId} className="overflow-hidden rounded-xl border border-border/50 shadow-sm">
            <div className="flex items-center gap-3 bg-zinc-900 dark:bg-zinc-800 px-4 py-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-xs font-bold text-zinc-300">
                {deptIdx + 1}
              </span>
              <span className="text-sm font-bold text-white">{dept.locationName}</span>
              <span className="text-xs text-zinc-400">{dept.products.length} mahsulot</span>
              <div className="ml-auto text-xs text-zinc-400">
                ishlab chiqarish:{' '}
                <span className="font-bold text-white">{Math.round(deptIshlab)}</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/10">
                    <th className="py-2 pl-4 pr-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Mahsulot
                    </th>
                    {stores.map((s) => (
                      <th key={s.id} className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                        {s.name}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                      So&apos;raldi
                    </th>
                    <th className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 whitespace-nowrap w-44">
                      Skladdan
                    </th>
                    <th className="py-2 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                      Ishlab chiq.
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {dept.products.map((prod) => {
                    const key = `${dept.locationId}_${prod.productId}`;
                    const skladVal = Number(skladQty[key] ?? 0);
                    const ishlab = Math.max(0, prod.totalQty - skladVal);
                    const unit = productById.get(prod.productId)?.unit ?? '';
                    return (
                      <tr key={prod.productId} className="hover:bg-muted/20 transition-colors">
                        <td className="py-2.5 pl-4 pr-2 font-semibold whitespace-nowrap">
                          {prod.productName}
                        </td>
                        {stores.map((s) => {
                          const qty = prod.byStore.get(s.id) ?? 0;
                          return (
                            <td key={s.id} className="px-3 py-2.5 text-center tabular-nums">
                              {qty > 0 ? (
                                <span className="font-medium">{qty}</span>
                              ) : (
                                <span className="text-muted-foreground/25">·</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums">
                          {prod.totalQty}
                          {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              max={prod.totalQty}
                              value={skladQty[key] ?? ''}
                              onChange={(e) =>
                                setSkladQty((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder="0"
                              className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-right tabular-nums focus:border-emerald-500 focus:outline-none"
                            />
                            {skladVal > 0 && (
                              <button
                                type="button"
                                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-700 transition-colors whitespace-nowrap"
                              >
                                beraman
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          <span className="font-bold text-blue-600 dark:text-blue-400">{ishlab}</span>
                          {unit && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function ProductionOrdersPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isReadOnly, isOperator } = useCanAct();
  const { user } = useAuth();
  const isPm = user?.role === 'pm' || user?.role === 'super_admin';
  const isProdManager = user?.role === 'production_manager';
  const myLocationId = isProdManager ? (user?.location_id ?? null) : null;
  const canCreate = isOperator || isPm;

  const fromDashboard = searchParams.get('from') === 'dashboard';
  const urlStatus = searchParams.get('status') as ProductionOrderStatus | null;
  const urlLocationId = searchParams.get('location_id');
  const urlOverdue = searchParams.get('overdue') === '1';
  const urlFrom = searchParams.get('date_from') ?? '';
  const urlTo = searchParams.get('date_to') ?? '';

  const { notify } = useToast();
  const [status, setStatus] = useState<ProductionOrderStatus | ''>(urlStatus ?? '');
  const [selectedSexId, setSelectedSexId] = useState<number | null>(
    urlLocationId ? Number(urlLocationId) : myLocationId,
  );
  const [showOverdueOnly, setShowOverdueOnly] = useState(urlOverdue);
  const [dateFrom, setDateFrom] = useState(urlFrom);
  const [dateTo, setDateTo] = useState(urlTo);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<ProductionOrderStatus | ''>(urlStatus ?? '');
  const [draftSelectedSexId, setDraftSelectedSexId] = useState<number | null>(
    urlLocationId ? Number(urlLocationId) : myLocationId,
  );
  const [draftDateFrom, setDraftDateFrom] = useState(urlFrom);
  const [draftDateTo, setDraftDateTo] = useState(urlTo);
  const [draftShowOverdue, setDraftShowOverdue] = useState(urlOverdue);

  const filterActiveCount =
    (status !== '' ? 1 : 0) +
    (selectedSexId !== null && myLocationId === null ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (showOverdueOnly ? 1 : 0);

  function openFilter() {
    setDraftStatus(status);
    setDraftSelectedSexId(selectedSexId);
    setDraftDateFrom(dateFrom);
    setDraftDateTo(dateTo);
    setDraftShowOverdue(showOverdueOnly);
    setFilterOpen(true);
  }
  function applyFilter() {
    setStatus(draftStatus);
    setSelectedSexId(draftSelectedSexId);
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setShowOverdueOnly(draftShowOverdue);
    setFilterOpen(false);
  }
  function clearFilter() {
    setDraftStatus(''); setStatus('');
    setDraftSelectedSexId(null); setSelectedSexId(null);
    setDraftDateFrom(''); setDateFrom('');
    setDraftDateTo(''); setDateTo('');
    setDraftShowOverdue(false); setShowOverdueOnly(false);
    setFilterOpen(false);
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [quickCostOpen, setQuickCostOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProductionOrder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductionOrder | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [telegramBusyId, setTelegramBusyId] = useState<number | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'matrix'>('list');

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

  async function sendTelegram(orderId: number) {
    setTelegramBusyId(orderId);
    try {
      await apiRequest(`/api/production-orders/${orderId}/notify`, { method: 'POST' });
      notify('success', 'Telegram xabari yuborildi!');
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Telegram yuborib bo'lmadi.");
    } finally {
      setTelegramBusyId(null);
    }
  }

  async function handleStatusDone(orderId: number) {
    setStatusBusyId(orderId);
    try {
      await apiRequest(`/api/production-orders/${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      notify('success', 'Zayafka tayyor deb belgilandi!');
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Status o'zgartib bo'lmadi.");
    } finally {
      setStatusBusyId(null);
    }
  }

  async function handleMarkAllDone() {
    const pendingIds = (data ?? [])
      .filter((r) => r.parent_production_order_id == null && r.status !== 'done' && r.status !== 'cancelled')
      .map((r) => r.id);
    if (pendingIds.length === 0) return;
    setMarkAllBusy(true);
    try {
      await apiRequest('/api/production-orders/bulk-done', {
        method: 'PATCH',
        body: JSON.stringify({ ids: pendingIds }),
      });
      notify('success', `${pendingIds.length} ta zayafka tayyor deb belgilandi!`);
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Bulk tayyor qilib bo'lmadi.");
    } finally {
      setMarkAllBusy(false);
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
      notify('error', err instanceof ApiError ? err.message : "O'chirib bo'lmadi.");
    } finally {
      setIsDeleting(false);
    }
  }

  const rows = data ?? [];

  const sexChips = useMemo(() => {
    if (myLocationId !== null) return [];
    const seen = new Map<number, string>();
    for (const row of rows) seen.set(row.location_id, row.location_name);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, myLocationId]);

  const effectiveSexId = myLocationId ?? selectedSexId;
  const todayIso = new Date().toISOString().slice(0, 10);
  const baseRows =
    effectiveSexId !== null ? rows.filter((r) => r.location_id === effectiveSexId) : rows;
  const filteredRows = showOverdueOnly
    ? baseRows.filter(
        (r) =>
          r.deadline != null &&
          r.deadline < todayIso &&
          r.status !== 'done' &&
          r.status !== 'cancelled',
      )
    : baseRows;

  // Only top-level orders in the table (sub-orders visible on detail page)
  const topLevelRows = filteredRows.filter((r) => r.parent_production_order_id == null);

  // Sub-order count per parent (for the table badge)
  const subCountMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of filteredRows) {
      if (r.parent_production_order_id != null) {
        m.set(r.parent_production_order_id, (m.get(r.parent_production_order_id) ?? 0) + 1);
      }
    }
    return m;
  }, [filteredRows]);

  return (
    <div className="mx-auto max-w-[90rem] space-y-5">
      <PageHeader
        title="Ishlab chiqarish zayafkalari"
        description="Zayafkalar va omborga ta'sir ro'yxati."
        action={
          <div className="flex items-center gap-2">
            {isReadOnly && !canCreate && (
              <Badge variant="secondary">Faqat o'qish</Badge>
            )}
            {(isPm || isProdManager) && (
              <Button variant="outline" onClick={() => navigate('/production-cost-report')}>
                Narx xisoboti
              </Button>
            )}
            {topLevelRows.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  const today = new Date().toISOString().slice(0, 10);
                  openOrdersListPrint(topLevelRows, today);
                }}
              >
                <Printer className="size-4" />
                Chop etish
              </Button>
            )}
            {(canCreate || isPm || isProdManager) &&
              topLevelRows.some((r) => r.status !== 'done' && r.status !== 'cancelled') && (
                <Button
                  variant="outline"
                  className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                  disabled={markAllBusy}
                  onClick={() => void handleMarkAllDone()}
                >
                  {markAllBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Barchasini tayyor qilish
                </Button>
              )}
            <Button variant="outline" onClick={() => setQuickCostOpen(true)}>
              Narx hisoblash
            </Button>
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" />
                Yangi zayafka
              </Button>
            )}
          </div>
        }
      />

      {fromDashboard && (
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Ortga
        </button>
      )}

      {showOverdueOnly && (
        <div className="flex items-center gap-2 rounded-xl bg-destructive/10 border border-destructive/20 px-4 py-2.5 text-sm font-medium text-destructive">
          <span>Muddati o&apos;tgan zayafkalar ko&apos;rsatilmoqda</span>
          <button
            type="button"
            onClick={() => setShowOverdueOnly(false)}
            className="ml-auto text-xs underline opacity-80 hover:opacity-100"
          >
            Tozalash
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/40 px-4 py-2.5 gap-3">
        <span className="text-sm text-muted-foreground shrink-0">
          {topLevelRows.length} ta zayafka
          {filterActiveCount > 0 && <span className="ml-2 text-xs text-primary">{filterActiveCount} ta filter faol</span>}
        </span>
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center rounded-lg border border-border/60 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              Ro'yxat
            </button>
            <button
              type="button"
              onClick={() => setViewMode('matrix')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === 'matrix'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              Do'kon zayavkalari
            </button>
          </div>
          <FilterTrigger onClick={openFilter} activeCount={filterActiveCount} />
        </div>
      </div>

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={applyFilter}
        onClear={clearFilter}
        activeCount={filterActiveCount}
      >
        <FilterField label="Holat">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setDraftStatus('')}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                draftStatus === ''
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              Barchasi
            </button>
            {(['new', 'in_progress', 'done', 'cancelled'] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setDraftStatus(draftStatus === val ? '' : val)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  draftStatus === val
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {PRODUCTION_ORDER_STATUS_LABELS[val]}
              </button>
            ))}
          </div>
        </FilterField>

        {sexChips.length > 1 && myLocationId === null && (
          <FilterField label="Sex (bo'lim)">
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setDraftSelectedSexId(null)}
                className={`w-full rounded-lg border px-3 py-2 text-sm font-medium text-left transition-colors ${
                  draftSelectedSexId === null
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                Barchasi ({rows.filter((r) => r.parent_production_order_id == null).length})
              </button>
              {sexChips.map((chip) => {
                const count = rows.filter((r) => r.location_id === chip.id && r.parent_production_order_id == null).length;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setDraftSelectedSexId(draftSelectedSexId === chip.id ? null : chip.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-sm font-medium text-left transition-colors ${
                      draftSelectedSexId === chip.id
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {chip.name} ({count})
                  </button>
                );
              })}
            </div>
          </FilterField>
        )}

        <FilterField label="Sana oraligi">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={draftDateFrom}
              onChange={(e) => setDraftDateFrom(e.target.value)}
              className="flex-1 h-8 rounded-lg border border-border bg-background px-2 text-sm"
            />
            <span className="text-xs text-muted-foreground shrink-0">—</span>
            <input
              type="date"
              value={draftDateTo}
              onChange={(e) => setDraftDateTo(e.target.value)}
              className="flex-1 h-8 rounded-lg border border-border bg-background px-2 text-sm"
            />
          </div>
        </FilterField>

        <FilterField label="Muddat">
          <button
            type="button"
            onClick={() => setDraftShowOverdue((v) => !v)}
            className={`w-full flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
              draftShowOverdue
                ? 'border-destructive bg-destructive/10 text-destructive'
                : 'border-border bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            <span>Muddati o'tganlar</span>
            <span className={`size-4 rounded-sm border-2 flex items-center justify-center ${draftShowOverdue ? 'border-destructive bg-destructive' : 'border-muted-foreground'}`}>
              {draftShowOverdue && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
            </span>
          </button>
        </FilterField>
      </FilterSheet>


      {myLocationId !== null && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
            {rows.find((r) => r.location_id === myLocationId)?.location_name ?? `Sex #${myLocationId}`}{' '}
            — faqat mening sexim
          </span>
        </div>
      )}

      {/* Loading / error */}
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && topLevelRows.length === 0 && (
        <EmptyState message="Zayafkalar topilmadi." />
      )}

      {!isLoading && !error && topLevelRows.length > 0 && (
        <>
          <PipelineStat orders={filteredRows} />

          {/* Matrix view */}
          {viewMode === 'matrix' && (
            <StoreOrdersMatrix orders={filteredRows} productById={productById} />
          )}

          {/* Table (list view) */}
          {viewMode === 'list' && (
          <div className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 bg-muted/30 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium">#</th>
                    <th className="px-4 py-3 font-medium">Mahsulot</th>
                    <th className="px-4 py-3 font-medium text-right">Miqdor</th>
                    <th className="px-4 py-3 font-medium">Bo&apos;g&apos;in</th>
                    <th className="px-4 py-3 font-medium">Holat</th>
                    <th className="px-4 py-3 font-medium">Muddat</th>
                    <th className="px-4 py-3 font-medium text-right">Amallar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {topLevelRows.map((order) => {
                    const unit = productById.get(order.product_id)?.unit ?? '';
                    const overdue = isOverdue(order.deadline, order.status);
                    const dotClass = STATUS_DOT[order.status] ?? 'bg-muted';
                    const subCount = subCountMap.get(order.id) ?? 0;
                    const isTgBusy = telegramBusyId === order.id;
                    const isStatusBusy = statusBusyId === order.id;
                    const canMarkDone =
                      (canCreate || isPm || isProdManager) &&
                      (order.status === 'new' || order.status === 'in_progress');

                    return (
                      <tr
                        key={order.id}
                        className="hover:bg-muted/20 transition-colors cursor-pointer"
                        onClick={() => navigate(`/production-orders/${order.id}`)}
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="font-mono text-xs text-muted-foreground">#{order.id}</span>
                          {subCount > 0 && (
                            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              +{subCount}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 max-w-[220px]">
                          <p className="font-medium truncate">{order.product_name}</p>
                          {order.note && (
                            <p className="text-[11px] text-muted-foreground truncate">{order.note}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                          <span className="font-semibold">{formatQty(order.qty)}</span>
                          <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {order.location_name}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`size-2 shrink-0 rounded-full ${dotClass}`} />
                            <span className="text-xs">
                              {PRODUCTION_ORDER_STATUS_LABELS[order.status] ?? order.status}
                            </span>
                          </span>
                        </td>
                        <td
                          className={`px-4 py-3 text-xs whitespace-nowrap ${
                            overdue ? 'text-red-500 dark:text-red-400 font-semibold' : 'text-muted-foreground'
                          }`}
                        >
                          {order.deadline ? (
                            <>
                              {overdue && '⚠ '}
                              {order.deadline}
                            </>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td
                          className="px-4 py-3"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-0.5">
                            {canMarkDone && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                title="Tayyor deb belgilash"
                                disabled={isStatusBusy || markAllBusy}
                                onClick={() => void handleStatusDone(order.id)}
                              >
                                {isStatusBusy ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="size-3.5" />
                                )}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0"
                              title="Ko'rish"
                              onClick={() => navigate(`/production-orders/${order.id}`)}
                            >
                              <Eye className="size-3.5" />
                            </Button>
                            {canCreate && (order.status === 'new') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0 text-muted-foreground hover:text-foreground"
                                title="Tahrirlash"
                                onClick={() => setEditTarget(order)}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0 text-sky-500 hover:text-sky-600"
                              title="Telegramga yuborish"
                              disabled={isTgBusy}
                              onClick={() => void sendTelegram(order.id)}
                            >
                              {isTgBusy ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0"
                              title="Chop etish / PDF"
                              onClick={() => openPrintWindow(order, unit)}
                            >
                              <Printer className="size-3.5" />
                            </Button>
                            {canCreate && (isPm || order.status === 'new' || order.status === 'cancelled') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                                title="O'chirish"
                                onClick={() => setDeleteTarget(order)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )}
        </>
      )}

      {/* Quick cost calculator dialog */}
      <QuickCostDialog open={quickCostOpen} onClose={() => setQuickCostOpen(false)} />

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
