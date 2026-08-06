import { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { FilterSheet, FilterField, FilterTrigger } from '@/components/ui/filter-sheet';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, LoadingState, ErrorState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { Location, Product } from '@/lib/types';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest } from '@/lib/api-client';
import { ProductDetailSheet } from '@/pages/products/ProductDetailSheet';

type ReportRow = {
  product_id: number;
  product_name: string;
  product_unit: string;
  product_type: string;
  opening_qty: string;
  in_qty: string;
  used_qty: string;
  sold_qty: string;
  closing_qty: string;
  in_production_qty: string;
};

type FinishedByLocRow = {
  location_id: number;
  location_name: string;
  location_type: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  product_type: string;
  qty: string;
  sell_price: string | null;
  total_value: string;
};

type Period = 'kun' | 'hafta' | 'oy' | 'yil';
type ViewMode = 'harakat' | 'omborlar' | 'xarid' | 'bozor';

type ReorderRow = {
  product_id: number;
  product_name: string;
  product_unit: string;
  current_qty: number;
  min_level: number;
  max_level: number;
  cost_price: number;
  needed_qty: number;
  estimated_total: number;
};

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'kun', label: 'Bugun' },
  { value: 'hafta', label: 'Bu hafta' },
  { value: 'oy', label: 'Bu oy' },
  { value: 'yil', label: 'Bu yil' },
];

const PRODUCT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'raw', label: 'Xomashyo' },
  { value: 'semi', label: 'Yarim tayyor' },
  { value: 'finished', label: 'Tayyor mahsulot' },
  { value: 'gp', label: 'Готовая продукция' },
];

const LOCATION_TYPE_PRESETS: Record<string, string[]> = {
  store:             ['finished', 'gp'],
  central_warehouse: ['finished', 'gp'],
  raw_warehouse:     ['raw'],
  production:        ['semi', 'finished'],
  supply:            ['semi'],
  sex_storage:       ['semi'],
};

function fmtQty(v: string | number | null | undefined): string {
  const n = Number(v);
  return Number.isFinite(n) ? formatQty(n) : '—';
}

function fmtMoney(v: string | number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

const LOC_TYPE_LABELS: Record<string, string> = {
  production:        'Sex',
  sex_storage:       'Sex ombori',
  raw_warehouse:     'Xomashyo ombori',
  central_warehouse: 'Markaziy ombor',
  store:             "Do'kon / Otdel",
  supply:            "Ta'minot",
};

export function StockReportPage() {
  const { user } = useAuth();
  const [viewMode, setViewMode] = useState<ViewMode>('harakat');
  const [period, setPeriod] = useState<Period>('oy');
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const [filterOpen, setFilterOpen] = useState(false);
  const [draftLocationId, setDraftLocationId] = useState<number | 'all'>('all');
  const [draftActiveTypes, setDraftActiveTypes] = useState<Set<string>>(new Set());

  const activeCount = (locationId !== 'all' ? 1 : 0) + (activeTypes.size > 0 ? 1 : 0);

  function openFilter() {
    setDraftLocationId(locationId);
    setDraftActiveTypes(new Set(activeTypes));
    setFilterOpen(true);
  }
  function applyFilter() {
    if (draftLocationId !== locationId) handleLocationChange(draftLocationId);
    setActiveTypes(new Set(draftActiveTypes));
    setFilterOpen(false);
  }
  function clearFilter() {
    setDraftLocationId('all');
    setDraftActiveTypes(new Set());
    setLocationId('all');
    setActiveTypes(new Set());
    setFilterOpen(false);
  }

  function toggleDraftType(type: string) {
    setDraftActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const [sheetProduct, setSheetProduct] = useState<Product | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);

  // Xarid view — inline editing & checkbox state
  const [customQty, setCustomQty] = useState<Record<number, number>>({});
  const [takenIds, setTakenIds] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  // Bozor view — qty adjustment & checkbox state
  const [bozorQty, setBozorQty] = useState<Record<number, number>>({});
  const [bozorTakenIds, setBozorTakenIds] = useState<Set<number>>(new Set());

  const isSuperUser =
    user?.role === 'pm' ||
    user?.role === 'super_admin' ||
    user?.role === 'ai_assistant';

  const { data: locations } = useApiQuery<Location[]>(
    isSuperUser ? '/api/locations' : null,
  );

  const locDropdownGroups = useMemo(() => {
    if (!locations) return [];
    const groups: Record<string, Location[]> = {};
    for (const loc of locations) {
      if (!groups[loc.type]) groups[loc.type] = [];
      (groups[loc.type] as Location[]).push(loc);
    }
    return Object.entries(groups).map(([type, locs]) => ({
      label: LOC_TYPE_LABELS[type] ?? type,
      locs,
    }));
  }, [locations]);

  function handleLocationChange(newId: number | 'all') {
    setLocationId(newId);
    if (newId === 'all') {
      setActiveTypes(new Set());
      return;
    }
    const loc = locations?.find((l) => l.id === newId);
    if (!loc) return;
    const preset = LOCATION_TYPE_PRESETS[loc.type];
    setActiveTypes(preset ? new Set(preset) : new Set());
  }


  // ── Harakat report ─────────────────────────────────────────────────
  const reportPath = useMemo(() => {
    if (viewMode !== 'harakat') return null;
    const params = new URLSearchParams({ period });
    if (locationId !== 'all') params.set('location_id', String(locationId));
    return `/api/stock/report?${params.toString()}`;
  }, [viewMode, period, locationId]);

  const { data: rows, isLoading, error } = useApiQuery<ReportRow[]>(reportPath);

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    let result =
      activeTypes.size > 0
        ? rows.filter((r) => activeTypes.has(r.product_type))
        : rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((r) => r.product_name.toLowerCase().includes(q));
    }
    return result;
  }, [rows, activeTypes, search]);

  // ── Xarid ro'yxati ────────────────────────────────────────────────
  const reorderPath = useMemo(() => {
    if (viewMode !== 'xarid' && viewMode !== 'bozor') return null;
    const params = new URLSearchParams();
    if (locationId !== 'all') params.set('location_id', String(locationId));
    const qs = params.toString();
    return `/api/stock/reorder-list${qs ? `?${qs}` : ''}`;
  }, [viewMode, locationId]);

  const { data: reorderRows, isLoading: reorderLoading, error: reorderError } =
    useApiQuery<ReorderRow[]>(reorderPath);


  // ── Omborlar qoldig'i ─────────────────────────────────────────────
  const finishedPath = useMemo(() => {
    if (viewMode !== 'omborlar') return null;
    const params = new URLSearchParams();
    if (locationId !== 'all') params.set('location_id', String(locationId));
    const qs = params.toString();
    return `/api/stock/finished-by-location${qs ? `?${qs}` : ''}`;
  }, [viewMode, locationId]);

  const { data: finishedRows, isLoading: finishedLoading, error: finishedError } =
    useApiQuery<FinishedByLocRow[]>(finishedPath);

  const finishedByLoc = useMemo(() => {
    if (!finishedRows) return [];
    const map = new Map<
      number,
      { location_id: number; location_name: string; location_type: string; products: FinishedByLocRow[]; subtotal: number }
    >();
    for (const row of finishedRows) {
      if (!map.has(row.location_id)) {
        map.set(row.location_id, {
          location_id: row.location_id,
          location_name: row.location_name,
          location_type: row.location_type,
          products: [],
          subtotal: 0,
        });
      }
      const grp = map.get(row.location_id)!;
      grp.products.push(row);
      grp.subtotal += Number(row.total_value);
    }
    return Array.from(map.values());
  }, [finishedRows]);

  const grandTotal = useMemo(
    () => finishedByLoc.reduce((s, g) => s + g.subtotal, 0),
    [finishedByLoc],
  );

  async function openProductDetail(productId: number) {
    setSheetLoading(true);
    try {
      const res = await apiRequest<{ product: Product }>(`/api/products/${productId}`);
      setSheetProduct(res.product);
    } catch {
      // ignore
    } finally {
      setSheetLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="Ostatka hisoboti"
        description="Davr bo'yicha mahsulot kirim, sarflash va qoldig'i"
      />

      {/* Filters */}
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        {/* View mode toggle */}
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          <button
            onClick={() => setViewMode('harakat')}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'harakat'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Harakat
          </button>
          <button
            onClick={() => setViewMode('omborlar')}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'omborlar'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Omborlar qoldig'i
          </button>
          <button
            onClick={() => setViewMode('xarid')}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'xarid'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Kamayayotgan xomashyo
          </button>
          <button
            onClick={() => setViewMode('bozor')}
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'bozor'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Bozor ro'yxati
          </button>
        </div>

        {/* Period — only for harakat */}
        {viewMode === 'harakat' && (
          <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  period === opt.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* Search — only for harakat */}
        {viewMode === 'harakat' && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mahsulot qidirish..."
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        )}

        <div className="ml-auto">
          <FilterTrigger onClick={openFilter} activeCount={activeCount} />
        </div>
      </Card>

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={applyFilter}
        onClear={clearFilter}
        activeCount={activeCount}
      >
        {isSuperUser && locations && locations.length > 0 && (
          <FilterField label="Ombor">
            <select
              value={String(draftLocationId)}
              onChange={(e) =>
                setDraftLocationId(e.target.value === 'all' ? 'all' : Number(e.target.value))
              }
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">Barcha skladlar</option>
              {locDropdownGroups.map(({ label, locs }) => (
                <optgroup key={label} label={label}>
                  {locs.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </FilterField>
        )}

        {viewMode === 'harakat' && (
          <FilterField label="Mahsulot turi">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setDraftActiveTypes(new Set())}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  draftActiveTypes.size === 0
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                Barchasi
              </button>
              {PRODUCT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleDraftType(opt.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    draftActiveTypes.has(opt.value)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FilterField>
        )}
      </FilterSheet>

      {/* ── Harakat view ── */}
      {viewMode === 'harakat' && (
        <>
          {isLoading && <LoadingState />}
          {error && <ErrorState message={error} />}
          {!isLoading && !error && visibleRows.length === 0 && (
            <EmptyState message="Bu davr uchun harakat topilmadi." />
          )}
          {!isLoading && !error && visibleRows.length > 0 && (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[260px]">Mahsulot</TableHead>
                    <TableHead className="text-right">Boshlanish ostatka</TableHead>
                    <TableHead className="text-right">Ishlab chiqarildi / Xarid</TableHead>
                    <TableHead className="text-right">Ishlab chiqarishda</TableHead>
                    <TableHead className="text-right">Ishlatildi</TableHead>
                    <TableHead className="text-right">Sotildi</TableHead>
                    <TableHead className="text-right">Qoldiq</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => {
                    const unit =
                      UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ??
                      row.product_unit;
                    return (
                      <TableRow
                        key={row.product_id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => void openProductDetail(row.product_id)}
                      >
                        <TableCell>
                          <span className="font-medium">{row.product_name}</span>
                          <span className="ml-1.5 text-xs text-muted-foreground">{unit}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtQty(row.opening_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {fmtQty(row.in_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sky-600 dark:text-sky-400">
                          {Number(row.in_production_qty) > 0
                            ? fmtQty(row.in_production_qty)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                          {fmtQty(row.used_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                          {fmtQty(row.sold_qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">
                          {fmtQty(row.closing_qty)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      {/* ── Kamayayotgan xomashyo view ── */}
      {viewMode === 'xarid' && (
        <>
          {reorderLoading && <LoadingState />}
          {reorderError && <ErrorState message={reorderError} />}
          {!reorderLoading && !reorderError && (reorderRows ?? []).length === 0 && (
            <EmptyState message="Minimumdan past xomashyo topilmadi. Barcha qoldiqlar yetarli." />
          )}
          {!reorderLoading && !reorderError && (reorderRows ?? []).length > 0 && (() => {
            const rows = reorderRows!;
            const tuzatildi = Object.keys(customQty).length;
            const totalBudget = rows.reduce((s, r) => {
              const qty = customQty[r.product_id] ?? r.needed_qty;
              return s + qty * r.cost_price;
            }, 0);
            const takenList = rows.filter((r) => takenIds.has(r.product_id));
            const takenTotal = takenList.reduce((s, r) => {
              const qty = customQty[r.product_id] ?? r.needed_qty;
              return s + qty * r.cost_price;
            }, 0);
            const remaining = rows.filter((r) => !takenIds.has(r.product_id)).length;
            const dateStr = new Date().toLocaleDateString('uz-UZ');

            return (
              <div className="flex flex-col gap-3">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {rows.length} ta pozitsiya · {dateStr}
                    </span>
                    {tuzatildi > 0 && (
                      <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        {tuzatildi} ta tuzatildi
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const tbody = rows.map(r => {
                        const u = UNIT_LABELS[r.product_unit as keyof typeof UNIT_LABELS] ?? r.product_unit;
                        const qty = customQty[r.product_id] ?? r.needed_qty;
                        const summa = qty * r.cost_price;
                        return `<tr>
                          <td>${r.product_name} <small>${u}</small></td>
                          <td style="text-align:right;color:#dc2626">${r.current_qty.toLocaleString('uz-UZ')}</td>
                          <td style="text-align:right">${r.min_level.toLocaleString('uz-UZ')}</td>
                          <td style="text-align:right">${r.max_level > 0 ? r.max_level.toLocaleString('uz-UZ') : '—'}</td>
                          <td style="text-align:right;font-weight:600">${qty.toLocaleString('uz-UZ')} ${u}</td>
                          <td style="text-align:right;font-weight:600">${summa > 0 ? summa.toLocaleString('uz-UZ') + " so'm" : '—'}</td>
                        </tr>`;
                      }).join('');
                      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
                        <title>Kamayayotgan xomashyo — ${dateStr}</title>
                        <style>body{font-family:Arial,sans-serif;margin:24px;font-size:13px}table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border:1px solid #ddd}th{background:#f5f5f5;font-weight:600}.num{text-align:right}tfoot td{font-weight:700;background:#f9f9f9}small{color:#888;font-size:11px}</style>
                      </head><body>
                        <h2 style="margin:0 0 4px">Kamayayotgan xomashyo</h2>
                        <p style="margin:0 0 16px;color:#666;font-size:12px">Sana: ${dateStr}</p>
                        <table><thead><tr>
                          <th>Xomashyo</th><th class="num">Qoldiq</th><th class="num">Min</th><th class="num">Max</th><th class="num">Olish</th><th class="num">Summa</th>
                        </tr></thead><tbody>${tbody}</tbody>
                        <tfoot><tr><td colspan="5" style="text-align:right">Jami summa:</td><td class="num">${totalBudget.toLocaleString('uz-UZ')} so'm</td></tr></tfoot>
                        </table><script>window.print();<\/script></body></html>`;
                      const w = window.open('', '_blank');
                      if (w) { w.document.write(html); w.document.close(); }
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                  >
                    <Printer className="size-4" />
                    Chop etish
                  </button>
                </div>

                {/* Summary cards */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-border/60 bg-zinc-900 dark:bg-zinc-800 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Bozorga ajratish</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-white">{fmtMoney(totalBudget)}</p>
                    <p className="text-xs text-zinc-400">so'm · {rows.length} ta pozitsiya</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-card p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Sarflandi</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums">{fmtMoney(takenTotal)}</p>
                    <p className="text-xs text-muted-foreground">{takenList.length} ta olindi</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-card p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">Qoldi</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmtMoney(totalBudget - takenTotal)}</p>
                    <p className="text-xs text-muted-foreground">{remaining} ta qoldi</p>
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/30 bg-muted/10">
                          <th className="w-8 py-2 pl-4" />
                          <th className="py-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Xomashyo</th>
                          <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Qoldiq</th>
                          <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Min</th>
                          <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Max</th>
                          <th className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground w-48">Olish</th>
                          <th className="py-2 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summa</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/20">
                        {rows.map((row) => {
                          const unit = UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ?? row.product_unit;
                          const customVal = customQty[row.product_id];
                          const effectiveQty = customVal ?? row.needed_qty;
                          const summa = effectiveQty * row.cost_price;
                          const isTaken = takenIds.has(row.product_id);
                          const isEditing = editingId === row.product_id;
                          return (
                            <tr key={row.product_id} className={`transition-colors hover:bg-muted/20 ${isTaken ? 'opacity-50' : ''}`}>
                              {/* Checkbox */}
                              <td className="pl-4 py-3">
                                <button
                                  type="button"
                                  onClick={() => setTakenIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(row.product_id)) next.delete(row.product_id);
                                    else next.add(row.product_id);
                                    return next;
                                  })}
                                  className={`size-4 rounded border-2 flex items-center justify-center transition-colors ${
                                    isTaken
                                      ? 'border-emerald-500 bg-emerald-500'
                                      : 'border-border/60 hover:border-emerald-400'
                                  }`}
                                >
                                  {isTaken && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
                                </button>
                              </td>
                              {/* Product name */}
                              <td className="pr-3 py-3">
                                <span className="font-semibold">{row.product_name}</span>
                                <span className="ml-1.5 text-xs text-muted-foreground">{unit}</span>
                              </td>
                              {/* Qoldiq */}
                              <td className="px-3 py-3 text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">
                                {fmtQty(row.current_qty)}
                              </td>
                              {/* Min */}
                              <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                                {fmtQty(row.min_level)}
                              </td>
                              {/* Max */}
                              <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                                {row.max_level > 0 ? fmtQty(row.max_level) : '—'}
                              </td>
                              {/* Olish — inline edit or display */}
                              <td className="px-3 py-3">
                                {isEditing ? (
                                  <div className="flex items-center justify-center gap-1.5">
                                    <input
                                      type="number"
                                      min={0}
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-right tabular-nums focus:border-emerald-500 focus:outline-none"
                                      autoFocus
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const v = Number(editValue);
                                        if (!isNaN(v) && v >= 0) {
                                          setCustomQty((prev) => ({ ...prev, [row.product_id]: v }));
                                        }
                                        setEditingId(null);
                                      }}
                                      className="rounded-md bg-zinc-900 dark:bg-zinc-100 px-2.5 py-1 text-xs font-bold text-white dark:text-zinc-900 hover:bg-zinc-700 transition-colors whitespace-nowrap"
                                    >
                                      saqlash
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-center gap-2">
                                    <span className={`font-bold tabular-nums ${customVal != null ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                                      {fmtQty(effectiveQty)}
                                      <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingId(row.product_id);
                                        setEditValue(String(effectiveQty));
                                      }}
                                      className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted transition-colors whitespace-nowrap"
                                    >
                                      o'zgartirish
                                    </button>
                                  </div>
                                )}
                              </td>
                              {/* Summa */}
                              <td className="pr-4 py-3 text-right tabular-nums font-semibold">
                                {row.cost_price > 0 ? `${fmtMoney(summa)}` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {/* Table footer */}
                  <div className="flex items-center justify-between border-t border-border/30 bg-muted/10 px-4 py-3">
                    <span className="text-sm text-muted-foreground">
                      Olindi: <span className="font-semibold text-foreground">{takenIds.size}/{rows.length}</span>
                    </span>
                    <div className="text-right">
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">Jami summa</span>
                      <p className="text-lg font-bold tabular-nums">{fmtMoney(totalBudget)} <span className="text-sm font-normal text-muted-foreground">so'm</span></p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Tavsiya etilgan miqdor max gacha to'ldirishdan chiqadi. "O'zgartirish" bilan o'zingizga kerakli miqdorni yozing — tuzatilgani sariq rangda ko'rinadi.
                </p>
              </div>
            );
          })()}
        </>
      )}

      {/* ── Bozor oxirgi narx view ── */}
      {viewMode === 'bozor' && (
        <>
          {reorderLoading && <LoadingState />}
          {reorderError && <ErrorState message={reorderError} />}
          {!reorderLoading && !reorderError && (reorderRows ?? []).length === 0 && (
            <EmptyState message="Bozorga chiqariladigan xomashyo topilmadi." />
          )}
          {!reorderLoading && !reorderError && (reorderRows ?? []).length > 0 && (() => {
            const rows = reorderRows!;
            const getQty = (id: number, fallback: number) => bozorQty[id] ?? fallback;
            const totalBudget = rows.reduce((s, r) => s + getQty(r.product_id, r.needed_qty) * r.cost_price, 0);
            const takenList = rows.filter((r) => bozorTakenIds.has(r.product_id));
            const takenTotal = takenList.reduce((s, r) => s + getQty(r.product_id, r.needed_qty) * r.cost_price, 0);
            const dateStr = new Date().toLocaleDateString('uz-UZ');

            return (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{rows.length} ta pozitsiya · {dateStr}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const tbody = rows.map(r => {
                        const u = UNIT_LABELS[r.product_unit as keyof typeof UNIT_LABELS] ?? r.product_unit;
                        const qty = getQty(r.product_id, r.needed_qty);
                        return `<tr><td>${r.product_name} <small>${u}</small></td>
                          <td style="text-align:right;color:#dc2626">${r.current_qty.toLocaleString()}</td>
                          <td style="text-align:right;font-weight:600">${qty.toLocaleString()} ${u}</td>
                          <td style="text-align:right">${r.cost_price > 0 ? r.cost_price.toLocaleString() : '—'}</td>
                          <td style="text-align:right;font-weight:600">${r.cost_price > 0 ? (qty * r.cost_price).toLocaleString() + " so'm" : '—'}</td></tr>`;
                      }).join('');
                      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bozor ro'yxati — ${dateStr}</title>
                        <style>body{font-family:Arial,sans-serif;margin:24px;font-size:13px}table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border:1px solid #ddd}th{background:#f5f5f5}.num{text-align:right}tfoot td{font-weight:700;background:#f9f9f9}small{color:#888;font-size:11px}</style>
                      </head><body><h2>Bozor ro'yxati</h2><p style="color:#666;font-size:12px">${dateStr}</p>
                        <table><thead><tr><th>Xomashyo</th><th class="num">Qoldiq</th><th class="num">Olish</th><th class="num">Oxirgi narx</th><th class="num">Summa</th></tr></thead>
                        <tbody>${tbody}</tbody>
                        <tfoot><tr><td colspan="4" style="text-align:right">Jami:</td><td class="num">${totalBudget.toLocaleString()} so'm</td></tr></tfoot>
                        </table><script>window.print();<\/script></body></html>`;
                      const w = window.open('', '_blank');
                      if (w) { w.document.write(html); w.document.close(); }
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                  >
                    <Printer className="size-4" />
                    Chop etish
                  </button>
                </div>

                {/* Summary cards */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-border/60 bg-zinc-900 dark:bg-zinc-800 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Bozorga ajratish</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-white">{fmtMoney(totalBudget)}</p>
                    <p className="text-xs text-zinc-400">so'm</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-card p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Olindi</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums">{fmtMoney(takenTotal)}</p>
                    <p className="text-xs text-muted-foreground">{takenList.length} ta pozitsiya</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-card p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">Qoldi</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmtMoney(totalBudget - takenTotal)}</p>
                    <p className="text-xs text-muted-foreground">{rows.length - takenList.length} ta pozitsiya</p>
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/30 bg-muted/10">
                          <th className="w-8 py-2 pl-4" />
                          <th className="py-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Xomashyo</th>
                          <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Qoldiq</th>
                          <th className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground w-40">Olish</th>
                          <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Oxirgi narx</th>
                          <th className="py-2 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summa</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/20">
                        {rows.map((row) => {
                          const unit = UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ?? row.product_unit;
                          const qty = getQty(row.product_id, row.needed_qty);
                          const summa = qty * row.cost_price;
                          const isTaken = bozorTakenIds.has(row.product_id);
                          return (
                            <tr key={row.product_id} className={`transition-colors hover:bg-muted/20 ${isTaken ? 'opacity-50' : ''}`}>
                              <td className="pl-4 py-3">
                                <button
                                  type="button"
                                  onClick={() => setBozorTakenIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(row.product_id)) next.delete(row.product_id);
                                    else next.add(row.product_id);
                                    return next;
                                  })}
                                  className={`size-4 rounded border-2 flex items-center justify-center transition-colors ${
                                    isTaken ? 'border-emerald-500 bg-emerald-500' : 'border-border/60 hover:border-emerald-400'
                                  }`}
                                >
                                  {isTaken && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
                                </button>
                              </td>
                              <td className="pr-3 py-3">
                                <span className="font-semibold">{row.product_name}</span>
                                <span className="ml-1.5 text-xs text-muted-foreground">{unit}</span>
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">
                                {fmtQty(row.current_qty)}
                              </td>
                              {/* +/- qty controls */}
                              <td className="px-3 py-3">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setBozorQty((prev) => ({ ...prev, [row.product_id]: Math.max(0, qty - 1) }))}
                                    className="flex size-6 items-center justify-center rounded border border-border/60 text-muted-foreground hover:bg-muted transition-colors text-xs font-bold"
                                  >
                                    −
                                  </button>
                                  <span className="w-12 text-center font-bold tabular-nums text-amber-600 dark:text-amber-400">{qty}</span>
                                  <button
                                    type="button"
                                    onClick={() => setBozorQty((prev) => ({ ...prev, [row.product_id]: qty + 1 }))}
                                    className="flex size-6 items-center justify-center rounded border border-border/60 text-muted-foreground hover:bg-muted transition-colors text-xs font-bold"
                                  >
                                    +
                                  </button>
                                </div>
                              </td>
                              {/* Oxirgi narx */}
                              <td className="px-3 py-3 text-right tabular-nums">
                                {row.cost_price > 0 ? (
                                  <span className="font-medium">{fmtMoney(row.cost_price)}</span>
                                ) : '—'}
                              </td>
                              {/* Summa */}
                              <td className="pr-4 py-3 text-right tabular-nums font-bold">
                                {row.cost_price > 0 ? fmtMoney(summa) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between border-t border-border/30 bg-muted/10 px-4 py-3">
                    <span className="text-sm text-muted-foreground">
                      Olindi: <span className="font-semibold text-foreground">{bozorTakenIds.size}/{rows.length}</span>
                    </span>
                    <div className="text-right">
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">Jami</span>
                      <p className="text-lg font-bold tabular-nums">{fmtMoney(totalBudget)} <span className="text-sm font-normal text-muted-foreground">so'm</span></p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  "Oxirgi narx" — o'sha xomashyo eng oxirgi marta qanday narxdan kelgani. Bozorchi shunga qarab qimmat olmasligi uchun. Miqdorni bosib o'zgartirish mumkin.
                </p>
              </div>
            );
          })()}
        </>
      )}

      {/* ── Omborlar qoldig'i view ── */}
      {viewMode === 'omborlar' && (
        <>
          {finishedLoading && <LoadingState />}
          {finishedError && <ErrorState message={finishedError} />}
          {!finishedLoading && !finishedError && finishedByLoc.length === 0 && (
            <EmptyState message="GP yoki Tayyor mahsulot qoldig'i topilmadi." />
          )}
          {!finishedLoading && !finishedError && finishedByLoc.length > 0 && (
            <div className="flex flex-col gap-3">
              {finishedByLoc.map((grp) => (
                <Card key={grp.location_id} className="overflow-hidden">
                  {/* Location header */}
                  <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2.5">
                    <div>
                      <span className="font-semibold">{grp.location_name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {LOC_TYPE_LABELS[grp.location_type] ?? grp.location_type}
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(grp.subtotal)}{' '}
                      <span className="text-xs font-normal text-muted-foreground">so'm</span>
                    </div>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[280px]">Mahsulot</TableHead>
                        <TableHead className="text-right">Qoldiq (son)</TableHead>
                        <TableHead className="text-right">Sotuv narxi</TableHead>
                        <TableHead className="text-right">Summa (so'm)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {grp.products.map((row) => {
                        const unit =
                          UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ??
                          row.product_unit;
                        return (
                          <TableRow
                            key={row.product_id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => void openProductDetail(row.product_id)}
                          >
                            <TableCell>
                              <span className="font-medium">{row.product_name}</span>
                              <span className="ml-1.5 text-xs text-muted-foreground">{unit}</span>
                              <span className="ml-1.5 text-xs text-sky-600 dark:text-sky-400">
                                {row.product_type === 'gp' ? 'ГП' : 'TM'}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-semibold">
                              {fmtQty(row.qty)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {row.sell_price ? fmtMoney(row.sell_price) : '—'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                              {fmtMoney(row.total_value)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Card>
              ))}

              {/* Grand total */}
              <div className="flex items-center justify-end rounded-xl border border-border bg-muted/30 px-4 py-3">
                <span className="text-sm text-muted-foreground mr-3">Umumiy summa:</span>
                <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                  {fmtMoney(grandTotal)}
                </span>
                <span className="ml-1.5 text-sm text-muted-foreground">so'm</span>
              </div>
            </div>
          )}
        </>
      )}

      {sheetLoading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/40">
          <div className="size-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      )}

      <ProductDetailSheet
        product={sheetProduct}
        allProducts={[]}
        canEditRecipe={false}
        onClose={() => setSheetProduct(null)}
        onOpenRecipe={() => {}}
      />
    </div>
  );
}