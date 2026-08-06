import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, Printer, TrendingDown, TrendingUp } from 'lucide-react';
import { FilterSheet, FilterField, FilterTrigger } from '@/components/ui/filter-sheet';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import type { ProductionCostSummary, ProductionCostGroup, ProductionCostProduct } from '@/lib/types';
import { UNIT_LABELS } from '@/lib/labels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtSum(n: number | null | undefined) {
  if (n == null) return '—';
  return n.toLocaleString('uz-UZ', { maximumFractionDigits: 0 }) + " so'm";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------
function KpiCard({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card px-5 py-4 shadow-sm space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent ?? ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocationGroup — collapsible row per sex
// ---------------------------------------------------------------------------
function LocationGroup({ group }: { group: ProductionCostGroup }) {
  const [open, setOpen] = useState(true);
  const profitPositive = group.total_profit >= 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-5 py-4 hover:bg-muted/20 transition-colors"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-left font-bold text-base">{group.location_name}</span>
        <span className="text-xs text-muted-foreground mr-2">
          {group.products.length} ta mahsulot
        </span>
        {(group.total_xomashyo_cost ?? 0) > 0 && (
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-sm font-bold text-amber-700 dark:text-amber-400 tabular-nums mr-1">
            {(group.total_xomashyo_cost ?? 0).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
          </span>
        )}
        {(group.total_profit ?? 0) !== 0 && (
          <span className={`rounded-full px-3 py-1 text-sm font-bold tabular-nums mr-2 ${profitPositive ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'}`}>
            {profitPositive ? '+' : ''}{(group.total_profit ?? 0).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
          </span>
        )}
        {(group.total_cost ?? 0) > 0 && (
          <span className="rounded-full bg-violet-500/10 px-3 py-1 text-sm font-bold text-violet-700 dark:text-violet-400 tabular-nums">
            {(group.total_cost ?? 0).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border/30 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/20">
                <th className="px-5 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mahsulot</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Miqdor</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Xomashyo (birlik)</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Jami xomashyo</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ish. narxi</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Jami ish. narxi</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sotuv narxi</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Foyda (1 dona)</th>
                <th className="px-5 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Jami foyda</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {group.products.map((p) => (
                <ProductRow key={p.product_id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProductRow({ p }: { p: ProductionCostProduct }) {
  const unitLabel = UNIT_LABELS[p.unit as keyof typeof UNIT_LABELS] ?? p.unit;

  return (
    <tr className="hover:bg-muted/10 transition-colors">
      <td className="px-5 py-3">
        <span className="font-medium">{p.product_name}</span>
        <span className="ml-1.5 text-xs text-muted-foreground">({p.order_count} buyurtma)</span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {p.total_qty.toLocaleString('uz-UZ', { maximumFractionDigits: 3 })} {unitLabel}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {p.xomashyo_cost_per_unit != null && p.xomashyo_cost_per_unit > 0 ? (
          <span className="text-amber-600 dark:text-amber-400">
            {fmtSum(p.xomashyo_cost_per_unit)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {p.total_xomashyo_cost != null && p.total_xomashyo_cost > 0 ? (
          <span className="text-amber-700 dark:text-amber-300 font-semibold">
            {fmtSum(p.total_xomashyo_cost)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {p.production_cost != null ? (
          <span className="text-violet-600 dark:text-violet-400">{fmtSum(p.production_cost)}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">
        {p.total_cost != null && p.total_cost > 0 ? fmtSum(p.total_cost) : <span className="text-muted-foreground text-xs">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
        {p.sell_price != null ? fmtSum(p.sell_price) : <span className="text-muted-foreground text-xs">—</span>}
      </td>
      {/* Foyda 1 dona */}
      <td className="px-4 py-3 text-right tabular-nums">
        {p.profit_per_unit != null ? (
          <span className={`text-sm ${(p.profit_per_unit) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {p.profit_per_unit > 0 ? '+' : ''}{fmtSum(p.profit_per_unit)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      {/* Jami foyda */}
      <td className="px-5 py-3 text-right tabular-nums">
        {p.total_profit != null ? (
          <span className={`inline-flex items-center gap-1 font-bold ${(p.total_profit) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {(p.total_profit) > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {p.total_profit > 0 ? '+' : ''}{fmtSum(p.total_profit)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function ProductionCostReport() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isProdManager = user?.role === 'production_manager';

  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(todayIso());
  const [locationFilter, setLocationFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | 'finished' | 'semi' | 'gp'>('');

  const [filterOpen, setFilterOpen] = useState(false);
  const [draftDateFrom, setDraftDateFrom] = useState(firstOfMonth());
  const [draftDateTo, setDraftDateTo] = useState(todayIso());
  const [draftLocationFilter, setDraftLocationFilter] = useState('');
  const [draftProductFilter, setDraftProductFilter] = useState('');
  const [draftTypeFilter, setDraftTypeFilter] = useState<'' | 'finished' | 'semi' | 'gp'>('');

  const activeCount =
    (dateFrom !== firstOfMonth() || dateTo !== todayIso() ? 1 : 0) +
    (locationFilter ? 1 : 0) +
    (productFilter ? 1 : 0) +
    (typeFilter ? 1 : 0);

  function openFilter() {
    setDraftDateFrom(dateFrom);
    setDraftDateTo(dateTo);
    setDraftLocationFilter(locationFilter);
    setDraftProductFilter(productFilter);
    setDraftTypeFilter(typeFilter);
    setFilterOpen(true);
  }
  function applyFilter() {
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setLocationFilter(draftLocationFilter);
    setProductFilter(draftProductFilter);
    setTypeFilter(draftTypeFilter);
    setFilterOpen(false);
  }
  function clearFilter() {
    const fm = firstOfMonth();
    const td = todayIso();
    setDraftDateFrom(fm); setDateFrom(fm);
    setDraftDateTo(td); setDateTo(td);
    setDraftLocationFilter(''); setLocationFilter('');
    setDraftProductFilter(''); setProductFilter('');
    setDraftTypeFilter(''); setTypeFilter('');
    setFilterOpen(false);
  }

  const params = new URLSearchParams();
  if (dateFrom) params.set('from', dateFrom);
  if (dateTo) params.set('to', dateTo);
  if (locationFilter) params.set('location_id', locationFilter);
  if (productFilter) params.set('product_id', productFilter);
  const path = `/api/production-orders/cost-summary?${params.toString()}`;

  const { data, isLoading, error, refetch } = useApiQuery<ProductionCostSummary>(path);

  const groups = data?.groups ?? [];

  const baseGroups = isProdManager && user?.location_id
    ? groups.filter((g) => g.location_id === user.location_id)
    : groups;

  const visibleGroups = typeFilter
    ? baseGroups
        .map((g) => ({ ...g, products: g.products.filter((p) => p.product_type === typeFilter) }))
        .filter((g) => g.products.length > 0)
    : baseGroups;

  const visibleProducts = visibleGroups.flatMap((g) => g.products);
  const grandTotal = visibleProducts.reduce((s, p) => s + (p.total_cost ?? 0), 0);
  const grandXomashyo = visibleProducts.reduce((s, p) => s + (p.total_xomashyo_cost ?? 0), 0);
  const grandRevenue = visibleProducts.reduce((s, p) => s + (p.total_revenue ?? 0), 0);
  const grandProfit = visibleProducts.reduce((s, p) => s + (p.total_profit ?? 0), 0);

  // Collect all unique products for filter select
  const allProducts = [...new Map(
    groups.flatMap((g) => g.products).map((p) => [p.product_id, p.product_name]),
  ).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  // Collect all unique locations for filter select (only for PM)
  const allLocations = !isProdManager
    ? [...new Map(groups.map((g) => [g.location_id, g.location_name])).entries()]
        .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''))
    : [];

  const profitPositive = grandProfit >= 0;

  function openPrint() {
    const dateRange = dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`;
    const sections = visibleGroups
      .map((g) => {
        const rows = g.products
          .map((p) => {
            const unitLabel = UNIT_LABELS[p.unit as keyof typeof UNIT_LABELS] ?? p.unit;
            return `<tr>
              <td style="padding:5px 8px;border:1px solid #ddd">${p.product_name}</td>
              <td style="padding:5px 8px;border:1px solid #ddd;text-align:right">${p.order_count} ta buyurtma</td>
              <td style="padding:5px 8px;border:1px solid #ddd;text-align:right">${p.total_qty.toLocaleString('uz-UZ', { maximumFractionDigits: 3 })} ${unitLabel}</td>
            </tr>`;
          })
          .join('');
        return `<h3 style="margin:16px 0 4px;font-size:13px">${g.location_name}
          <span style="font-weight:400;color:#555;font-size:11px">— ${g.products.length} ta mahsulot</span>
        </h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
          <thead><tr>
            <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left">Mahsulot</th>
            <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:right">Buyurtma</th>
            <th style="padding:6px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:right">Miqdor</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      })
      .join('');

    const totalQty = visibleProducts.reduce((s, p) => s + p.total_qty, 0);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Ishlab chiqarish — ${dateRange}</title>
      <style>body{font-family:Arial,sans-serif;margin:20px;color:#111}h1{font-size:16px;margin-bottom:4px}p{margin:0 0 12px;color:#555;font-size:12px}@media print{@page{margin:10mm}}</style>
    </head><body>
      <h1>Ishlab chiqarish hisoboti — ${dateRange}</h1>
      <p>Jami ${visibleProducts.length} ta mahsulot · ${visibleGroups.length} ta sex · ${totalQty.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} dona</p>
      ${sections}
      <div style="margin-top:24px;font-size:11px;color:#555">
        <p>Hisobot sanasi: ${new Date().toLocaleDateString('uz-UZ')}</p>
      </div>
      <script>window.onload=function(){window.print()}<\/script>
    </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Ishlab chiqarish hisoboti"
        description="Buyurtmalar bo'yicha ish narxi, xomashyo, sotuv va foyda."
        action={
          <div className="flex items-center gap-2">
            {visibleGroups.length > 0 && (
              <button
                type="button"
                onClick={openPrint}
                className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <Printer className="size-4" />
                Chop etish
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              Ortga
            </button>
          </div>
        }
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/40 px-4 py-2.5">
        <span className="text-sm text-muted-foreground">
          {dateFrom} — {dateTo}
          {activeCount > 0 && <span className="ml-2 text-xs text-primary">{activeCount} ta filter faol</span>}
        </span>
        <FilterTrigger onClick={openFilter} activeCount={activeCount} />
      </div>

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={applyFilter}
        onClear={clearFilter}
        activeCount={activeCount}
      >
        <FilterField label="Sana oraligi">
          <div className="flex flex-col gap-2">
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
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setDraftDateFrom(todayIso()); setDraftDateTo(todayIso()); }}
                className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                Bugun
              </button>
              <button
                type="button"
                onClick={() => { setDraftDateFrom(firstOfMonth()); setDraftDateTo(todayIso()); }}
                className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                Bu oy
              </button>
            </div>
          </div>
        </FilterField>

        {allLocations.length > 0 && (
          <FilterField label="Sex (joylashuv)">
            <select
              value={draftLocationFilter}
              onChange={(e) => setDraftLocationFilter(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Barcha sexlar</option>
              {allLocations.map(([id, name]) => (
                <option key={id} value={String(id)}>{name}</option>
              ))}
            </select>
          </FilterField>
        )}

        <FilterField label="Mahsulot turi">
          <div className="flex flex-wrap gap-1.5">
            {([
              { key: '' as const, label: 'Barchasi' },
              { key: 'gp' as const, label: 'Готовая продукция' },
              { key: 'finished' as const, label: 'Tayyor mahsulot' },
              { key: 'semi' as const, label: 'Yarim tayyor' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setDraftTypeFilter(key)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  draftTypeFilter === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </FilterField>

        <FilterField label="Mahsulot">
          <select
            value={draftProductFilter}
            onChange={(e) => setDraftProductFilter(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Barcha mahsulotlar</option>
            {allProducts.map(([id, name]) => (
              <option key={id} value={String(id)}>{name}</option>
            ))}
          </select>
        </FilterField>
      </FilterSheet>

      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && (
        <>
          {/* KPI row */}
          {(grandTotal > 0 || grandRevenue > 0) && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard
                label="Jami ish. narxi"
                value={`${grandTotal.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`}
                accent="text-violet-700 dark:text-violet-400"
                sub={`${visibleGroups.length} ta bo'lim`}
              />
              <KpiCard
                label="Jami xomashyo narxi"
                value={`${grandXomashyo.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`}
                accent="text-amber-600 dark:text-amber-400"
              />
              <KpiCard
                label="Jami sotuv (taxminiy)"
                value={`${grandRevenue.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <KpiCard
                label="Jami foyda"
                value={`${profitPositive ? '+' : ''}${grandProfit.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`}
                accent={profitPositive ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}
                sub="Sotuv − ish. narxi"
              />
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <EmptyState message="Bu davr uchun ma'lumot topilmadi." />
          ) : (
            <div className="space-y-3">
              {visibleGroups.map((group) => (
                <LocationGroup key={group.location_id} group={group} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
