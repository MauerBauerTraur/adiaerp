import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Plus, Trash2, CloudDownload, ScrollText, Info, Calculator, Lock, LockOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import {
  RECIPE_STAGE_LABELS,
  RECIPE_STAGE_ORDER,
  UNIT_LABELS,
  PRODUCT_TYPE_LABELS,
} from '@/lib/labels';
import {
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_CATEGORY_STYLE,
  deriveCategory,
  effectiveType,
} from '@/lib/productCategory';
import type { Product, RecipeLine, RecipeStage } from '@/lib/types';

interface RecipeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
  allProducts: Product[];
  canEdit: boolean;
  onProductClick?: (product: Product) => void;
}

interface EditableLine {
  stage: RecipeStage;
  component_product_id: string;
  brutto: string;
  qty_per_unit: string;
}

function normalizeStage(s: RecipeLine['stage']): RecipeStage {
  return s != null && (RECIPE_STAGE_ORDER as string[]).includes(s as string)
    ? (s as RecipeStage)
    : 'other';
}

function emptyLine(): EditableLine {
  return { stage: 'dough', component_product_id: '', brutto: '', qty_per_unit: '' };
}

export function RecipeDialog({
  open,
  onOpenChange,
  product,
  allProducts,
  canEdit,
  onProductClick,
}: RecipeDialogProps) {
  const { notify } = useToast();
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isLocked, setIsLocked] = useState(product?.recipe_locked ?? false);
  const [isPosterLoading, setIsPosterLoading] = useState(false);

  useEffect(() => {
    setIsLocked(product?.recipe_locked ?? false);
  }, [product?.id, product?.recipe_locked]);

  useEffect(() => {
    if (!open || product === null) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);

    apiRequest<{ product_id: number; recipe: RecipeLine[] }>(
      `/api/products/${product.id}/recipe`,
    )
      .then((data) => {
        if (cancelled) return;
        setLines(
          data.recipe.map((l) => ({
            stage: normalizeStage(l.stage),
            component_product_id: String(l.component_product_id),
            brutto: l.brutto && l.brutto > 0 ? String(l.brutto) : '',
            qty_per_unit: String(l.qty_per_unit),
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError ? err.message : "Retseptni yuklab bo'lmadi.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, product?.id]);

  const componentOptions = useMemo(
    () => allProducts.filter((p) => p.id !== product?.id),
    [allProducts, product?.id],
  );

  const filledCount = lines.filter(
    (l) => l.component_product_id !== '' && Number(l.qty_per_unit) > 0,
  ).length;

  // BOM jami tan narxi: har komponent narxi × miqdori yig'indisi
  const totalCost = useMemo(() => {
    let sum = 0;
    let hasAny = false;
    for (const l of lines) {
      if (l.component_product_id === '') continue;
      const qty = Number(l.qty_per_unit);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const comp = allProducts.find((p) => String(p.id) === l.component_product_id);
      if (comp?.cost_price != null) {
        sum += comp.cost_price * qty;
        hasAny = true;
      }
    }
    return hasAny ? sum : null;
  }, [lines, allProducts]);

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function updateLine(i: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    if (product === null) return;
    setSaveError(null);

    const filled = lines.filter(
      (l) => l.component_product_id !== '' || l.qty_per_unit !== '',
    );
    for (const line of filled) {
      if (line.component_product_id === '') {
        setSaveError('Har bir qatorda komponent tanlanishi kerak.');
        return;
      }
      const qty = Number(line.qty_per_unit.replace(',', '.'));
      if (!Number.isFinite(qty) || qty <= 0) {
        setSaveError("Har bir komponent miqdori 0 dan katta bo'lishi kerak.");
        return;
      }
    }
    const ids = filled.map((l) => l.component_product_id);
    if (new Set(ids).size !== ids.length) {
      setSaveError('Bitta komponent ikki marta kiritilgan.');
      return;
    }

    setIsSaving(true);
    try {
      await apiRequest(`/api/products/${product.id}/recipe`, {
        method: 'PUT',
        body: {
          recipe: filled.map((l) => ({
            component_product_id: Number(l.component_product_id),
            qty_per_unit: Number(l.qty_per_unit.replace(',', '.')),
            brutto: l.brutto !== '' ? Number(l.brutto.replace(',', '.')) : 0,
            stage: l.stage,
          })),
        },
      });
      notify('success', 'Retsept saqlandi.');
      onOpenChange(false);
    } catch (err: unknown) {
      setSaveError(
        err instanceof ApiError ? err.message : "Retseptni saqlab bo'lmadi.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handlePosterLoad() {
    if (product === null) return;
    setIsPosterLoading(true);
    setSaveError(null);
    try {
      const data = await apiRequest<{
        lines: Array<{
          component_product_id: number;
          component_name: string;
          component_unit: string;
          qty_per_unit: number;
          brutto: number;
          found: boolean;
        }>;
        not_found: string[];
        message?: string;
      }>(`/api/integrations/poster/product-recipe/${product.id}`);

      if (data.lines.length === 0) {
        notify('success', data.message ?? "Posterda bu mahsulot uchun retsept topilmadi.");
        return;
      }
      setLines(data.lines.map((l) => ({
        stage: 'other' as const,
        component_product_id: String(l.component_product_id),
        brutto: l.brutto > 0 ? String(Math.round(l.brutto * 1e4) / 1e4) : '',
        qty_per_unit: String(Math.round(l.qty_per_unit * 1e4) / 1e4),
      })));
      if (data.not_found.length > 0) {
        notify('success', `Posterdan yuklandi. Topilmagan: ${data.not_found.join(', ')}`);
      } else {
        notify('success', `Posterdan ${data.lines.length} ta komponent yuklandi. Saqlash uchun "Saqlash" ni bosing.`);
      }
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Posterdan yuklab bo'lmadi.");
    } finally {
      setIsPosterLoading(false);
    }
  }

  async function handleUnlock() {
    if (product === null) return;
    setIsUnlocking(true);
    try {
      await apiRequest(`/api/products/${product.id}`, {
        method: 'PATCH',
        body: { recipe_locked: false },
      });
      setIsLocked(false);
      notify('success', 'Retsept qulfi ochildi. Poster sinxronlash retseptni yangilashi mumkin.');
    } catch (err: unknown) {
      notify('error', err instanceof ApiError ? err.message : "Qulfni ochib bo'lmadi.");
    } finally {
      setIsUnlocking(false);
    }
  }

  if (!product) return null;

  const category = deriveCategory(product);
  const style = PRODUCT_CATEGORY_STYLE[category];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl sm:h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <ScrollText className="size-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">
              Retsept — {product.name}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              1 birlik mahsulot uchun zarur komponentlar (BOM)
            </p>
          </div>
          <Badge variant={style.badge}>{PRODUCT_CATEGORY_LABELS[category]}</Badge>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* LEFT — product info */}
          <div className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border p-6">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nomi
              </p>
              <p className="text-sm font-medium">{product.name}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Turi
              </p>
              <p className="text-sm">{PRODUCT_TYPE_LABELS[effectiveType(product)]}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Birlik
              </p>
              <p className="text-sm">{UNIT_LABELS[product.unit]}</p>
            </div>
            {product.sku && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  SKU
                </p>
                <p className="text-sm font-mono text-muted-foreground">{product.sku}</p>
              </div>
            )}

            {/* Lock status */}
            <div className={`rounded-lg border px-3 py-2.5 ${isLocked ? 'border-violet-300 bg-violet-50 dark:border-violet-700/50 dark:bg-violet-900/20' : 'border-border bg-muted/30'}`}>
              <div className={`flex items-center gap-1.5 text-xs font-semibold ${isLocked ? 'text-violet-700 dark:text-violet-400' : 'text-muted-foreground'}`}>
                {isLocked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {isLocked ? 'Qulflangan' : 'Qulfsiz'}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {isLocked
                  ? 'Poster sinxronlash bu retseptni o\'zgartira olmaydi.'
                  : 'Poster sinxronlash retseptni yangilashi mumkin.'}
              </p>
              {isLocked && canEdit && (
                <button
                  type="button"
                  onClick={handleUnlock}
                  disabled={isUnlocking}
                  className="mt-2 flex items-center gap-1 text-[10px] font-medium text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-400"
                >
                  {isUnlocking ? <Loader2 className="size-3 animate-spin" /> : <LockOpen className="size-3" />}
                  Qulfni ochish
                </button>
              )}
            </div>

            {totalCost !== null && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  <Calculator className="size-3.5" />
                  Jami tan narxi
                </div>
                <p className="mt-1 text-base font-bold text-amber-700 dark:text-amber-300">
                  {totalCost.toLocaleString('uz-UZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} so'm
                </p>
                <p className="text-[10px] text-amber-600/70 dark:text-amber-500/70">
                  Poster narxlariga asosan
                </p>
              </div>
            )}

            {saveError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {saveError}
              </div>
            )}
          </div>

          {/* RIGHT — recipe table */}
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden">

            {/* Recipe toolbar */}
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div>
                <span className="text-sm font-semibold">RETSEPT</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {filledCount} ta to'ldirilgan / {lines.length} ta qator
                </span>
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePosterLoad}
                    disabled={isPosterLoading || isLoading}
                    className="text-xs"
                  >
                    {isPosterLoading
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      : <CloudDownload className="size-3.5" aria-hidden="true" />}
                    Posterdan yuklash
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={addLine}
                    className="text-xs"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    Qator
                  </Button>
                </div>
              )}
            </div>

            {/* Loading / error states */}
            {isLoading && <LoadingState />}
            {!isLoading && loadError && <ErrorState message={loadError} />}

            {!isLoading && !loadError && (
              <>
                {/* Table header */}
                {lines.length > 0 && (
                  <div className="grid grid-cols-[28px_120px_1fr_80px_80px_56px_80px_32px_32px] items-center gap-2 border-b border-border/50 bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span className="text-center">#</span>
                    <span>BOSQICH</span>
                    <span>KOMPONENT</span>
                    <span className="text-center">BRUTTO</span>
                    <span className="text-center">NETTO</span>
                    <span className="text-center">BIRLIK</span>
                    <span className="text-right">NARXI</span>
                    <span />
                    <span />
                  </div>
                )}

                {/* Rows */}
                <div className="flex-1 overflow-y-auto">
                  {lines.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                      <ScrollText className="size-10 opacity-20" />
                      <p className="text-sm">Retsept qatorlari yo'q</p>
                      {canEdit && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={addLine}
                        >
                          <Plus className="size-4" />
                          Birinchi qatorni qo'shing
                        </Button>
                      )}
                    </div>
                  ) : (
                    lines.map((line, i) => {
                      const comp = componentOptions.find(
                        (p) => String(p.id) === line.component_product_id,
                      );
                      const qty = Number(line.qty_per_unit);
                      const lineCost =
                        comp?.cost_price != null && Number.isFinite(qty) && qty > 0
                          ? comp.cost_price * qty
                          : null;
                      return (
                        <div
                          key={i}
                          className="grid grid-cols-[28px_120px_1fr_80px_80px_56px_80px_32px_32px] items-center gap-2 border-b border-border/30 px-4 py-2.5 last:border-0 hover:bg-muted/20"
                        >
                          <span className="text-center text-xs font-medium text-muted-foreground">
                            {i + 1}
                          </span>
                          <Select
                            value={line.stage}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateLine(i, { stage: e.target.value as RecipeStage })
                            }
                            className="h-8 text-xs"
                          >
                            {RECIPE_STAGE_ORDER.map((s) => (
                              <option key={s} value={s}>
                                {RECIPE_STAGE_LABELS[s]}
                              </option>
                            ))}
                          </Select>
                          <Select
                            value={line.component_product_id}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateLine(i, { component_product_id: e.target.value })
                            }
                            className="h-8 text-xs"
                          >
                            <option value="">— Tanlang —</option>
                            {componentOptions.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </Select>
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={line.brutto}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateLine(i, { brutto: e.target.value })
                            }
                            className="h-8 text-center text-xs"
                            placeholder="0"
                          />
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={line.qty_per_unit}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateLine(i, { qty_per_unit: e.target.value })
                            }
                            className="h-8 text-center text-xs"
                            placeholder="0"
                          />
                          <span className="text-center text-xs text-muted-foreground">
                            {comp ? UNIT_LABELS[comp.unit] : '—'}
                          </span>
                          <span className="text-right text-xs font-medium text-amber-600 dark:text-amber-400">
                            {lineCost !== null
                              ? lineCost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })
                              : '—'}
                          </span>
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => removeLine(i)}
                              className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          ) : (
                            <span />
                          )}
                          {comp && onProductClick && (effectiveType(comp) === 'semi' || effectiveType(comp) === 'finished') ? (
                            <button
                              type="button"
                              title={`${comp.name} ni ochish`}
                              onClick={() => { onProductClick(comp); onOpenChange(false); }}
                              className="flex items-center justify-center rounded-md p-1 text-violet-500 hover:bg-violet-500/10"
                            >
                              <ExternalLink className="size-3.5" />
                            </button>
                          ) : (
                            <span />
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer note */}
                <div className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  {canEdit
                    ? "Bo'sh qatorlar o'tkazib yuboriladi. Faqat nomi va miqdori bor qatorlar saqlanadi."
                    : "Faqat o'qish rejimi — retseptni tahrirlash huquqi yo'q."}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {canEdit ? 'Bekor qilish' : 'Yopish'}
          </Button>
          {canEdit && (
            <Button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isLoading || loadError !== null}
            >
              {isSaving && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Saqlash
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
