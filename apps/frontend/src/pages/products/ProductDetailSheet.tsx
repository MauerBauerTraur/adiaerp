import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ClipboardList,
  Loader2,
  MapPin,
  Package,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState, ErrorState } from '@/components/PageState';
import { useCanAct } from '@/hooks/useCanAct';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import {
  MOVEMENT_REASON_LABELS,
  PRODUCT_TYPE_LABELS,
  UNIT_LABELS,
  RECIPE_STAGE_LABELS,
  RECIPE_STAGE_ORDER,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import {
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_CATEGORY_STYLE,
  deriveCategory,
  effectiveType,
} from '@/lib/productCategory';
import type {
  Product,
  ProductionOrder,
  RecipeLine,
  RecipeStage,
  StockMovement,
  StockRow,
  UsedInEntry,
} from '@/lib/types';
import { ProductionOrderFormDialog } from '../production-orders/ProductionOrderFormDialog';

export type Tab = 'stock' | 'orders' | 'used-in' | 'movements';

interface ProductDetailDialogProps {
  product: Product | null;
  allProducts: Product[];
  onClose: () => void;
  onOpenRecipe: (product: Product) => void;
  /** Called when user navigates to a linked product. `openTab` = the tab to pre-open. */
  onProductClick?: (product: Product, openTab?: Tab) => void;
  canEditRecipe: boolean;
  /** Tab to open when the product first loads (default: 'stock'). */
  defaultTab?: Tab;
}

function normalizeStage(s: RecipeLine['stage']): RecipeStage {
  return s != null && (RECIPE_STAGE_ORDER as string[]).includes(s as string)
    ? (s as RecipeStage)
    : 'other';
}

const NEST_BORDER_COLORS = [
  'border-violet-500/40',
  'border-violet-500/25',
  'border-violet-500/15',
  'border-violet-500/10',
];

/** Format a quantity in the product's unit for human display.
 *  kg < 1  → grams; l < 1 → ml; pcs always whole. */
function formatQty(qty: number, unitStr: string): string {
  if (unitStr === 'kg') {
    if (qty < 0.001) return `${(qty * 1_000_000).toFixed(1)} мг`;
    if (qty < 1)     return `${(qty * 1000).toFixed(qty < 0.01 ? 1 : 0)} г`;
    if (qty < 10)    return `${qty.toFixed(3)} кг`;
    return `${qty.toFixed(2)} кг`;
  }
  if (unitStr === 'l') {
    if (qty < 1) return `${(qty * 1000).toFixed(0)} мл`;
    return `${qty.toFixed(2)} л`;
  }
  const label = UNIT_LABELS[unitStr as keyof typeof UNIT_LABELS] ?? unitStr;
  return `${qty % 1 === 0 ? qty : qty.toFixed(3)} ${label}`;
}

/** Compute BOM cost per unit of the product from recipe lines.
 *  For semi-finished components, recurse into their sub-recipe instead of
 *  using the (potentially-wrong) stored cost_price. Returns 0 if cost data
 *  is missing for any component. */
function computeBomCost(
  lines: RecipeLine[],
  allProducts: Product[],
  subRecipes: Map<number, RecipeLine[]>,
  depth = 0,
): number {
  return lines.reduce((sum, line) => {
    const comp = allProducts.find((p) => p.id === line.component_product_id);
    const isSemi = line.component_type === 'semi' || line.component_type === 'finished';
    const sub = subRecipes.get(line.component_product_id);
    if (isSemi && sub && sub.length > 0 && depth < 4) {
      const subCost = computeBomCost(sub, allProducts, subRecipes, depth + 1);
      return sum + subCost * line.qty_per_unit;
    }
    const cp = comp?.cost_price ?? line.component_cost_price ?? 0;
    return sum + (cp ?? 0) * line.qty_per_unit;
  }, 0);
}

function RecipeLineRow({
  line,
  allProducts,
  subRecipes,
  depth,
  parentScale,
  onProductClick,
}: {
  line: RecipeLine;
  allProducts: Product[];
  subRecipes: Map<number, RecipeLine[]>;
  depth: number;
  parentScale: number;
  onProductClick?: (product: Product) => void;
}) {
  const comp = allProducts.find((p) => p.id === line.component_product_id);
  const isSemi = line.component_type === 'semi' || line.component_type === 'finished';
  const sub = subRecipes.get(line.component_product_id);
  const unitStr = comp?.unit ?? '';

  const displayQty    = line.qty_per_unit * parentScale;
  const displayBrutto = (line.brutto ?? 0) > 0 ? line.brutto! * parentScale : 0;
  const showBrutto    = displayBrutto > 0 && Math.abs(displayBrutto - displayQty) > 0.00001;
  const subScale      = displayQty;

  const bgClass = isSemi
    ? depth === 0
      ? 'bg-violet-500/10 border border-violet-500/20'
      : 'bg-violet-500/5 border border-violet-500/10'
    : 'bg-muted/40';

  const borderColor = NEST_BORDER_COLORS[Math.min(depth - 1, NEST_BORDER_COLORS.length - 1)] ?? 'border-violet-500/10';

  const isClickable = comp !== undefined && onProductClick !== undefined;

  const card = (
    <div className={`rounded-lg px-3 py-2 ${bgClass} ${isClickable ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-110 transition-all' : ''}`}
      onClick={isClickable ? () => onProductClick!(comp!) : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onProductClick!(comp!); } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate ${depth === 0 ? 'text-sm font-medium' : 'text-xs font-medium'} ${isClickable ? 'hover:underline' : ''}`}>
            {comp?.name ?? line.component_name ?? `#${line.component_product_id}`}
          </p>
          {depth === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {comp ? PRODUCT_TYPE_LABELS[effectiveType(comp)] : (line.component_type ?? '')}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {showBrutto ? (
            <>
              <p className="text-[10px] text-muted-foreground">
                Br: <span className="font-medium text-foreground">{formatQty(displayBrutto, unitStr)}</span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Ne: <span className={`${depth === 0 ? 'text-sm' : 'text-xs'} font-semibold text-foreground`}>{formatQty(displayQty, unitStr)}</span>
              </p>
            </>
          ) : (
            <span className={`${depth === 0 ? 'text-sm' : 'text-xs'} font-semibold`}>
              {formatQty(displayQty, unitStr)}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {card}
      {isSemi && sub && sub.length > 0 && depth < 4 && (
        <div className={`ml-3 mt-1 space-y-1 border-l-2 ${borderColor} pl-3`}>
          {sub.map((sl, si) => (
            <RecipeLineRow
              key={si}
              line={sl}
              allProducts={allProducts}
              subRecipes={subRecipes}
              depth={depth + 1}
              parentScale={subScale}
              onProductClick={onProductClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductDetailSheet({
  product,
  allProducts,
  onClose,
  onOpenRecipe,
  onProductClick,
  canEditRecipe,
  defaultTab,
}: ProductDetailDialogProps) {
  const { notify } = useToast();
  const { user } = useAuth();
  const { isOperator, canActOn } = useCanAct();
  const canCreateOrder =
    user?.role === 'super_admin' ||
    user?.role === 'pm' ||
    user?.role === 'production_manager' ||
    user?.role === 'central_warehouse_manager';

  const [tab, setTab] = useState<Tab>('stock');
  const [recipe, setRecipe] = useState<RecipeLine[] | null>(null);
  const [recipeLoading, setRecipeLoading] = useState(false);
  // Sub-recipes for semi-finished components (keyed by component_product_id)
  const [subRecipes, setSubRecipes] = useState<Map<number, RecipeLine[]>>(new Map());

  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [orders, setOrders] = useState<ProductionOrder[] | null>(null);
  const [usedIn, setUsedIn] = useState<UsedInEntry[] | null>(null);
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [tabLoading, setTabLoading] = useState(false);
  const [tabErr, setTabErr] = useState<string | null>(null);

  // Orders management state (dialogs rendered as siblings of main Dialog)
  const [selectedOrder, setSelectedOrder] = useState<ProductionOrder | null>(null);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [editOrderTarget, setEditOrderTarget] = useState<ProductionOrder | null>(null);
  const [deleteOrderTarget, setDeleteOrderTarget] = useState<ProductionOrder | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null);
  const [isDeletingOrder, setIsDeletingOrder] = useState(false);
  // Incrementing this forces the orders tab to refetch
  const [ordersKey, setOrdersKey] = useState(0);
  // Incrementing this forces the stock tab to refetch (after min/max save)
  const [stockKey, setStockKey] = useState(0);

  // Reset all state when product changes
  useEffect(() => {
    if (!product) return;
    setRecipe(null);
    setRecipeLoading(false);
    setSubRecipes(new Map());
    setTab(defaultTab ?? 'stock');
    setTabErr(null);
    setStock(null);
    setOrders(null);
    setUsedIn(null);
    setMovements(null);
    setSelectedOrder(null);
    setCreateOrderOpen(false);
    setEditOrderTarget(null);
    setDeleteOrderTarget(null);
    setBusyOrderId(null);
    setOrdersKey(0);

    if (effectiveType(product) !== 'raw') {
      let cancelled = false;
      setRecipeLoading(true);
      apiRequest<{ product_id: number; recipe: RecipeLine[] }>(
        `/api/products/${product.id}/recipe`,
      )
        .then((d) => {
          if (cancelled) return;
          setRecipe(d.recipe);
          // Recursively fetch sub-recipes for all semi-finished components (BFS, max 4 levels)
          const isSemiType = (t?: string) => t === 'semi' || t === 'finished';
          const pending = new Set<number>(
            d.recipe.filter((l) => isSemiType(l.component_type)).map((l) => l.component_product_id),
          );
          const fetched = new Set<number>();
          const map = new Map<number, RecipeLine[]>();
          const runBatch = (batch: number[]): Promise<void> => {
            if (batch.length === 0) return Promise.resolve();
            return Promise.allSettled(
              batch.map((id) =>
                apiRequest<{ product_id: number; recipe: RecipeLine[] }>(
                  `/api/products/${id}/recipe`,
                ).then((sub) => ({ id, lines: sub.recipe })),
              ),
            ).then((results) => {
              const nextBatch: number[] = [];
              for (const r of results) {
                if (r.status === 'fulfilled' && r.value.lines.length > 0) {
                  map.set(r.value.id, r.value.lines);
                  for (const sl of r.value.lines) {
                    if (isSemiType(sl.component_type) && !fetched.has(sl.component_product_id)) {
                      nextBatch.push(sl.component_product_id);
                      fetched.add(sl.component_product_id);
                    }
                  }
                }
              }
              return runBatch(nextBatch);
            });
          };
          const firstBatch = [...pending].filter((id) => { fetched.add(id); return true; });
          if (firstBatch.length > 0) {
            runBatch(firstBatch).then(() => {
              if (!cancelled) setSubRecipes(new Map(map));
            });
          }
        })
        .catch(() => { if (!cancelled) setRecipe([]); })
        .finally(() => { if (!cancelled) setRecipeLoading(false); });
      return () => { cancelled = true; };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, defaultTab]);

  // Fetch for stock / used-in / movements tabs
  useEffect(() => {
    if (!product) return;
    if (tab === 'orders') return;

    let cancelled = false;
    setTabLoading(true);
    setTabErr(null);

    const req =
      tab === 'stock'
        ? apiRequest<StockRow[]>(`/api/stock?product_id=${product.id}`)
        : tab === 'used-in'
          ? apiRequest<UsedInEntry[]>(`/api/products/${product.id}/used-in`)
          : apiRequest<{ items: StockMovement[]; total: number }>(
              `/api/stock/movements?product_id=${product.id}&limit=100`,
            );

    req
      .then((data) => {
        if (cancelled) return;
        if (tab === 'stock') setStock(data as StockRow[]);
        else if (tab === 'used-in') setUsedIn(data as UsedInEntry[]);
        else setMovements((data as { items: StockMovement[] }).items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTabErr(e instanceof ApiError ? e.message : "Yuklab bo'lmadi.");
      })
      .finally(() => { if (!cancelled) setTabLoading(false); });

    return () => { cancelled = true; };
  }, [product?.id, tab, stockKey]);

  // Dedicated fetch for orders tab (separate so ordersKey can trigger refetch)
  useEffect(() => {
    if (!product || tab !== 'orders') return;

    let cancelled = false;
    setTabLoading(true);
    setTabErr(null);

    apiRequest<ProductionOrder[]>(`/api/production-orders?product_id=${product.id}`)
      .then((data) => {
        if (cancelled) return;
        setOrders(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTabErr(e instanceof ApiError ? e.message : "Yuklab bo'lmadi.");
      })
      .finally(() => { if (!cancelled) setTabLoading(false); });

    return () => { cancelled = true; };
  }, [product?.id, tab, ordersKey]);

  function refetchOrders() {
    setOrdersKey((k) => k + 1);
  }

  async function handleSaveMinMax(
    locationId: number,
    productId: number,
    minLevel: number,
    maxLevel: number,
  ) {
    await apiRequest('/api/stock/minmax', {
      method: 'PATCH',
      body: { location_id: locationId, product_id: productId, min_level: minLevel, max_level: maxLevel },
    });
    notify('success', 'Min/Max saqlandi.');
    setStockKey((k) => k + 1);
  }

  async function transitionOrder(
    orderId: number,
    nextStatus: 'in_progress' | 'done' | 'cancelled',
  ) {
    setBusyOrderId(orderId);
    try {
      await apiRequest(`/api/production-orders/${orderId}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      notify('success', `Holat: ${PRODUCTION_ORDER_STATUS_LABELS[nextStatus]}.`);
      refetchOrders();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        notify('error', "BOM komponentlari yetarli emas — zayavka yakunlanmadi.");
      } else {
        notify('error', err instanceof ApiError ? err.message : 'Xato yuz berdi.');
      }
    } finally {
      setBusyOrderId(null);
    }
  }

  async function deleteOrder() {
    if (!deleteOrderTarget) return;
    setIsDeletingOrder(true);
    try {
      await apiRequest(`/api/production-orders/${deleteOrderTarget.id}`, {
        method: 'DELETE',
      });
      notify('success', "Zayavka o'chirildi.");
      setDeleteOrderTarget(null);
      refetchOrders();
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "O'chirib bo'lmadi.");
    } finally {
      setIsDeletingOrder(false);
    }
  }

  if (!product) return null;

  const category = deriveCategory(product);
  const style = PRODUCT_CATEGORY_STYLE[category];
  const isNonRaw = effectiveType(product) !== 'raw';

  const grouped = RECIPE_STAGE_ORDER.map((stage) => ({
    stage,
    lines: (recipe ?? []).filter((l) => normalizeStage(l.stage) === stage),
  })).filter((g) => g.lines.length > 0);

  return (
    <>
      <Sheet open={product !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
        {/* sr-only title for accessibility */}
        <span className="sr-only" id="product-detail-title">{product.name}</span>
        <SheetContent
          side="right"
          className="w-[90vw] max-w-5xl h-full flex flex-col gap-0 p-0 overflow-hidden"
          showClose={false}
        >

          {/* ── Header ── */}
          <div className={`flex items-start justify-between gap-4 border-b border-l-4 border-border ${style.accent} px-6 py-4`}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={style.badge}>{PRODUCT_CATEGORY_LABELS[category]}</Badge>
                <span className="text-xs text-muted-foreground">
                  {PRODUCT_TYPE_LABELS[effectiveType(product)]}
                </span>
                {product.sku && (
                  <span className="text-xs text-muted-foreground">
                    SKU: {product.sku}
                  </span>
                )}
              </div>
              <h2 className="mt-1 text-xl font-bold">{product.name}</h2>
              <p className="text-sm text-muted-foreground">
                O'lchov birligi: {UNIT_LABELS[product.unit]}
              </p>
              {/* Narx ma'lumotlari */}
              {(() => {
                // For semi/finished products with a loaded recipe, compute BOM cost
                // from raw ingredients instead of using Poster's prime_cost (which
                // may be wrong for semi-finished products).
                const isNonRawProduct = effectiveType(product) !== 'raw';
                const bomCost =
                  isNonRawProduct && recipe && recipe.length > 0
                    ? computeBomCost(recipe, allProducts, subRecipes)
                    : null;
                const displayCost = bomCost != null && bomCost > 0 ? bomCost : (product.cost_price ?? null);
                const useBom = bomCost != null && bomCost > 0;
                const hasCost = displayCost != null && displayCost > 0;
                const hasSell  = (product.sell_price ?? 0) > 0;
                const hasQty   = (product.total_qty ?? 0) > 0;
                if (!hasCost && !hasSell && !hasQty) return null;
                return (
                  <div className="mt-3 flex flex-wrap gap-4">
                    {hasQty && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Qoldiq</p>
                        <p className="text-base font-bold">
                          {(product.total_qty ?? 0).toLocaleString('uz-UZ')}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">{UNIT_LABELS[product.unit]}</span>
                        </p>
                      </div>
                    )}
                    {hasCost && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Tan narxi{useBom ? ' (retsept)' : ''}
                        </p>
                        <p className="text-base font-bold text-amber-600 dark:text-amber-400">
                          {displayCost!.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                          <span className="ml-1 text-xs font-normal">so'm/{UNIT_LABELS[product.unit]}</span>
                        </p>
                      </div>
                    )}
                    {hasSell && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Sotuv narxi</p>
                        <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                          {product.sell_price!.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })}
                          <span className="ml-1 text-xs font-normal">so'm</span>
                        </p>
                      </div>
                    )}
                    {hasCost && hasSell && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Ustama</p>
                        <p className="text-base font-bold text-blue-600 dark:text-blue-400">
                          {(((product.sell_price! - displayCost!) / displayCost!) * 100).toFixed(1)}%
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isNonRaw && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { onClose(); onOpenRecipe(product); }}
                >
                  <ScrollText className="size-4" aria-hidden="true" />
                  {canEditRecipe ? "Retseptni tahrirlash" : "Retseptni ko'rish"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Yopish"
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* ── Body ── */}
          <div className="flex flex-1 min-h-0 overflow-hidden">

            {/* LEFT — Recipe */}
            <div className="flex w-80 shrink-0 flex-col border-r border-border overflow-hidden">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <ScrollText className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Retsept (BOM)</span>
                {recipe !== null && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {recipe.length} ta komponent
                  </span>
                )}
              </div>
              {/* Batch yield line — shown only when batch_yield > 1 (prepack/semi) */}
              {product.batch_yield != null && product.batch_yield > 1 && (
                <div className="flex items-center gap-2 border-b border-border/50 bg-violet-500/5 px-5 py-2">
                  <span className="text-[11px] text-muted-foreground">Chiqish (batch):</span>
                  <span className="ml-auto text-[11px] font-semibold text-violet-600 dark:text-violet-400">
                    {formatQty(product.batch_yield, product.unit)}
                  </span>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-5 py-4">
                {!isNonRaw && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Xom-ashyo mahsulotida retsept bo'lmaydi.
                  </p>
                )}
                {isNonRaw && recipeLoading && <LoadingState />}
                {isNonRaw && !recipeLoading && recipe !== null && recipe.length === 0 && (
                  <div className="py-8 text-center">
                    <p className="text-sm text-muted-foreground">Retsept hali kiritilmagan.</p>
                    {canEditRecipe && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => { onClose(); onOpenRecipe(product); }}
                      >
                        Retsept qo'shish
                      </Button>
                    )}
                  </div>
                )}
                {isNonRaw && !recipeLoading && grouped.length > 0 && (
                  <div className="space-y-5">
                    {grouped.map(({ stage, lines }) => (
                      <div key={stage} className="space-y-2">
                        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <span className="h-px flex-1 bg-border" />
                          {RECIPE_STAGE_LABELS[stage]}
                          <span className="h-px flex-1 bg-border" />
                        </h3>
                        <div className="space-y-2">
                          {lines.map((l, i) => (
                            <RecipeLineRow
                              key={i}
                              line={l}
                              allProducts={allProducts}
                              subRecipes={subRecipes}
                              depth={0}
                              parentScale={product.batch_yield ?? 1}
                              onProductClick={onProductClick}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT — Tabs */}
            <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
              <div className="flex border-b border-border">
                {(
                  [
                    { key: 'stock', label: 'Qoldiqlar', icon: BarChart3 },
                    { key: 'orders', label: 'Zayavkalar', icon: ClipboardList },
                    { key: 'movements', label: 'Harakatlar', icon: Activity },
                    { key: 'used-in', label: 'Ishlatilgan', icon: Package },
                  ] as const
                ).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                      tab === key
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto p-5">
                {tabLoading && tab !== 'orders' && <LoadingState />}
                {!tabLoading && tabErr && tab !== 'orders' && <ErrorState message={tabErr} />}

                {!tabLoading && !tabErr && tab === 'stock' && (
                  <StockPanel
                    rows={stock}
                    unit={product.unit}
                    canEditMinMax={isOperator || user?.role === 'pm' || user?.role === 'super_admin'}
                    onSaveMinMax={handleSaveMinMax}
                  />
                )}

                {tab === 'orders' && (
                  <OrdersPanel
                    orders={orders}
                    tabLoading={tabLoading}
                    tabErr={tabErr}
                    product={product}
                    busyId={busyOrderId}
                    isOperator={isOperator}
                    isPm={user?.role === 'pm' || user?.role === 'super_admin'}
                    canCreateOrder={canCreateOrder}
                    canActOn={canActOn}
                    onOrderClick={setSelectedOrder}
                    onTransition={transitionOrder}
                    onEdit={setEditOrderTarget}
                    onDelete={setDeleteOrderTarget}
                    onCreate={() => setCreateOrderOpen(true)}
                  />
                )}

                {!tabLoading && !tabErr && tab === 'movements' && (
                  <MovementsPanel movements={movements} unit={product.unit} />
                )}
                {!tabLoading && !tabErr && tab === 'used-in' && (
                  <UsedInPanel entries={usedIn} onProductClick={onProductClick} />
                )}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Production order detail (sibling of Sheet — avoids nested dialog) */}
      <ProductionOrderDetailDialog
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />

      {/* Create new order for this product */}
      <ProductionOrderFormDialog
        open={createOrderOpen}
        onOpenChange={(o) => { if (!o) setCreateOrderOpen(false); }}
        products={allProducts}
        defaultProductId={product?.id}
        onSaved={() => { setCreateOrderOpen(false); refetchOrders(); }}
      />

      {/* Edit existing order */}
      <ProductionOrderFormDialog
        open={editOrderTarget !== null}
        onOpenChange={(o) => { if (!o) setEditOrderTarget(null); }}
        products={allProducts}
        editOrder={editOrderTarget ?? undefined}
        onSaved={() => { setEditOrderTarget(null); refetchOrders(); }}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteOrderTarget !== null}
        onOpenChange={(o) => { if (!o) setDeleteOrderTarget(null); }}
      >
        <DialogContent className="sm:max-w-sm">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-6 text-destructive" />
          </div>
          <div className="mt-2">
            <DialogTitle className="text-base font-semibold">
              Zayavkani o'chirish
            </DialogTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              #{deleteOrderTarget?.id} — <span className="font-medium text-foreground">{deleteOrderTarget?.product_name}</span> zayavkasini o'chirmoqchimisiz? Bu amalni ortga qaytarib bo'lmaydi.
            </p>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteOrderTarget(null)}
              disabled={isDeletingOrder}
            >
              Bekor qilish
            </Button>
            <Button
              variant="destructive"
              onClick={deleteOrder}
              disabled={isDeletingOrder}
            >
              {isDeletingOrder && <Loader2 className="size-4 animate-spin" />}
              O'chirish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── Qoldiqlar ── */
function StockPanel({
  rows,
  unit,
  canEditMinMax,
  onSaveMinMax,
}: {
  rows: StockRow[] | null;
  unit: string;
  canEditMinMax: boolean;
  onSaveMinMax: (locationId: number, productId: number, minLevel: number, maxLevel: number) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMin, setEditMin] = useState('');
  const [editMax, setEditMax] = useState('');
  const [saving, setSaving] = useState(false);

  if (rows === null) return null;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <BarChart3 className="size-10 opacity-20" />
        <p className="text-sm">Hech qaysi omborxonada qoldiq topilmadi.</p>
      </div>
    );
  }

  const unitLabel = UNIT_LABELS[unit as keyof typeof UNIT_LABELS] ?? unit;
  const totalQty = rows.reduce((s, r) => s + Number(r.qty), 0);

  function startEdit(row: StockRow) {
    setEditingId(row.location_id);
    setEditMin(String(row.min_level));
    setEditMax(String(row.max_level));
  }

  async function submitEdit(row: StockRow) {
    const minVal = parseFloat(editMin);
    const maxVal = parseFloat(editMax);
    if (isNaN(minVal) || minVal < 0 || isNaN(maxVal) || maxVal < minVal) return;
    setSaving(true);
    try {
      await onSaveMinMax(row.location_id, row.product_id, minVal, maxVal);
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-primary/5 px-4 py-3">
        <p className="text-xs text-muted-foreground">Umumiy qoldiq</p>
        <p className="text-2xl font-bold">
          {totalQty.toLocaleString()}{' '}
          <span className="text-sm font-normal text-muted-foreground">{unitLabel}</span>
        </p>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const qty = Number(row.qty);
          const pct = row.max_level > 0 ? Math.min((qty / row.max_level) * 100, 100) : 0;
          const isBelowMin = row.min_level > 0 && qty < row.min_level;
          const rowUnit = UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ?? row.product_unit;
          const isEditing = editingId === row.location_id;

          return (
            <div
              key={row.location_id}
              className={`rounded-xl border bg-card/50 p-4 ${isBelowMin ? 'border-destructive/40' : 'border-border'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {row.location_name ?? `Omborxona #${row.location_id}`}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-base font-bold ${isBelowMin ? 'text-destructive' : 'text-foreground'}`}>
                    {qty.toLocaleString()} {rowUnit}
                  </span>
                  {canEditMinMax && !isEditing && (
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Min/Max tahrirlash"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {isEditing ? (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Min ({rowUnit})</label>
                      <input
                        type="number"
                        min="0"
                        value={editMin}
                        onChange={(e) => setEditMin(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Max ({rowUnit})</label>
                      <input
                        type="number"
                        min="0"
                        value={editMax}
                        onChange={(e) => setEditMax(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)} disabled={saving}>
                      Bekor
                    </Button>
                    <Button size="sm" onClick={() => void submitEdit(row)} disabled={saving}>
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Saqlash
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all ${isBelowMin ? 'bg-destructive' : 'bg-primary'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                    <span>Min: {row.min_level} {rowUnit}</span>
                    <span>{Math.round(pct)}%</span>
                    <span>Max: {row.max_level} {rowUnit}</span>
                  </div>
                  {isBelowMin && (
                    <p className="mt-2 text-xs font-medium text-destructive">
                      ⚠ Minimal darajadan past!
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Zayavkalar ── */
function OrdersPanel({
  orders,
  tabLoading,
  tabErr,
  product,
  busyId,
  isOperator,
  isPm,
  canCreateOrder,
  canActOn,
  onOrderClick,
  onTransition,
  onEdit,
  onDelete,
  onCreate,
}: {
  orders: ProductionOrder[] | null;
  tabLoading: boolean;
  tabErr: string | null;
  product: Product;
  busyId: number | null;
  isOperator: boolean;
  isPm: boolean;
  canCreateOrder: boolean;
  canActOn: (loc: number | null | undefined) => boolean;
  onOrderClick: (order: ProductionOrder) => void;
  onTransition: (id: number, status: 'in_progress' | 'done' | 'cancelled') => void;
  onEdit: (order: ProductionOrder) => void;
  onDelete: (order: ProductionOrder) => void;
  onCreate: () => void;
}) {
  if (tabLoading) return <LoadingState />;
  if (tabErr) return <ErrorState message={tabErr} />;
  if (orders === null) return null;

  const isNonRaw = effectiveType(product) !== 'raw';

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {orders.length > 0
            ? `${orders.length} ta zayavka`
            : 'Zayavkalar topilmadi'}
        </p>
        {canCreateOrder && isNonRaw && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-3.5" />
            Yangi zayavka
          </Button>
        )}
      </div>

      {orders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <ClipboardList className="size-10 opacity-20" />
          <p className="text-sm">Ushbu mahsulot uchun zayavkalar topilmadi.</p>
          {canCreateOrder && isNonRaw && (
            <Button variant="outline" size="sm" onClick={onCreate}>
              <Plus className="size-4" />
              Birinchi zayavkani yarating
            </Button>
          )}
        </div>
      ) : (
        orders.map((o) => {
          const isBusy = busyId === o.id;
          const canAct = isPm || canActOn(o.location_id);
          const canEdit = (isOperator || isPm) && o.status === 'new';
          const canDelete =
            (isOperator || isPm) && (o.status === 'new' || o.status === 'cancelled');
          const showActions = canAct || canEdit || canDelete;

          return (
            <div
              key={o.id}
              className="overflow-hidden rounded-xl border border-border bg-card/50"
            >
              {/* Clickable info row */}
              <button
                type="button"
                onClick={() => onOrderClick(o)}
                className="w-full p-4 text-left transition-colors hover:bg-card"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{o.id}</span>
                      <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[o.status]}>
                        {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm font-semibold">{o.location_name}</p>
                    {o.target_location_name && (
                      <p className="text-xs text-muted-foreground">
                        → {o.target_location_name}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-lg font-bold">{Number(o.qty).toLocaleString()}</p>
                    {o.deadline && (
                      <p className="text-xs text-muted-foreground">
                        Muddat: {o.deadline}
                      </p>
                    )}
                  </div>
                </div>
                {o.note && (
                  <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                    {o.note}
                  </p>
                )}
              </button>

              {/* Action buttons */}
              {showActions && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
                  {canAct && o.status === 'new' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => onTransition(o.id, 'in_progress')}
                    >
                      {isBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      Boshlash
                    </Button>
                  )}
                  {canAct && o.status === 'in_progress' && (
                    <Button
                      size="sm"
                      disabled={isBusy}
                      onClick={() => onTransition(o.id, 'done')}
                    >
                      {isBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Check className="size-3.5" />
                      )}
                      Yakunlash
                    </Button>
                  )}
                  {canAct && (o.status === 'new' || o.status === 'in_progress') && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => onTransition(o.id, 'cancelled')}
                    >
                      <X className="size-3.5" />
                      Bekor
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(o)}
                    >
                      <Pencil className="size-3.5" />
                      Tahrirlash
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => onDelete(o)}
                    >
                      <Trash2 className="size-3.5" />
                      O'chirish
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ── Harakatlar ── */
const REASON_DIRECTION: Record<string, 'in' | 'out' | 'transfer'> = {
  purchase: 'in',
  production_output: 'in',
  production_input: 'out',
  sale: 'out',
  transfer: 'transfer',
  adjust: 'transfer',
};

function MovementsPanel({
  movements,
  unit,
}: {
  movements: StockMovement[] | null;
  unit: string;
}) {
  if (movements === null) return null;

  if (movements.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <Activity className="size-10 opacity-20" />
        <p className="text-sm">Hech qanday harakat topilmadi.</p>
      </div>
    );
  }

  const unitLabel = UNIT_LABELS[unit as keyof typeof UNIT_LABELS] ?? unit;

  return (
    <div className="space-y-2">
      {movements.map((m) => {
        const dir =
          m.from_location_id === null && m.to_location_id !== null
            ? 'in'
            : m.to_location_id === null && m.from_location_id !== null
              ? 'out'
              : (REASON_DIRECTION[m.reason] ?? 'transfer');

        const isIn = dir === 'in';
        const isOut = dir === 'out';

        const rowUnit =
          UNIT_LABELS[m.product_unit as keyof typeof UNIT_LABELS] ?? unitLabel;

        return (
          <div
            key={m.id}
            className={`flex items-start gap-3 rounded-xl border bg-card/50 p-3 ${
              isIn
                ? 'border-l-4 border-green-500/40'
                : isOut
                  ? 'border-l-4 border-destructive/40'
                  : 'border-l-4 border-muted-foreground/30'
            }`}
          >
            <div
              className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
                isIn
                  ? 'bg-green-500/10 text-green-600'
                  : isOut
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {isIn ? (
                <ArrowDownLeft className="size-4" />
              ) : isOut ? (
                <ArrowUpRight className="size-4" />
              ) : (
                <ArrowLeftRight className="size-4" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {MOVEMENT_REASON_LABELS[m.reason] ?? m.reason}
                </span>
                <span
                  className={`shrink-0 text-base font-bold tabular-nums ${
                    isIn
                      ? 'text-green-600'
                      : isOut
                        ? 'text-destructive'
                        : 'text-foreground'
                  }`}
                >
                  {isIn ? '+' : isOut ? '−' : ''}
                  {Number(m.qty).toLocaleString()} {rowUnit}
                </span>
              </div>

              <p className="mt-0.5 text-xs text-muted-foreground">
                {m.from_location_name && m.to_location_name ? (
                  <>
                    {m.from_location_name}
                    <span className="mx-1">→</span>
                    {m.to_location_name}
                  </>
                ) : m.from_location_name ? (
                  <>{m.from_location_name} dan</>
                ) : m.to_location_name ? (
                  <>{m.to_location_name} ga</>
                ) : null}
              </p>

              <div className="mt-1 flex items-center justify-between gap-2">
                {m.note && (
                  <p className="truncate text-xs italic text-muted-foreground">
                    {m.note}
                  </p>
                )}
                <p className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {new Date(m.created_at).toLocaleDateString('uz-UZ', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                  })}
                  {' '}
                  {new Date(m.created_at).toLocaleTimeString('uz-UZ', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Ishlatilgan ── */
function UsedInPanel({
  entries,
  onProductClick,
}: {
  entries: UsedInEntry[] | null;
  onProductClick?: (product: Product, openTab?: Tab) => void;
}) {
  if (entries === null) return null;

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <Package className="size-10 opacity-20" />
        <p className="text-sm">Bu mahsulot hech qaysi retseptda komponent sifatida ishlatilmagan.</p>
      </div>
    );
  }

  // Group recipe lines by parent product id
  const grouped = new Map<number, { product: UsedInEntry; lines: UsedInEntry[] }>();
  for (const entry of entries) {
    if (!grouped.has(entry.id)) {
      grouped.set(entry.id, { product: entry, lines: [] });
    }
    grouped.get(entry.id)!.lines.push(entry);
  }
  const groups = Array.from(grouped.values());

  return (
    <div className="space-y-2">
      <p className="mb-3 text-xs text-muted-foreground">
        Ushbu mahsulot{' '}
        <span className="font-semibold text-foreground">{groups.length}</span>
        {' '}ta mahsulotning retseptida ishlatiladi:
      </p>

      {groups.map(({ product: p, lines }) => {
        const cat = deriveCategory(p);
        const style = PRODUCT_CATEGORY_STYLE[cat];
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onProductClick?.(p, 'orders')}
            className={[
              'group w-full rounded-xl border border-l-4 border-border/60 bg-card/50 p-0 text-left transition-all hover:bg-card hover:shadow-md',
              style.accent,
              onProductClick ? 'cursor-pointer' : 'cursor-default',
            ].join(' ')}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={style.badge} className="shrink-0 text-[10px] px-1.5 py-0">
                    {PRODUCT_CATEGORY_LABELS[cat]}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {PRODUCT_TYPE_LABELS[effectiveType(p)]}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-sm font-semibold">{p.name}</p>
              </div>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" aria-hidden="true" />
            </div>

            {/* Recipe lines */}
            <div className="divide-y divide-border/40 border-t border-border/40">
              {lines.map((line, i) => {
                const stageName = line.stage
                  ? (RECIPE_STAGE_LABELS[line.stage as RecipeStage] ?? line.stage)
                  : null;
                return (
                  <div key={i} className="flex items-center gap-3 px-4 py-2">
                    {stageName ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {stageName}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] text-muted-foreground">Bosqich —</span>
                    )}
                    <span className="ml-auto text-sm font-bold tabular-nums">
                      {Number(line.qty_per_unit).toLocaleString('uz-UZ', { maximumFractionDigits: 3 })}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {UNIT_LABELS[p.unit]}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">ishlatiladi</span>
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── Zayavka detail dialog ── */
function ProductionOrderDetailDialog({
  order,
  onClose,
}: {
  order: ProductionOrder | null;
  onClose: () => void;
}) {
  if (!order) return null;

  const statusStyle: Record<string, string> = {
    new: 'bg-muted/60',
    in_progress: 'bg-blue-500/10',
    done: 'bg-green-500/10',
    cancelled: 'bg-destructive/10',
  };

  return (
    <Dialog open={order !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <div className={`-mx-6 -mt-6 mb-4 rounded-t-lg px-6 py-5 ${statusStyle[order.status] ?? 'bg-muted/40'}`}>
          <div className="flex items-center gap-2">
            <ClipboardList className="size-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Zayavka</span>
            <span className="text-xs font-semibold">#{order.id}</span>
            <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[order.status]} className="ml-auto">
              {PRODUCTION_ORDER_STATUS_LABELS[order.status]}
            </Badge>
          </div>
          <DialogTitle className="mt-2 text-lg font-bold">{order.product_name}</DialogTitle>
          <p className="mt-1 text-2xl font-bold">
            {Number(order.qty).toLocaleString()}{' '}
            <span className="text-sm font-normal text-muted-foreground">dona</span>
          </p>
        </div>

        <div className="space-y-3">
          <DetailRow
            icon={<MapPin className="size-4 text-muted-foreground" />}
            label="Ishlab chiqarish joyi"
            value={order.location_name ?? '—'}
          />
          {order.target_location_name && (
            <DetailRow
              icon={<MapPin className="size-4 text-muted-foreground" />}
              label="Yuboriladi"
              value={order.target_location_name}
            />
          )}
          {order.deadline && (
            <DetailRow
              icon={<CalendarDays className="size-4 text-muted-foreground" />}
              label="Muddat"
              value={order.deadline}
            />
          )}
          <DetailRow
            icon={<CalendarDays className="size-4 text-muted-foreground" />}
            label="Yaratilgan"
            value={new Date(order.created_at).toLocaleString('uz-UZ', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          />
          {order.note && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <p className="mb-1 text-xs text-muted-foreground">Izoh</p>
              <p className="text-sm">{order.note}</p>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Yopish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}
