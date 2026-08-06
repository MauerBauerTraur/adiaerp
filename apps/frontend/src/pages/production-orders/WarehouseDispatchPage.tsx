import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  PackageCheck,
  Printer,
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

type StatusKey = ProductionDispatch['status'] | 'mixed';

const STATUS_CFG: Record<StatusKey, { label: string }> = {
  pending:    { label: 'Kutilmoqda' },
  dispatched: { label: 'Berildi' },
  received:   { label: 'Qabul qilindi' },
  mixed:      { label: 'Aralash' },
};

// ---------------------------------------------------------------------------
// PipelineStat — segmented bar dashboard card (clickable status filter)
// ---------------------------------------------------------------------------
type StatusFilter = 'pending' | 'dispatched' | 'received' | null;

function PipelineStat({
  items,
  statusFilter,
  onStatusFilter,
  dateLabel,
}: {
  items: ProductionDispatch[];
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
  dateLabel?: string;
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
          {dateLabel ?? 'Bugungi holat'}
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
// Global print — otdel bo'yicha: xomashyo + ishlab chiqarish + tushum
// ---------------------------------------------------------------------------
type OrderInfo = { id: number; product_id: number; product_name: string; qty: number; unit: string; location_id: number | null; location_name: string | null; product_type: string; production_cost: number | null; target_location_name: string | null; parent_production_order_id: number | null; parent_product_name: string | null; parent_unit: string | null; parent_qty: number | null; parent_production_cost: number | null; grandparent_production_order_id: number | null; grandparent_product_name: string | null; grandparent_unit: string | null; grandparent_qty: number | null; grandparent_production_cost: number | null };

async function openGlobalPrint(
  items: ProductionDispatch[],
  dateStr: string,
  allOrders: OrderInfo[],
) {
  function fmtN(n: number | null | undefined) {
    if (n == null) return '—';
    return n % 1 === 0 ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
  }
  function fmtMoney(n: number | null | undefined) {
    if (n == null || n === 0) return '—';
    return n.toLocaleString('uz-UZ') + " so'm";
  }

  // Pre-fetch production_cost by product name (product_id may be undefined due to BIGINT serialisation quirk)
  const costByName = new Map<string, number | null>();
  const hasNullGpCost = allOrders.some(
    o => (o.product_type === 'gp' || o.product_type === 'finished') && o.production_cost == null,
  );
  if (hasNullGpCost) {
    try {
      const allProds = await apiRequest<{ name: string; production_cost: number | null }[]>('/api/products');
      for (const prod of allProds) costByName.set(prod.name, prod.production_cost);
    } catch { /* ignore */ }
  }
  function getGpCost(item: { product_name: string; production_cost: number | null }): number | null {
    if (item.production_cost != null) return item.production_cost;
    const fetched = costByName.get(item.product_name);
    return fetched !== undefined ? fetched : null;
  }

  // Build id → order map for fast lookup
  const ordersById = new Map(allOrders.map(o => [o.id, o]));

  // Group dispatch items by to_location (sex), tracking referenced production_order_ids
  type SexEntry = { id: number | null; name: string; materials: Map<string, { unit: string; total: number }>; orderIds: Set<number> };
  const sexMap = new Map<string, SexEntry>();
  for (const item of items) {
    const key = String(item.to_location_id ?? '__null__');
    const name = item.to_location_name ?? "Noma'lum sex";
    if (!sexMap.has(key)) sexMap.set(key, { id: item.to_location_id ?? null, name, materials: new Map(), orderIds: new Set() });
    const sex = sexMap.get(key)!;
    sex.orderIds.add(item.production_order_id);
    const p = sex.materials.get(item.product_name);
    if (!p) sex.materials.set(item.product_name, { unit: item.product_unit, total: item.qty_needed });
    else p.total += item.qty_needed;
  }
  const sexes = [...sexMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const thS = 'padding:6px 8px;border:1px solid #ddd;background:#f0f0f0;font-size:11px;text-align:left;';
  const thSR = thS + 'text-align:right;';
  const tdS = 'padding:5px 8px;border:1px solid #ddd;font-size:12px;';
  const tdSR = tdS + 'text-align:right;font-variant-numeric:tabular-nums;';

  const sections = sexes.map(sex => {
    // --- Xomashyo section ---
    const matRows = [...sex.materials.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, m]) => `<tr>
        <td style="${tdS}">${name}</td>
        <td style="${tdSR}">${fmtN(m.total)}</td>
        <td style="${tdS}">${m.unit}</td>
        <td style="padding:5px 8px;border:1px solid #ddd;text-align:center;">&#9633;</td>
      </tr>`).join('');

    const xomashyoSection = `
      <p style="margin:10px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">
        Beriladigan xomashyo
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
        <thead><tr>
          <th style="${thS}">Xomashyo</th>
          <th style="${thSR}">Miqdor</th>
          <th style="${thS}">Birlik</th>
          <th style="padding:6px 8px;border:1px solid #ddd;background:#f0f0f0;font-size:11px;text-align:center;">Berildi</th>
        </tr></thead>
        <tbody>${matRows}</tbody>
      </table>`;

    // Split orders into zagotovkas and GP (final) products.
    // Traverse full chain (ordersById) to find root GP for multi-level hierarchies.
    function glGetRootGP(startId: number): { id: number; product_id: number | null; product_name: string; qty: number; unit: string; production_cost: number | null } {
      let cur = ordersById.get(startId);
      if (!cur) return { id: startId, product_id: null, product_name: '?', qty: 0, unit: '', production_cost: null };
      const visited = new Set<number>();
      while (cur.parent_production_order_id != null && !visited.has(cur.parent_production_order_id)) {
        visited.add(cur.id);
        const par = ordersById.get(cur.parent_production_order_id);
        if (!par) {
          if (cur.grandparent_production_order_id != null && cur.grandparent_product_name) {
            return { id: cur.grandparent_production_order_id, product_id: null, product_name: cur.grandparent_product_name, qty: cur.grandparent_qty ?? cur.parent_qty ?? cur.qty, unit: cur.grandparent_unit ?? cur.parent_unit ?? cur.unit ?? '', production_cost: cur.grandparent_production_cost ?? cur.parent_production_cost ?? cur.production_cost };
          }
          return { id: cur.parent_production_order_id, product_id: null, product_name: cur.parent_product_name ?? cur.product_name, qty: cur.parent_qty ?? cur.qty, unit: cur.parent_unit ?? cur.unit ?? '', production_cost: cur.parent_production_cost ?? cur.production_cost };
        }
        cur = par;
      }
      return { id: cur.id, product_id: cur.product_id, product_name: cur.product_name, qty: cur.qty, unit: cur.unit ?? '', production_cost: cur.production_cost };
    }
    const glZagItems: { product_name: string; qty: number; unit: string }[] = [];
    const glGpByName = new Map<string, { product_id: number | null; product_name: string; qty: number; unit: string; production_cost: number | null }>();
    const seenGlRootIds = new Set<number>();
    for (const ordId of sex.orderIds) {
      const o = ordersById.get(ordId);
      if (!o) continue;
      if (o.product_type === 'semi') {
        glZagItems.push({ product_name: o.product_name, qty: o.qty, unit: o.unit ?? '' });
        if (o.parent_production_order_id != null) {
          const root = glGetRootGP(o.parent_production_order_id);
          if (!seenGlRootIds.has(root.id)) {
            seenGlRootIds.add(root.id);
            glGpByName.set(root.product_name, root);
          }
        }
      } else {
        const existing = glGpByName.get(o.product_name);
        if (existing) { existing.qty += o.qty; }
        else { glGpByName.set(o.product_name, { product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '', production_cost: o.production_cost }); }
      }
    }
    // If semi items found but no GP resolved via parent chain, look for GP orders at this location
    if (glZagItems.length > 0) {
      for (const o of ordersById.values()) {
        if (o.location_name === sex.name && (o.product_type === 'gp' || o.product_type === 'finished') && !glGpByName.has(o.product_name)) {
          glGpByName.set(o.product_name, { product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '', production_cost: o.production_cost });
        }
      }
    }
    const glGpItems = [...glGpByName.values()];

    let zagSection = '';
    if (glZagItems.length > 0) {
      const zagRows = glZagItems.map(z => `<tr>
        <td style="${tdS}">${z.product_name}</td>
        <td style="${tdSR}">${fmtN(z.qty)} ${z.unit}</td>
        <td style="padding:5px 8px;border:1px solid #ddd;text-align:center">&#9633;</td>
      </tr>`).join('');
      zagSection = `
        <p style="margin:14px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">Zagotovkalar</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
          <thead><tr>
            <th style="${thS}">Zagotovka</th>
            <th style="${thSR}">Miqdor</th>
            <th style="padding:6px 8px;border:1px solid #ddd;background:#f0f0f0;font-size:11px;text-align:center;">Tayyor</th>
          </tr></thead>
          <tbody>${zagRows}</tbody>
        </table>`;
    }

    let gpSection = '';
    if (glGpItems.length > 0) {
      const gpRows = glGpItems.map(o => { const c = getGpCost(o); return `<tr>
        <td style="${tdS}">${o.product_name}</td>
        <td style="${tdSR}">${fmtN(o.qty)} ${o.unit}</td>
        <td style="${tdSR}">${c != null ? fmtMoney(c) : '—'}</td>
        <td style="${tdSR}">${c != null ? fmtMoney(o.qty * c) : '—'}</td>
      </tr>`; }).join('');
      const glTotalCost = glGpItems.reduce((s, o) => { const c = getGpCost(o); return s + (c != null ? o.qty * c : 0); }, 0);
      const glHasCost = glGpItems.some(o => getGpCost(o) != null);
      const gpTotalRow = `<tr style="background:#fef9f0;font-weight:700">
        <td style="${tdS}font-weight:700" colspan="3">JAMI</td>
        <td style="${tdSR}font-weight:700;color:#d97706">${glHasCost ? fmtMoney(glTotalCost) : '—'}</td>
      </tr>`;
      gpSection = `
        <p style="margin:14px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">Tayyor mahsulot (Г/П)</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
          <thead><tr>
            <th style="${thS}">Mahsulot</th>
            <th style="${thSR}">Miqdor</th>
            <th style="${thSR}">Narx/birlik</th>
            <th style="${thSR}">Jami summa</th>
          </tr></thead>
          <tbody>${gpRows}${gpTotalRow}</tbody>
        </table>
        ${glHasCost ? `<div style="background:#fef9f0;border:1px solid #fed7aa;border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:12px;color:#92400e;font-weight:600">Jami ishlab chiqarish narxi:</span>
          <span style="font-size:15px;font-weight:700;color:#d97706">${fmtMoney(glTotalCost)}</span>
        </div>` : ''}`;
    }

    return `<div style="page-break-inside:avoid;margin-bottom:20px;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">
      <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;border-bottom:2px solid #333;padding-bottom:6px">${sex.name}</h3>
      ${xomashyoSection}${zagSection}${gpSection}
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Xomashyo berish — ${dateStr}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;margin:20px;color:#111;font-size:13px}
      h1{font-size:17px;font-weight:700;margin-bottom:4px}
      .subtitle{color:#6b7280;font-size:12px;margin-bottom:16px}
      @media print{@page{margin:10mm}body{margin:10px}}
      .footer{margin-top:24px;display:flex;gap:60px;font-size:11px;color:#555}
      .sig{border-top:1px solid #555;padding-top:4px;min-width:180px}
    </style>
  </head><body>
    <h1>Xomashyo berish — ${dateStr}</h1>
    <p class="subtitle">Jami ${sexes.length} ta sex</p>
    ${sections}
    <div class="footer">
      <div class="sig">Berdi: _________________________</div>
      <div class="sig">Qabul qildi: _________________________</div>
      <div class="sig">Sana: ${dateStr}</div>
    </div>
    <script>window.onload=function(){window.print()}<\/script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
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
  orderById: Map<number, OrderInfo>;
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

        {/* Checkbox action */}
        <div className="shrink-0 w-7 flex justify-center">
          {allReceived ? (
            /* Received — filled green */
            <div className="size-5 rounded border-2 border-emerald-500 bg-emerald-500 flex items-center justify-center">
              <Check className="size-3 text-white" strokeWidth={3} />
            </div>
          ) : isWarehouse && pendingIds.length > 0 ? (
            /* Pending — empty checkbox, click → berildi */
            <button
              type="button"
              title="Berildi deb belgilash"
              onClick={() => onDispatch(pendingIds)}
              disabled={busyItem === -1 || pendingIds.some((id) => busyItem === id)}
              className="size-5 rounded border-2 border-amber-400 bg-background hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center justify-center disabled:opacity-50 transition-colors"
            >
              {(busyItem === -1 || pendingIds.some((id) => busyItem === id)) && (
                <Loader2 className="size-3 animate-spin text-amber-500" />
              )}
            </button>
          ) : canReceive && dispatchedIds.length > 0 ? (
            /* Dispatched — blue check, click → qabul */
            <button
              type="button"
              title="Qabul qilindi deb belgilash"
              onClick={() => onReceive(dispatchedIds)}
              disabled={busyItem === -1 || dispatchedIds.some((id) => busyItem === id)}
              className="size-5 rounded border-2 border-blue-400 bg-blue-400/15 hover:bg-blue-400/25 flex items-center justify-center disabled:opacity-50 transition-colors"
            >
              {(busyItem === -1 || dispatchedIds.some((id) => busyItem === id)) ? (
                <Loader2 className="size-3 animate-spin text-blue-500" />
              ) : (
                <Check className="size-3 text-blue-500" strokeWidth={3} />
              )}
            </button>
          ) : (
            /* No action available — dim square */
            <div className="size-5 rounded border-2 border-border/30" />
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
                <div className="w-6 shrink-0 flex justify-center">
                  {isReceived ? (
                    <div className="size-4 rounded border-2 border-emerald-500 bg-emerald-500 flex items-center justify-center">
                      <Check className="size-2.5 text-white" strokeWidth={3} />
                    </div>
                  ) : isPending && canDispatchItem(item, isWarehouse, isProdManager) ? (
                    <button
                      disabled={isBusy}
                      onClick={() => onDispatch([item.id])}
                      title="Berildi deb belgilash"
                      className="size-4 rounded border-2 border-amber-400 bg-background hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center justify-center disabled:opacity-50 transition-colors"
                    >
                      {isBusy && <Loader2 className="size-2.5 animate-spin text-amber-500" />}
                    </button>
                  ) : isDispatched && canReceive ? (
                    <button
                      disabled={isBusy}
                      onClick={() => onReceive([item.id])}
                      title="Qabul qilindi deb belgilash"
                      className="size-4 rounded border-2 border-blue-400 bg-blue-400/15 hover:bg-blue-400/25 flex items-center justify-center disabled:opacity-50 transition-colors"
                    >
                      {isBusy ? (
                        <Loader2 className="size-2.5 animate-spin text-blue-500" />
                      ) : (
                        <Check className="size-2.5 text-blue-500" strokeWidth={3} />
                      )}
                    </button>
                  ) : (
                    <div className="size-4 rounded border-2 border-border/30" />
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
  defaultOpen,
}: {
  group: DispatchGroup;
  isWarehouse: boolean;
  isProdManager: boolean;
  canReceive: boolean;
  orderById: Map<number, OrderInfo>;
  onChanged: () => void;
  defaultOpen?: boolean;
}) {
  const { notify } = useToast();
  const [busyItem, setBusyItem] = useState<number | null>(null);

  const allReceived = group.items.every((i) => i.status === 'received');
  const hasPending = group.items.some((i) => i.status === 'pending');
  const [open, setOpen] = useState(defaultOpen ?? !allReceived);

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

  async function openLocationPrint() {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    function fmtN(n: number | null | undefined) {
      if (n == null) return '—';
      return n % 1 === 0 ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
    }
    function fmtMoney(n: number | null | undefined) {
      if (n == null || n === 0) return '—';
      return n.toLocaleString('uz-UZ') + " so'm";
    }

    const thS = 'padding:6px 10px;border:1px solid #ddd;background:#f5f5f5;font-size:12px;text-align:left;';
    const thSR = thS + 'text-align:right;';
    const tdS = 'padding:6px 10px;border:1px solid #ddd;font-size:12px;';
    const tdSR = tdS + 'text-align:right;font-variant-numeric:tabular-nums;';

    const xomRows = productGroups
      .map(pg => `<tr>
        <td style="${tdS}">${pg.productName}</td>
        <td style="${tdSR}">${pg.totalQty.toLocaleString('uz-UZ')}</td>
        <td style="${tdS}">${pg.productUnit}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:center">&#9633;</td>
      </tr>`)
      .join('');

    // Traverse orderById up to find the root (GP) order for any given order ID.
    function getRootGP(startId: number): { id: number; product_id: number | null; product_name: string; qty: number; unit: string; production_cost: number | null } {
      let cur: OrderInfo | undefined = orderById.get(startId);
      if (!cur) return { id: startId, product_id: null, product_name: '?', qty: 0, unit: '', production_cost: null };
      const visited = new Set<number>();
      while (cur.parent_production_order_id != null && !visited.has(cur.parent_production_order_id)) {
        visited.add(cur.id);
        const par = orderById.get(cur.parent_production_order_id);
        if (!par) {
          if (cur.grandparent_production_order_id != null && cur.grandparent_product_name) {
            return { id: cur.grandparent_production_order_id, product_id: null, product_name: cur.grandparent_product_name, qty: cur.grandparent_qty ?? cur.parent_qty ?? cur.qty, unit: cur.grandparent_unit ?? cur.parent_unit ?? cur.unit ?? '', production_cost: cur.grandparent_production_cost ?? cur.parent_production_cost ?? cur.production_cost };
          }
          return { id: cur.parent_production_order_id, product_id: null, product_name: cur.parent_product_name ?? cur.product_name, qty: cur.parent_qty ?? cur.qty, unit: cur.parent_unit ?? cur.unit ?? '', production_cost: cur.parent_production_cost ?? cur.production_cost };
        }
        cur = par;
      }
      return { id: cur.id, product_id: cur.product_id, product_name: cur.product_name, qty: cur.qty, unit: cur.unit ?? '', production_cost: cur.production_cost };
    }

    // Split referenced orders into zagotovkas (sub-orders) and GP (final) products.
    const referencedOrderIds = new Set(group.items.map(i => i.production_order_id));
    const zagByName = new Map<string, { product_name: string; qty: number; unit: string }>();
    const gpByName = new Map<string, { product_id: number | null; product_name: string; qty: number; unit: string; production_cost: number | null }>();
    const seenGpRootIds = new Set<number>();

    for (const ordId of referencedOrderIds) {
      const o = orderById.get(ordId);
      if (!o) continue;
      if (o.product_type === 'semi') {
        const ez = zagByName.get(o.product_name);
        if (ez) { ez.qty += o.qty; } else { zagByName.set(o.product_name, { product_name: o.product_name, qty: o.qty, unit: o.unit ?? '' }); }
        if (o.parent_production_order_id != null) {
          const root = getRootGP(o.parent_production_order_id);
          if (!seenGpRootIds.has(root.id)) {
            seenGpRootIds.add(root.id);
            gpByName.set(root.product_name, root);
          }
        }
      } else {
        const existing = gpByName.get(o.product_name);
        if (existing) { existing.qty += o.qty; }
        else { gpByName.set(o.product_name, { product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '', production_cost: o.production_cost }); }
      }
    }
    // Find gp/finished orders at this location (match by name — location_id may be BIGINT-as-string from pg)
    for (const o of orderById.values()) {
      if ((o.product_type === 'gp' || o.product_type === 'finished') && !gpByName.has(o.product_name)) {
        if (o.location_name === group.locationName) {
          gpByName.set(o.product_name, { product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '', production_cost: o.production_cost });
        }
      }
    }
    const zagItems = [...zagByName.values()];
    const gpItems = [...gpByName.values()];

    // Fetch production_cost by product name (product_id may be undefined due to BIGINT serialisation quirk)
    const locCostByName = new Map<string, number | null>();
    if (gpItems.some(i => i.production_cost == null)) {
      try {
        const allProds = await apiRequest<{ name: string; production_cost: number | null }[]>('/api/products');
        for (const prod of allProds) locCostByName.set(prod.name, prod.production_cost);
      } catch { /* ignore */ }
    }
    function getGpCost(i: { product_name: string; production_cost: number | null }): number | null {
      if (i.production_cost != null) return i.production_cost;
      const fetched = locCostByName.get(i.product_name);
      return fetched !== undefined ? fetched : null;
    }

    // ZAGOTOVKALAR section
    let zagSection = '';
    if (zagItems.length > 0) {
      const zagRows = zagItems.map(z => `<tr>
        <td style="${tdS}">${z.product_name}</td>
        <td style="${tdSR}">${fmtN(z.qty)} ${z.unit}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:center">&#9633;</td>
      </tr>`).join('');
      zagSection = `
        <p style="margin:16px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">Zagotovkalar</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
          <thead><tr>
            <th style="${thS}">Zagotovka</th>
            <th style="${thSR}">Miqdor</th>
            <th style="padding:6px 10px;border:1px solid #ddd;background:#f5f5f5;font-size:12px;text-align:center;">Tayyor</th>
          </tr></thead>
          <tbody>${zagRows}</tbody>
        </table>`;
    }

    // TAYYOR MAHSULOT (GP) section
    let gpSection = '';
    if (gpItems.length > 0) {
      const gpRows = gpItems.map(o => { const c = getGpCost(o); return `<tr>
        <td style="${tdS}">${o.product_name}</td>
        <td style="${tdSR}">${fmtN(o.qty)} ${o.unit}</td>
        <td style="${tdSR}">${c != null ? fmtMoney(c) : '—'}</td>
        <td style="${tdSR}">${c != null ? fmtMoney(o.qty * c) : '—'}</td>
      </tr>`; }).join('');
      const totalCost = gpItems.reduce((s, o) => { const c = getGpCost(o); return s + (c != null ? o.qty * c : 0); }, 0);
      const hasCost = gpItems.some(o => getGpCost(o) != null);
      const totalRow = `<tr style="background:#fef9f0;font-weight:700">
        <td style="${tdS}font-weight:700" colspan="3">JAMI</td>
        <td style="${tdSR}font-weight:700;color:#d97706">${hasCost ? fmtMoney(totalCost) : '—'}</td>
      </tr>`;
      gpSection = `
        <p style="margin:16px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">Tayyor mahsulot (Г/П)</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
          <thead><tr>
            <th style="${thS}">Mahsulot</th>
            <th style="${thSR}">Miqdor</th>
            <th style="${thSR}">Narx/birlik</th>
            <th style="${thSR}">Jami summa</th>
          </tr></thead>
          <tbody>${gpRows}${totalRow}</tbody>
        </table>
        ${hasCost ? `<div style="background:#fef9f0;border:1px solid #fed7aa;border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:12px;color:#92400e;font-weight:600">Jami ishlab chiqarish narxi:</span>
          <span style="font-size:15px;font-weight:700;color:#d97706">${fmtMoney(totalCost)}</span>
        </div>` : ''}`;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${group.locationName} — Xomashyo ro'yxati</title>
      <style>
        body{font-family:Arial,sans-serif;margin:24px;color:#111}
        h2{margin:0 0 4px}
        p.sub{margin:0 0 16px;color:#555;font-size:13px}
        table{width:100%;border-collapse:collapse}
        .footer{margin-top:32px;font-size:12px;color:#555}
        @media print{@page{margin:10mm}}
      </style>
    </head><body>
      <h2>${group.locationName}</h2>
      <p class="sub">Sana: ${dateStr}</p>
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:.5px;">Beriladigan xomashyo</p>
      <table style="margin-bottom:10px">
        <thead><tr>
          <th style="${thS}">Mahsulot</th>
          <th style="${thSR}">Miqdor</th>
          <th style="${thS}">Birlik</th>
          <th style="padding:6px 10px;border:1px solid #ddd;background:#f5f5f5;font-size:12px;text-align:center;">Berildi &#10003;</th>
        </tr></thead>
        <tbody>${xomRows}</tbody>
      </table>
      ${zagSection}${gpSection}
      <div class="footer">
        <p>Berdi: _____________________________ &nbsp;&nbsp;&nbsp; Qabul qildi: _____________________________</p>
      </div>
      <script>window.print();<\/script>
    </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }

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

        {/* PDF print button */}
        <button
          type="button"
          onClick={() => { void openLocationPrint(); }}
          title="PDF chop etish"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Printer className="size-3.5" />
        </button>

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
  orderById: Map<number, OrderInfo>;
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
  gp:       { title: 'Готовая продукция', description: 'Готовая продукция uchun xomashyo berish' },
};

export function WarehouseDispatchPage({ productTypeFilter }: { productTypeFilter?: 'raw' | 'semi' | 'finished' | 'gp' }) {
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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

  const effectiveKey = selectedKey ?? (groups.length > 0 ? String(groups[0]!.locationId ?? '__null__') : null);
  const selectedGroup = groups.find((g) => String(g.locationId ?? '__null__') === effectiveKey) ?? null;

  const printOnly = productTypeFilter === 'raw' || productTypeFilter === 'semi';

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
    const m = new Map<number, OrderInfo>();
    for (const o of orders) m.set(o.id, {
      id: o.id, product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '',
      location_id: o.location_id, location_name: o.location_name ?? null, product_type: o.product_type, production_cost: o.production_cost,
      target_location_name: o.target_location_name ?? null,
      parent_production_order_id: o.parent_production_order_id,
      parent_product_name: o.parent_product_name, parent_unit: o.parent_unit,
      parent_qty: o.parent_qty, parent_production_cost: o.parent_production_cost,
      grandparent_production_order_id: o.grandparent_production_order_id ?? null,
      grandparent_product_name: o.grandparent_product_name ?? null,
      grandparent_unit: o.grandparent_unit ?? null,
      grandparent_qty: o.grandparent_qty ?? null,
      grandparent_production_cost: o.grandparent_production_cost ?? null,
    });
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
            {!printOnly && isWarehouse && allPendingIds.length > 0 && (
              <Button onClick={batchDispatchAll} disabled={busyBulkAll} className="gap-2">
                {busyBulkAll ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Hammasini berildi ({allPendingIds.length})
              </Button>
            )}
            {!printOnly && canReceive && allDispatchedIds.length > 0 && (
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
            {dispatchItems.length > 0 && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => { void openGlobalPrint(dispatchItems, dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`, orders.map(o => ({ id: o.id, product_id: o.product_id, product_name: o.product_name, qty: o.qty, unit: o.unit ?? '', location_id: o.location_id, location_name: o.location_name ?? null, product_type: o.product_type, production_cost: o.production_cost, target_location_name: o.target_location_name ?? null, parent_production_order_id: o.parent_production_order_id, parent_product_name: o.parent_product_name, parent_unit: o.parent_unit, parent_qty: o.parent_qty, parent_production_cost: o.parent_production_cost, grandparent_production_order_id: o.grandparent_production_order_id ?? null, grandparent_product_name: o.grandparent_product_name ?? null, grandparent_unit: o.grandparent_unit ?? null, grandparent_qty: o.grandparent_qty ?? null, grandparent_production_cost: o.grandparent_production_cost ?? null }))); }}
              >
                <Printer className="size-4" />
                Chop etish
              </Button>
            )}
          </div>
        }
      />

      {/* Pipeline stat card — shown for all tabs */}
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
        dateLabel={
          dateFrom === dateTo
            ? (dateFrom === today ? 'Bugungi holat' : dateFrom)
            : `${dateFrom} — ${dateTo}`
        }
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
        <div className="flex gap-3 items-start">
          {/* Left: sex list */}
          <div className="w-60 shrink-0 space-y-1">
            {groups.map((group) => {
              const key = String(group.locationId ?? '__null__');
              const allRcv = group.items.every((i) => i.status === 'received');
              const hasPnd = group.items.some((i) => i.status === 'pending');
              const rcvCount = group.items.filter((i) => i.status === 'received').length;
              const total = group.items.length;
              const dotColor = allRcv ? 'bg-emerald-500' : hasPnd ? 'bg-amber-400' : 'bg-blue-400';
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
                    <span className={`size-2 shrink-0 rounded-full ${dotColor}`} />
                    <span className={`text-sm flex-1 truncate ${isSelected ? 'font-semibold text-primary' : 'font-medium'}`}>
                      {group.locationName}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {rcvCount}/{total}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-border/30 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${allRcv ? 'bg-emerald-500' : hasPnd ? 'bg-amber-400' : 'bg-blue-400'}`}
                      style={{ width: `${total > 0 ? Math.round((rcvCount / total) * 100) : 0}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: detail panel */}
          <div className="flex-1 min-w-0 rounded-xl border border-border/50 bg-card/60 p-4">
            {selectedGroup ? (
              <SexSection
                key={effectiveKey ?? ''}
                group={selectedGroup}
                isWarehouse={isWarehouse}
                isProdManager={isProdManager}
                canReceive={canReceive}
                orderById={orderById}
                onChanged={refetch}
                defaultOpen={true}
              />
            ) : (
              <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                Sexni tanlang
              </div>
            )}
          </div>
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
