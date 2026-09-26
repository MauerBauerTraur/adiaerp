import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
  CloudDownload,
  ScrollText,
  Info,
  Calculator,
  Lock,
  LockOpen,
  RefreshCw,
} from 'lucide-react';
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
import { useToast, type ToastVariant } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import {
  RECIPE_STAGE_LABELS,
  RECIPE_STAGE_ORDER,
  RECIPE_STAGE_PICKABLE,
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
  /**
   * Called after the recipe changed on the server (save, or a Poster apply)
   * so the parent can refetch its product list — `recipe_locked` there is
   * otherwise stale until the next page load.
   */
  onSaved?: () => void;
}

interface EditableLine {
  stage: RecipeStage;
  component_product_id: string;
  brutto: string;
  qty_per_unit: string;
}

// The response types below list only the fields this dialog reads.

/** GET /api/products/:id/recipe */
interface RecipeResponse {
  recipe: RecipeLine[];
  /** The authoritative lock flag; the `product` prop may be a stale list row. */
  recipe_locked?: boolean;
}

/**
 * GET /api/integrations/poster/product-recipe/:id — a preview only: it fills
 * the form, and nothing is persisted until "Saqlash".
 */
interface PosterRecipePreview {
  lines: Array<{ component_product_id: number; qty_per_unit: number; brutto: number }>;
  /** Poster ingredient names with no matching ERP product. */
  not_found: string[];
  message?: string;
  poster_name?: string;
  warnings?: string[];
  /** Replacing the recipe from Poster would drop its Hamir/Krem/Bezak split. */
  stages_will_reset?: boolean;
}

/**
 * POST /api/integrations/poster/product-recipe/:id/apply — atomically replaces
 * the recipe with Poster's and unlocks it. `recipe` rows have the same shape
 * as GET /api/products/:id/recipe.
 */
interface PosterRecipeApplyResult {
  recipe_locked: boolean;
  recipe: RecipeLine[];
  warnings?: string[];
}

const APPLY_LABEL_LOCKED = "Qulfni ochish va Poster'dan yangilash";
const APPLY_LABEL_UNLOCKED = "Poster'dan hozir yangilash";

function normalizeStage(s: RecipeLine['stage']): RecipeStage {
  return s != null && (RECIPE_STAGE_ORDER as string[]).includes(s as string)
    ? (s as RecipeStage)
    : 'base';
}

/** Maps a stored recipe row (GET recipe / Poster apply) onto an editable form line. */
function toEditableLine(l: RecipeLine): EditableLine {
  return {
    stage: normalizeStage(l.stage),
    component_product_id: String(l.component_product_id),
    brutto: l.brutto && l.brutto > 0 ? String(l.brutto) : '',
    qty_per_unit: String(l.qty_per_unit),
  };
}

/**
 * Formats a Poster quantity for an input: 6 significant digits (at least 4
 * decimals), plain notation. Rounding to a fixed 4 decimals turned per-unit
 * amounts below 0.0001 into "0", which then failed validation on save.
 */
function formatPosterQty(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const decimals = Math.min(20, Math.max(4, 5 - Math.floor(Math.log10(n))));
  return n.toFixed(decimals).replace(/\.?0+$/, '');
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
  onSaved,
}: RecipeDialogProps) {
  const { notify } = useToast();
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isConfirmingApply, setIsConfirmingApply] = useState(false);
  const [isLocked, setIsLocked] = useState(product?.recipe_locked ?? false);
  const [isPosterLoading, setIsPosterLoading] = useState(false);
  /** Poster-side notes (unmatched components, name mismatches, stage resets)
   *  kept visible in the dialog — a toast disappears after 5 s. */
  const [posterNotes, setPosterNotes] = useState<string[]>([]);
  /** Text for the dialog's own live region. Toasts sit outside the modal,
   *  which Radix hides from assistive tech while it is open. */
  const [announcement, setAnnouncement] = useState('');

  /**
   * Bumped whenever the dialog closes or switches product. A request keeps the
   * session it started in, and a response from an older session is dropped
   * silently — even after a close and reopen of the SAME product, where a
   * product-id check would let it overwrite the freshly loaded lines.
   */
  const sessionRef = useRef(0);
  const applyTriggerRef = useRef<HTMLButtonElement>(null);
  const applyConfirmRef = useRef<HTMLButtonElement>(null);
  const applyCancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusToTriggerRef = useRef(false);
  /**
   * Pre-check for the apply confirm: would replacing the recipe from Poster
   * drop its Hamir/Krem/Bezak split? Read from the preview endpoint.
   */
  const [stageCheck, setStageCheck] = useState<'idle' | 'checking' | 'resets' | 'keeps' | 'unknown'>('idle');
  const stageCheckSeqRef = useRef(0);
  const applyConfirmTextId = useId();

  // The inline confirm step replaces the trigger button, so move focus with
  // it: onto "Ha" when it opens, back to the trigger once it is dismissed or
  // the apply has finished (the trigger is disabled while it runs).
  useEffect(() => {
    if (isConfirmingApply) {
      // "Ha" stays disabled while the stage check runs; hold focus on the
      // safe choice until then, and move it to "Ha" once it is ready.
      (stageCheck === 'checking' ? applyCancelRef : applyConfirmRef).current?.focus();
    } else if (!isApplying && returnFocusToTriggerRef.current) {
      returnFocusToTriggerRef.current = false;
      applyTriggerRef.current?.focus();
    }
  }, [isConfirmingApply, isApplying, stageCheck]);

  useEffect(() => {
    if (!open || product === null) return;
    const session = sessionRef.current;
    // A session starts idle: whatever the previous one had in flight is dropped.
    setIsApplying(false);
    setIsPosterLoading(false);
    setIsSaving(false);
    setIsConfirmingApply(false);
    setStageCheck('idle');
    returnFocusToTriggerRef.current = false;
    setPosterNotes([]);
    setAnnouncement('');
    setSaveError(null);
    setLoadError(null);
    setIsLocked(product.recipe_locked ?? false);
    setIsLoading(true);

    apiRequest<RecipeResponse>(`/api/products/${product.id}/recipe`)
      .then((data) => {
        if (sessionRef.current !== session) return;
        setLines(data.recipe.map(toEditableLine));
        if (typeof data.recipe_locked === 'boolean') setIsLocked(data.recipe_locked);
      })
      .catch((err: unknown) => {
        if (sessionRef.current !== session) return;
        setLoadError(
          err instanceof ApiError ? err.message : "Retseptni yuklab bo'lmadi.",
        );
      })
      .finally(() => {
        if (sessionRef.current === session) setIsLoading(false);
      });

    return () => {
      sessionRef.current += 1;
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

    const session = sessionRef.current;
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
      // Saving locks the recipe server-side; let the list pick that up.
      onSaved?.();
      if (sessionRef.current !== session) return;
      notify('success', 'Retsept saqlandi.');
      onOpenChange(false);
    } catch (err: unknown) {
      if (sessionRef.current !== session) return;
      setSaveError(
        err instanceof ApiError ? err.message : "Retseptni saqlab bo'lmadi.",
      );
    } finally {
      if (sessionRef.current === session) setIsSaving(false);
    }
  }

  /** A toast, repeated in the dialog's live region so screen readers hear it. */
  function report(variant: ToastVariant, message: string) {
    notify(variant, message);
    setAnnouncement(message);
  }

  async function handlePosterLoad() {
    if (product === null) return;
    const session = sessionRef.current;
    const applyLabel = isLocked ? APPLY_LABEL_LOCKED : APPLY_LABEL_UNLOCKED;
    setIsPosterLoading(true);
    setSaveError(null);
    setPosterNotes([]);
    setAnnouncement('Posterdan yuklanmoqda…');
    try {
      const data = await apiRequest<PosterRecipePreview>(
        `/api/integrations/poster/product-recipe/${product.id}`,
      );
      if (sessionRef.current !== session) return;

      // An empty result is a failure, not a success: the form is left as it was.
      if (data.lines.length === 0) {
        report('error', data.message ?? 'Posterda bu mahsulot uchun retsept topilmadi.');
        return;
      }
      // 'base' is what the hourly Poster sync writes (recipes.stage default), so a
      // manual load lands on the same rows and the next bulk sync updates them in
      // place instead of adding a second, differently-staged copy.
      setLines(data.lines.map((l) => ({
        stage: 'base' as const,
        component_product_id: String(l.component_product_id),
        brutto: l.brutto > 0 ? formatPosterQty(l.brutto) : '',
        qty_per_unit: formatPosterQty(l.qty_per_unit),
      })));

      // "Saqlash" locks the recipe, so a saved preview is exactly the state that
      // made Poster and ERP drift apart. Say so, and point to the apply button.
      const missing =
        data.not_found.length > 0
          ? [`Topilmagan komponentlar: ${data.not_found.join(', ')}`]
          : [];
      setPosterNotes([
        ...missing,
        ...(data.stages_will_reset === true
          ? [
              "Diqqat: Poster'da bosqichlar yo'q — saqlansa Hamir/Krem/Bezak bo'linishi " +
                "yo'qoladi va zagatovka jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi.",
            ]
          : []),
        ...(data.warnings ?? []),
        `Bu faqat oldindan ko'rish — hali saqlanmagan. "Saqlash" retseptni qulflaydi va ` +
          `soatlik Poster sinxronlash uni boshqa yangilamaydi. Poster bilan bir xil qoldirish ` +
          `uchun "${applyLabel}" tugmasidan foydalaning.`,
      ]);

      if (data.not_found.length > 0) {
        // Partial: the recipe on screen is incomplete, so this is not a success.
        report(
          'warning',
          `Topilmagan komponentlar: ${data.not_found.join(', ')}. Formaga faqat ` +
            `${data.lines.length} ta komponent yuklandi — "Saqlash" to'liq bo'lmagan ` +
            `retseptni qulflab qo'yadi.`,
        );
      } else {
        const source = data.poster_name ? ` ("${data.poster_name}")` : '';
        report(
          'success',
          `Posterdan${source} ${data.lines.length} ta komponent formaga yuklandi. ` +
            `"Saqlash" retseptni qulflaydi — Poster bilan sinxron qolishi uchun ` +
            `"${applyLabel}" tugmasidan foydalaning.`,
        );
      }
    } catch (err: unknown) {
      if (sessionRef.current !== session) return;
      report('error', err instanceof ApiError ? err.message : "Posterdan yuklab bo'lmadi.");
    } finally {
      if (sessionRef.current === session) setIsPosterLoading(false);
    }
  }

  /**
   * Replaces the recipe with Poster's on the server and unlocks it — used both
   * to unlock a hand-saved recipe and to refresh an unlocked one without
   * waiting for the hourly sync. On failure the server changes nothing, so the
   * lock and the lines on screen stay as they are.
   */
  async function handleApplyFromPoster() {
    if (product === null) return;
    const session = sessionRef.current;
    const productName = product.name;
    const wasLocked = isLocked;
    returnFocusToTriggerRef.current = true;
    setIsConfirmingApply(false);
    setIsApplying(true);
    setSaveError(null);
    setPosterNotes([]);
    setAnnouncement("Poster'dan yangilanmoqda…");
    try {
      const data = await apiRequest<PosterRecipeApplyResult>(
        `/api/integrations/poster/product-recipe/${product.id}/apply`,
        { method: 'POST' },
      );
      // The server changed either way, so the parent's list must refetch. The
      // dialog itself shows nothing if it has moved on since.
      onSaved?.();
      if (sessionRef.current !== session) return;

      const warnings = data.warnings ?? [];
      setIsLocked(data.recipe_locked);
      setLines(data.recipe.map(toEditableLine));
      setLoadError(null);
      setPosterNotes(warnings);
      const summary =
        `"${productName}" retsepti Poster'dan yangilandi: ${data.recipe.length} ta komponent.` +
        (wasLocked && !data.recipe_locked ? ' Qulf ochildi.' : '');
      // Warnings (reset stages, merged duplicates) need action from the user,
      // so they are never reported as a plain success.
      if (warnings.length > 0) {
        report(
          'warning',
          `${summary} ${warnings.length} ta ogohlantirish bor — retsept ustidagi blokni ko'ring.`,
        );
      } else {
        report('success', summary);
      }
    } catch (err: unknown) {
      if (sessionRef.current !== session) return;
      const message =
        err instanceof ApiError ? err.message : "Retseptni Poster'dan yangilab bo'lmadi.";
      report('error', message);
      // A 422 can list several missing components — too long for a 5 s toast,
      // so keep it in the dialog as well.
      setSaveError(message);
    } finally {
      if (sessionRef.current === session) setIsApplying(false);
    }
  }

  /**
   * Opens the inline confirm and asks the preview endpoint whether the apply
   * would drop the Hamir/Krem/Bezak split, so the warning is shown before
   * "Ha" — not only in the result. If the check fails the user may still go
   * ahead; the apply result reports stage resets in its warnings anyway.
   */
  function openApplyConfirm() {
    if (product === null) return;
    const session = sessionRef.current;
    const seq = ++stageCheckSeqRef.current;
    setIsConfirmingApply(true);
    setStageCheck('checking');
    apiRequest<PosterRecipePreview>(`/api/integrations/poster/product-recipe/${product.id}`)
      .then((data) => {
        if (sessionRef.current !== session || stageCheckSeqRef.current !== seq) return;
        setStageCheck(data.stages_will_reset === true ? 'resets' : 'keeps');
      })
      .catch(() => {
        if (sessionRef.current !== session || stageCheckSeqRef.current !== seq) return;
        setStageCheck('unknown');
      });
  }

  function cancelApplyConfirm() {
    stageCheckSeqRef.current += 1;
    setStageCheck('idle');
    returnFocusToTriggerRef.current = true;
    setIsConfirmingApply(false);
  }

  if (!product) return null;

  const category = deriveCategory(product);
  const style = PRODUCT_CATEGORY_STYLE[category];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl sm:h-[90vh] flex flex-col gap-0 p-0 overflow-hidden"
        onEscapeKeyDown={(e) => {
          // Radix listens for Escape on the document in the capture phase, so
          // an onKeyDown further down cannot stop it: an open confirm step is
          // dismissed first, and only the next Escape closes the dialog.
          if (isConfirmingApply) {
            e.preventDefault();
            cancelApplyConfirm();
          }
        }}
      >
        {/* Mounted with the dialog, before any text lands in it, so screen
            readers announce every change. */}
        <p role="status" className="sr-only">
          {announcement}
        </p>

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
              {canEdit && (isConfirmingApply ? (
                <div
                  role="group"
                  aria-labelledby={applyConfirmTextId}
                  className="mt-2 space-y-2 border-t border-border/60 pt-2"
                >
                  <p id={applyConfirmTextId} className="text-[11px] font-medium text-foreground">
                    {isLocked
                      ? "Joriy retsept Poster'dagi retsept bilan almashtiriladi va qulf ochiladi. Davom etasizmi?"
                      : "Joriy retsept Poster'dagi retsept bilan almashtiriladi. Davom etasizmi?"}
                  </p>
                  {stageCheck === 'checking' && (
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      Bosqichlar tekshirilmoqda…
                    </p>
                  )}
                  {stageCheck === 'resets' && (
                    <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] font-medium">
                      Diqqat: Hamir/Krem/Bezak bo'linishi yo'qoladi — bu tort uchun zagatovka
                      jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi.
                    </p>
                  )}
                  {stageCheck === 'unknown' && (
                    <p className="text-[11px] text-muted-foreground">
                      Bosqichlarni oldindan tekshirib bo'lmadi.
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <Button
                      ref={applyConfirmRef}
                      type="button"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleApplyFromPoster}
                      disabled={
                        isApplying ||
                        isPosterLoading ||
                        isLoading ||
                        isSaving ||
                        stageCheck === 'checking'
                      }
                    >
                      Ha, yangilash
                    </Button>
                    <Button
                      ref={applyCancelRef}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={cancelApplyConfirm}
                    >
                      Yo'q
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  ref={applyTriggerRef}
                  type="button"
                  onClick={openApplyConfirm}
                  disabled={isApplying || isPosterLoading || isLoading || isSaving}
                  className={`mt-2 flex items-start gap-1 text-left text-[10px] font-medium hover:underline disabled:opacity-50 ${isLocked ? 'text-violet-600 dark:text-violet-400' : 'text-primary'}`}
                >
                  {isApplying ? (
                    <Loader2 className="mt-px size-3 shrink-0 animate-spin" aria-hidden="true" />
                  ) : isLocked ? (
                    <LockOpen className="mt-px size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="mt-px size-3 shrink-0" aria-hidden="true" />
                  )}
                  {isLocked ? APPLY_LABEL_LOCKED : APPLY_LABEL_UNLOCKED}
                </button>
              ))}
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
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {saveError}
              </div>
            )}
          </div>

          {/* RIGHT — recipe table */}
          <div
            className="flex flex-1 flex-col min-w-0 overflow-hidden"
            aria-busy={isApplying || isPosterLoading}
          >

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
                    disabled={isPosterLoading || isApplying || isLoading || isSaving}
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

            {/* Poster notes sit right above the lines they are about, full
                width. The live region stays mounted so its content is read out. */}
            <div role="status" className="shrink-0">
              {posterNotes.length > 0 && (
                <div className="border-b border-amber-300 bg-amber-50 px-5 py-3 dark:border-amber-700/50 dark:bg-amber-900/20">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                    Ogohlantirishlar
                  </div>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-amber-900 dark:text-amber-200">
                    {posterNotes.map((note, i) => (
                      <li key={i} className="break-words">{note}</li>
                    ))}
                  </ul>
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
                            {/* The three nakladnoy sections, plus this line's own
                                legacy value so selecting nothing cannot change it. */}
                            {(RECIPE_STAGE_PICKABLE.includes(line.stage)
                              ? RECIPE_STAGE_PICKABLE
                              : [...RECIPE_STAGE_PICKABLE, line.stage]
                            ).map((s) => (
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
              disabled={isSaving || isApplying || isLoading || loadError !== null}
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
