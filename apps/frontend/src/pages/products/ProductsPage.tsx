import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart2, Loader2, Package, Pencil, Plus, ScrollText, Search, Settings2, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { PRODUCT_TYPE_LABELS, UNIT_LABELS, UNIT_OPTIONS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import {
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_CATEGORY_STYLE,
  deriveCategory,
  effectiveType,
  type ProductCategory,
} from '@/lib/productCategory';
import { cn } from '@/lib/utils';
import { apiRequest, ApiError } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { Location, Product, ProductType, StockRow, Unit } from '@/lib/types';
import { ProductFormDialog } from './ProductFormDialog';
import { RecipeDialog } from './RecipeDialog';
import { ProductDetailSheet, type Tab as DetailTab } from './ProductDetailSheet';

/** O'lchov birligi filter — unit tab UI uchun */
const UNIT_FILTER_GROUPS: FilterGroup[] = [
  {
    key: 'unit',
    label: "O'lchov birligi",
    searchable: false,
    options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
  },
];

/** Lazy render batch */
const PAGE_SIZE = 32;

/** Type tab keys */
type TypeTab = '' | ProductType;

const TYPE_TABS: { key: TypeTab; label: string; color: string }[] = [
  { key: '', label: 'Hammasi', color: '' },
  { key: 'finished', label: 'Tayyor mahsulot', color: 'emerald' },
  { key: 'semi', label: 'Yarim tayyor', color: 'violet' },
  { key: 'raw', label: 'Xom-ashyo', color: 'slate' },
];

/** Category display order for "Tayyor" tab grouping */
const FINISHED_GROUP_ORDER: ProductCategory[] = [
  'cake', 'pastry', 'bread', 'drink', 'decoration', 'finished',
];

export function ProductsPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const isSuperAdmin = user?.role === 'super_admin' || user?.role === 'pm';
  const canCreate = isSuperAdmin || user?.role === 'raw_warehouse_manager';
  const canEdit   = isSuperAdmin || user?.role === 'raw_warehouse_manager';
  const canDelete = isSuperAdmin;
  const canEditRecipe = isSuperAdmin || user?.role === 'production_manager';

  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [view, setView] = useViewMode('products', 'card');

  // Type tab
  const [selectedType, setSelectedType] = useState<TypeTab>('');
  // Unit-only filter (kept separate from type)
  const [unitFilter, setUnitFilter] = useState<FilterValue>({ unit: [] });
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Below-min filter
  const [belowMinOnly, setBelowMinOnly] = useState(false);
  const [belowMinIds, setBelowMinIds] = useState<Set<number>>(new Set());
  const [belowMinLoading, setBelowMinLoading] = useState(false);

  // Dialogs
  const [createOpen, setCreateOpen]     = useState(false);
  const [editProduct, setEditProduct]   = useState<Product | null>(null);
  const [recipeProduct, setRecipeProduct] = useState<Product | null>(null);
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);
  const [detailInitTab, setDetailInitTab] = useState<DetailTab | undefined>(undefined);
  const [deleteProduct, setDeleteProduct] = useState<Product | null>(null);
  const [isDeleting, setIsDeleting]     = useState(false);

  // Bulk selection / edit
  const [selectedIds, setSelectedIds]   = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen]         = useState(false);
  const [bulkSaving, setBulkSaving]     = useState(false);
  const [bulkForm, setBulkForm]         = useState({ prodLoc: '', storLoc: '', minQty: '', maxQty: '' });

  function openDetail(p: Product, tab?: DetailTab) {
    setDetailInitTab(tab);
    setDetailProduct(p);
  }

  const { data, isLoading, error, refetch } = useApiQuery<Product[]>('/api/products');
  const allProducts = useMemo(() => data ?? [], [data]);

  const { data: productionLocsData } = useApiQuery<Location[]>(bulkOpen ? '/api/locations?type=production' : null);
  const { data: allLocsData } = useApiQuery<Location[]>(bulkOpen ? '/api/locations' : null);
  const productionLocs = productionLocsData ?? [];
  const allLocs = allLocsData ?? [];

  // Fetch product IDs that are below minimum in any warehouse
  useEffect(() => {
    if (!belowMinOnly) {
      setBelowMinIds(new Set());
      return;
    }
    let cancelled = false;
    setBelowMinLoading(true);
    apiRequest<StockRow[]>('/api/stock?below_min=true')
      .then((rows) => {
        if (!cancelled) setBelowMinIds(new Set(rows.map((r) => r.product_id)));
      })
      .catch(() => { if (!cancelled) setBelowMinIds(new Set()); })
      .finally(() => { if (!cancelled) setBelowMinLoading(false); });
    return () => { cancelled = true; };
  }, [belowMinOnly]);

  // ── Stats (from allProducts, unfiltered) ──────────────────────────────────
  const stats = useMemo(() => {
    let totalCount = 0;
    const qtyByUnit: Record<string, number> = {};
    let totalCost = 0;
    let totalSell = 0;

    for (const p of allProducts) {
      totalCount++;
      const qty = p.total_qty ?? 0;
      if (qty > 0) {
        qtyByUnit[p.unit] = (qtyByUnit[p.unit] ?? 0) + qty;
      }
      if (p.cost_price && p.cost_price > 0 && qty > 0) {
        totalCost += p.cost_price * qty;
      }
      if (p.sell_price && p.sell_price > 0 && qty > 0) {
        totalSell += p.sell_price * qty;
      }
    }

    const markup =
      totalCost > 0 ? ((totalSell - totalCost) / totalCost) * 100 : null;

    // Xom-ashyo count
    const rawCount = allProducts.filter((p) => effectiveType(p) === 'raw').length;

    return { totalCount, rawCount, qtyByUnit, totalCost, totalSell, markup };
  }, [allProducts]);

  // Per-tab counts (from full list, not filtered)
  const typeCounts = useMemo<Record<TypeTab, number>>(() => {
    const c: Record<TypeTab, number> = { '': 0, raw: 0, semi: 0, finished: 0 };
    for (const p of allProducts) {
      c['']++;
      c[effectiveType(p)]++;
    }
    return c;
  }, [allProducts]);

  const selectedUnits = unitFilter.unit ?? [];

  const filtered = useMemo(() => {
    return allProducts.filter((p) => {
      if (selectedType !== '' && effectiveType(p) !== selectedType) return false;
      if (selectedUnits.length > 0 && !selectedUnits.includes(p.unit as Unit)) return false;
      if (!matchesSearch(`${p.name} ${p.sku ?? ''}`, search)) return false;
      if (belowMinOnly && !belowMinIds.has(p.id)) return false;
      return true;
    });
  }, [allProducts, selectedType, selectedUnits, search, belowMinOnly, belowMinIds]);

  // Group products by category when viewing "Tayyor mahsulot"
  const grouped = useMemo<{ cat: ProductCategory | null; items: Product[] }[]>(() => {
    if (selectedType === 'finished') {
      const map = new Map<ProductCategory, Product[]>();
      for (const cat of FINISHED_GROUP_ORDER) map.set(cat, []);
      for (const p of filtered) {
        const cat = deriveCategory(p);
        const bucket = map.get(cat);
        if (bucket) bucket.push(p);
        else map.get('finished')!.push(p);
      }
      return FINISHED_GROUP_ORDER
        .map((cat) => ({ cat, items: map.get(cat) ?? [] }))
        .filter((g) => g.items.length > 0);
    }
    return [{ cat: null, items: filtered }];
  }, [filtered, selectedType]);

  // Pagination only for ungrouped views
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filtered.length, selectedType]);

  const flatVisible =
    grouped.length === 1 && grouped[0]!.cat === null
      ? grouped[0]!.items.slice(0, visibleCount)
      : null;
  const hasMore = flatVisible !== null && flatVisible.length < filtered.length;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisibleCount((c) => c + PAGE_SIZE);
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, flatVisible?.length]);

  async function handleDelete() {
    if (!deleteProduct) return;
    setIsDeleting(true);
    try {
      await apiRequest(`/api/products/${deleteProduct.id}`, { method: 'DELETE' });
      notify('success', `"${deleteProduct.name}" o'chirildi.`);
      setDeleteProduct(null);
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "O'chirishda xatolik yuz berdi.");
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleBulkSave() {
    if (selectedIds.size === 0) return;
    const body: Record<string, number | null | number[]> = { ids: Array.from(selectedIds) };
    if (bulkForm.prodLoc !== '') body.production_location_id = bulkForm.prodLoc === '__clear__' ? null : Number(bulkForm.prodLoc);
    if (bulkForm.storLoc !== '') body.storage_location_id = bulkForm.storLoc === '__clear__' ? null : Number(bulkForm.storLoc);
    if (bulkForm.minQty !== '') body.min_qty = bulkForm.minQty === '__clear__' ? null : Number(bulkForm.minQty);
    if (bulkForm.maxQty !== '') body.max_qty = bulkForm.maxQty === '__clear__' ? null : Number(bulkForm.maxQty);
    if (Object.keys(body).length <= 1) {
      notify('error', 'Kamida bitta maydonni o\'zgartiring.');
      return;
    }
    setBulkSaving(true);
    try {
      const result = await apiRequest<{ updated: number }>('/api/products/bulk', { method: 'PATCH', body });
      notify('success', `${result.updated ?? selectedIds.size} ta mahsulot yangilandi.`);
      setBulkOpen(false);
      setSelectedIds(new Set());
      setBulkForm({ prodLoc: '', storLoc: '', minQty: '', maxQty: '' });
      refetch();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.');
    } finally {
      setBulkSaving(false);
    }
  }

  // ─── Render helpers ───────────────────────────────────────────────────────

  function renderCard(p: Product) {
    const category = deriveCategory(p);
    const style = PRODUCT_CATEGORY_STYLE[category];
    const isNonRaw = effectiveType(p) !== 'raw';
    const qty = p.total_qty ?? 0;
    const markup =
      p.cost_price && p.cost_price > 0 && p.sell_price && p.sell_price > 0
        ? ((p.sell_price - p.cost_price) / p.cost_price) * 100
        : null;
    const fmtK = (v: number) =>
      v >= 1_000_000
        ? `${(v / 1_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 1 })}M`
        : v >= 1_000
        ? `${(v / 1_000).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}K`
        : v.toLocaleString('uz-UZ', { maximumFractionDigits: 0 });
    return (
      <div
        key={p.id}
        className={cn(
          'group flex cursor-pointer flex-col rounded-xl border border-l-4 border-border/60 bg-card/50 shadow-sm transition-all hover:bg-card hover:shadow-md',
          style.accent,
        )}
        role="button"
        tabIndex={0}
        onClick={() => openDetail(p)}
        onKeyDown={(e) => e.key === 'Enter' && openDetail(p)}
      >
        {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <Badge variant={style.badge} className="shrink-0 text-[10px] px-1.5 py-0">
              {PRODUCT_CATEGORY_LABELS[category]}
            </Badge>
            <span className="text-[10px] font-medium text-muted-foreground">
              {UNIT_LABELS[p.unit]}
            </span>
          </div>
          <p className="truncate text-sm font-semibold leading-snug">{p.name}</p>
          {p.sku && (
            <p className="truncate text-[10px] text-muted-foreground mt-0.5">SKU: {p.sku}</p>
          )}
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-3 divide-x divide-border/40 border-t border-border/40">
          <div className="flex flex-col items-center gap-0.5 py-2.5 px-1">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Qoldiq</span>
            <span className={cn('text-sm font-bold tabular-nums leading-tight', qty > 0 ? '' : 'text-muted-foreground/50')}>
              {qty > 0 ? qty.toLocaleString('uz-UZ', { maximumFractionDigits: 1 }) : '—'}
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5 py-2.5 px-1">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Tan narxi</span>
            <span className={cn('text-sm font-bold tabular-nums leading-tight', p.cost_price && p.cost_price > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/50')}>
              {p.cost_price && p.cost_price > 0 ? fmtK(p.cost_price) : '—'}
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5 py-2.5 px-1">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Sotuv</span>
            <span className={cn('text-sm font-bold tabular-nums leading-tight', p.sell_price && p.sell_price > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/50')}>
              {p.sell_price && p.sell_price > 0 ? fmtK(p.sell_price) : '—'}
            </span>
            {markup !== null && (
              <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 leading-tight">
                +{markup.toFixed(0)}%
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div
          className="flex gap-1.5 border-t border-border/40 px-4 py-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {canEdit && (
            <Button
              variant="outline"
              size="icon"
              className="size-7 shrink-0"
              title="Tahrirlash"
              onClick={() => setEditProduct(p)}
            >
              <Pencil className="size-3" />
            </Button>
          )}
          {canDelete && (
            <Button
              variant="outline"
              size="icon"
              className="size-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              title="O'chirish"
              onClick={() => setDeleteProduct(p)}
            >
              <Trash2 className="size-3" />
            </Button>
          )}
          {isNonRaw && (
            <Button
              variant="outline"
              size="icon"
              className="size-7 shrink-0"
              title="Retsept"
              onClick={() => setRecipeProduct(p)}
            >
              <ScrollText className="size-3" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  function renderGrid(items: Product[]) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {items.map(renderCard)}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-5">
      {/* ── Stats cards ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Mahsulotlar */}
        <div className="rounded-xl border border-l-4 border-l-violet-500 bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10">
              <Package className="size-5 text-violet-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">Mahsulotlar</p>
              <p className="text-2xl font-bold tabular-nums leading-tight text-violet-700 dark:text-violet-400">
                {stats.totalCount > 0 ? (
                  <>
                    {stats.totalCount}
                    <span className="ml-0.5 text-base font-semibold"> ta</span>
                    {stats.rawCount > 0 && (
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {stats.rawCount} xom
                      </span>
                    )}
                  </>
                ) : '—'}
              </p>
              {Object.keys(stats.qtyByUnit).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(stats.qtyByUnit).map(([unit, qty]) => (
                    <span
                      key={unit}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                        unit === 'kg'   ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                        : unit === 'dona' ? 'bg-violet-500/15 text-violet-700 dark:text-violet-400'
                        : unit === 'l'   ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400'
                        : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {qty.toLocaleString('uz-UZ', { maximumFractionDigits: 1 })} {UNIT_LABELS[unit as keyof typeof UNIT_LABELS] ?? unit}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tan narxdagi qiymat */}
        <div className="rounded-xl border border-l-4 border-l-amber-500 bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <TrendingDown className="size-5 text-amber-500" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Tan narxdagi qiymat</p>
              {stats.totalCost > 0 ? (
                <>
                  <p className="text-2xl font-bold tabular-nums leading-tight text-amber-600 dark:text-amber-400">
                    {stats.totalCost >= 1_000_000_000
                      ? `${(stats.totalCost / 1_000_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 2 })} mlrd`
                      : stats.totalCost >= 1_000_000
                      ? `${(stats.totalCost / 1_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 1 })} mln`
                      : stats.totalCost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">so'm</p>
                </>
              ) : (
                <p className="text-2xl font-bold text-muted-foreground/40">—</p>
              )}
            </div>
          </div>
        </div>

        {/* Sotuvdagi qiymat */}
        <div className="rounded-xl border border-l-4 border-l-emerald-500 bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
              <TrendingUp className="size-5 text-emerald-500" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Sotuvdagi qiymat</p>
              {stats.totalSell > 0 ? (
                <>
                  <p className="text-2xl font-bold tabular-nums leading-tight text-emerald-600 dark:text-emerald-400">
                    {stats.totalSell >= 1_000_000_000
                      ? `${(stats.totalSell / 1_000_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 2 })} mlrd`
                      : stats.totalSell >= 1_000_000
                      ? `${(stats.totalSell / 1_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 1 })} mln`
                      : stats.totalSell.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">so'm</p>
                </>
              ) : (
                <p className="text-2xl font-bold text-muted-foreground/40">—</p>
              )}
            </div>
          </div>
        </div>

        {/* Ustama */}
        <div className="rounded-xl border border-l-4 border-l-blue-500 bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
              <BarChart2 className="size-5 text-blue-500" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">O'rtacha ustama</p>
              <p className="text-2xl font-bold tabular-nums leading-tight text-blue-600 dark:text-blue-400">
                {stats.markup !== null ? (
                  <>
                    {stats.markup.toFixed(0)}
                    <span className="ml-0.5 text-base font-semibold">%</span>
                  </>
                ) : '—'}
              </p>
              {stats.markup !== null && stats.totalSell > 0 && stats.totalCost > 0 && (
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  foyda: {(stats.totalSell - stats.totalCost) >= 1_000_000
                    ? `${((stats.totalSell - stats.totalCost) / 1_000_000).toLocaleString('uz-UZ', { maximumFractionDigits: 1 })} mln`
                    : (stats.totalSell - stats.totalCost).toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Page header ── */}
      <PageHeader
        title="Mahsulotlar"
        description="Xom-ashyo, yarim tayyor va tayyor mahsulotlar."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {canCreate && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                Yangi mahsulot
              </Button>
            )}
          </div>
        }
      />

      {/* ── Type tabs + search + filter ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tab pills */}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {TYPE_TABS.map(({ key, label }) => {
            const count = typeCounts[key];
            const isActive = selectedType === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedType(key)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground',
                )}
              >
                {label}
                <span
                  className={cn(
                    'min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums',
                    isActive
                      ? 'bg-white/20 text-white'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search + unit filter */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative w-64">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              className="pl-9 pr-8"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <FilterPopover
            groups={UNIT_FILTER_GROUPS}
            value={unitFilter}
            onApply={setUnitFilter}
          />
          <button
            type="button"
            onClick={() => setBelowMinOnly((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all',
              belowMinOnly
                ? 'border-destructive bg-destructive text-destructive-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-destructive/50 hover:text-destructive',
            )}
          >
            {belowMinLoading
              ? <Loader2 className="size-3.5 animate-spin" />
              : <TrendingDown className="size-3.5" />}
            Minimumdan past
            {belowMinOnly && belowMinIds.size > 0 && (
              <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums">
                {belowMinIds.size}
              </span>
            )}
          </button>
          <p className="hidden text-sm text-muted-foreground sm:block">
            {filtered.length} ta
          </p>
        </div>
      </div>

      {/* ── Content ── */}
      <Card
        className={
          view === 'card' && !showMobileCards
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState message="Mahsulotlar topilmadi." />
        )}

        {/* Mobile */}
        {!isLoading && !error && filtered.length > 0 && showMobileCards && (
          <MobileCardList
            items={filtered.map((p) => {
              const category = deriveCategory(p);
              return {
                id: p.id,
                title: p.name,
                subtitle: p.sku ?? undefined,
                badge: (
                  <Badge variant={PRODUCT_CATEGORY_STYLE[category].badge}>
                    {PRODUCT_CATEGORY_LABELS[category]}
                  </Badge>
                ),
                fields: [
                  { label: 'Birlik', value: UNIT_LABELS[p.unit] },
                  { label: 'Turi', value: PRODUCT_TYPE_LABELS[effectiveType(p)] },
                ],
              };
            })}
          />
        )}

        {/* Card view — grouped */}
        {!isLoading && !error && filtered.length > 0 && !showMobileCards && view === 'card' && (
          <div className="space-y-6">
            {grouped.map(({ cat, items }, gi) => {
              const displayItems = cat === null
                ? (flatVisible ?? items)
                : items;
              return (
                <div key={cat ?? 'flat'}>
                  {/* Category group header */}
                  {cat !== null && (
                    <div className="mb-3 flex items-center gap-3">
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                        {PRODUCT_CATEGORY_LABELS[cat]}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {items.length}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  {renderGrid(displayItems)}
                  {/* Sentinel for infinite scroll (only on flat / last group) */}
                  {gi === grouped.length - 1 && hasMore && (
                    <div
                      ref={sentinelRef}
                      className="mt-4 py-4 text-center text-xs text-muted-foreground"
                    >
                      Yana yuklanmoqda…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Table view */}
        {!isLoading && !error && filtered.length > 0 && !showMobileCards && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                {canEdit && (
                  <TableHead className="w-10 pr-0">
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer rounded accent-primary"
                      checked={
                        (flatVisible ?? filtered).length > 0 &&
                        (flatVisible ?? filtered).every((p) => selectedIds.has(p.id))
                      }
                      onChange={(e) => {
                        const rows = flatVisible ?? filtered;
                        setSelectedIds(e.target.checked ? new Set(rows.map((p) => p.id)) : new Set());
                      }}
                      aria-label="Hammasini tanlash"
                    />
                  </TableHead>
                )}
                <TableHead>Nomi</TableHead>
                <TableHead>Turkum</TableHead>
                <TableHead>Turi</TableHead>
                <TableHead>Birlik</TableHead>
                <TableHead className="text-right">Qoldiq</TableHead>
                <TableHead className="text-right">Tan narxi</TableHead>
                <TableHead className="text-right">Sotuv narxi</TableHead>
                <TableHead className="text-right">Ustama</TableHead>
                <TableHead className="text-right">Amallar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(flatVisible ?? filtered).map((p) => {
                const category = deriveCategory(p);
                const isNonRaw = effectiveType(p) !== 'raw';
                const natsenka =
                  p.cost_price && p.cost_price > 0 && p.sell_price && p.sell_price > 0
                    ? ((p.sell_price - p.cost_price) / p.cost_price) * 100
                    : null;
                return (
                  <TableRow
                    key={p.id}
                    className={cn('cursor-pointer', selectedIds.has(p.id) && 'bg-primary/5')}
                    onClick={() => openDetail(p)}
                  >
                    {canEdit && (
                      <TableCell className="pr-0 w-10"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer rounded accent-primary"
                          checked={selectedIds.has(p.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            setSelectedIds(next);
                          }}
                          aria-label={`${p.name} ni tanlash`}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Badge variant={PRODUCT_CATEGORY_STYLE[category].badge}>
                        {PRODUCT_CATEGORY_LABELS[category]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {PRODUCT_TYPE_LABELS[effectiveType(p)]}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{UNIT_LABELS[p.unit]}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {(p.total_qty ?? 0) > 0
                        ? (p.total_qty ?? 0).toLocaleString('uz-UZ')
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                      {p.cost_price && p.cost_price > 0
                        ? p.cost_price.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {p.sell_price && p.sell_price > 0
                        ? p.sell_price.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {natsenka !== null
                        ? <span className={cn('font-medium', natsenka >= 0 ? 'text-blue-600' : 'text-destructive')}>{natsenka.toFixed(0)}%</span>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {canEdit && (
                          <Button variant="ghost" size="sm" onClick={() => setEditProduct(p)}>
                            <Pencil className="size-4" />
                            Tahrirlash
                          </Button>
                        )}
                        {isNonRaw && (
                          <Button variant="ghost" size="sm" onClick={() => setRecipeProduct(p)}>
                            <ScrollText className="size-4" />
                            Retsept
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteProduct(p)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* Table infinite scroll sentinel */}
        {!isLoading && !error && view === 'table' && hasMore && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
            Yana yuklanmoqda…
          </div>
        )}
      </Card>

      {/* ── Floating bulk toolbar ── */}
      {canEdit && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-full border border-border/60 bg-card px-5 py-3 shadow-lg backdrop-blur">
            <span className="text-sm font-semibold tabular-nums">{selectedIds.size} ta tanlandi</span>
            <div className="h-5 w-px bg-border" />
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="size-3.5 mr-1" />
              Bekor
            </Button>
            <Button
              size="sm"
              className="rounded-full"
              onClick={() => { setBulkForm({ prodLoc: '', storLoc: '', minQty: '', maxQty: '' }); setBulkOpen(true); }}
            >
              <Settings2 className="size-3.5 mr-1" />
              Bulk tahrirlash
            </Button>
          </div>
        </div>
      )}

      {/* ── Dialogs ── */}
      {canCreate && (
        <ProductFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSaved={refetch}
          allProducts={allProducts}
        />
      )}
      {canEdit && (
        <ProductFormDialog
          open={editProduct !== null}
          onOpenChange={(o) => { if (!o) setEditProduct(null); }}
          onSaved={refetch}
          allProducts={allProducts}
          editProduct={editProduct ?? undefined}
        />
      )}
      <RecipeDialog
        open={recipeProduct !== null}
        onOpenChange={(open) => { if (!open) setRecipeProduct(null); }}
        product={recipeProduct}
        allProducts={allProducts}
        canEdit={canEditRecipe}
        onProductClick={(p) => { setRecipeProduct(null); openDetail(p); }}
      />
      <ProductDetailSheet
        product={detailProduct}
        allProducts={allProducts}
        onClose={() => { setDetailProduct(null); setDetailInitTab(undefined); }}
        onOpenRecipe={(p) => { setDetailProduct(null); setDetailInitTab(undefined); setRecipeProduct(p); }}
        onProductClick={(p, tab) => openDetail(p, tab)}
        canEditRecipe={canEditRecipe}
        defaultTab={detailInitTab}
      />
      {/* ── Bulk edit dialog ── */}
      {canEdit && (
        <Dialog
          open={bulkOpen}
          onOpenChange={(o) => {
            if (!o) { setBulkOpen(false); setBulkForm({ prodLoc: '', storLoc: '', minQty: '', maxQty: '' }); }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="size-5 text-primary" />
              Bulk tahrirlash — {selectedIds.size} ta mahsulot
            </DialogTitle>
            <p className="text-sm text-muted-foreground -mt-1">
              Bo'sh qoldirilgan maydonlar o'zgartirilmaydi. "— Tozalash —" ni tanlasangiz, qiymat o'chiriladi.
            </p>
            <div className="space-y-4 mt-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Ishlab chiqarish sexi
                </Label>
                <Select
                  value={bulkForm.prodLoc}
                  onChange={(e) => setBulkForm({ ...bulkForm, prodLoc: e.target.value })}
                >
                  <option value="">— O'zgartirmaslik —</option>
                  <option value="__clear__">— Tozalash —</option>
                  {productionLocs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Saqlash omborxonasi
                </Label>
                <Select
                  value={bulkForm.storLoc}
                  onChange={(e) => setBulkForm({ ...bulkForm, storLoc: e.target.value })}
                >
                  <option value="">— O'zgartirmaslik —</option>
                  <option value="__clear__">— Tozalash —</option>
                  {allLocs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Min miqdor
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="O'zgartirmaslik"
                    value={bulkForm.minQty}
                    onChange={(e) => setBulkForm({ ...bulkForm, minQty: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Max miqdor
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="O'zgartirmaslik"
                    value={bulkForm.maxQty}
                    onChange={(e) => setBulkForm({ ...bulkForm, maxQty: e.target.value })}
                  />
                </div>
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button
                variant="outline"
                onClick={() => { setBulkOpen(false); setBulkForm({ prodLoc: '', storLoc: '', minQty: '', maxQty: '' }); }}
                disabled={bulkSaving}
              >
                Bekor qilish
              </Button>
              <Button onClick={handleBulkSave} disabled={bulkSaving}>
                {bulkSaving && <Loader2 className="size-4 animate-spin" />}
                Saqlash
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Delete dialog ── */}
      <Dialog
        open={deleteProduct !== null}
        onOpenChange={(o) => { if (!o) setDeleteProduct(null); }}
      >
        <DialogContent className="sm:max-w-sm">
          <div className="flex flex-col gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <Trash2 className="size-6 text-destructive" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">
                Mahsulotni o'chirish
              </DialogTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{deleteProduct?.name}</span>{' '}
                mahsuloti butunlay o'chiriladi. Bu amalni qaytarib bo'lmaydi.
              </p>
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setDeleteProduct(null)} disabled={isDeleting}>
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
