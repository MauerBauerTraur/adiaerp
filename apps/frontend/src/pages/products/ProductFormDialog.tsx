import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2, CloudDownload, ChefHat, Pencil, Info, X } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { useApiQuery } from '@/hooks/useApiQuery';
import {
  PRODUCT_TYPE_OPTIONS,
  UNIT_OPTIONS,
  RECIPE_STAGE_LABELS,
  RECIPE_STAGE_ORDER,
  UNIT_LABELS,
} from '@/lib/labels';
import type { Location, Product, ProductType, RecipeStage, Unit } from '@/lib/types';

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  allProducts: Product[];
  /** When provided the dialog is in edit mode — no recipe section shown. */
  editProduct?: Product;
}

interface FormState {
  name: string;
  type: ProductType;
  unit: Unit;
  sku: string;
  production_location_id: string;
  storage_location_id: string;
  min_qty: string;
  max_qty: string;
}

interface RecipeDraftLine {
  stage: RecipeStage;
  component_product_id: string;
  qty_per_unit: string;
}

const EMPTY_FORM: FormState = {
  name: '', type: 'raw', unit: 'kg', sku: '',
  production_location_id: '', storage_location_id: '',
  min_qty: '', max_qty: '',
};

function emptyLine(): RecipeDraftLine {
  return { stage: 'dough', component_product_id: '', qty_per_unit: '' };
}

export function ProductFormDialog({
  open,
  onOpenChange,
  onSaved,
  allProducts,
  editProduct,
}: ProductFormDialogProps) {
  const isEdit = editProduct !== undefined;
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [lines, setLines] = useState<RecipeDraftLine[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showProductionLocation = (form.type === 'semi' || form.type === 'finished');
  const productionLocsQuery = useApiQuery<Location[]>(
    open && showProductionLocation ? '/api/locations?type=production' : null,
  );
  const productionLocations = productionLocsQuery.data ?? [];
  const allLocsQuery = useApiQuery<Location[]>(open ? '/api/locations' : null);
  const allLocations = allLocsQuery.data ?? [];

  useEffect(() => {
    if (open) {
      setForm(
        editProduct
          ? {
              name: editProduct.name,
              type: editProduct.type,
              unit: editProduct.unit,
              sku: editProduct.sku ?? '',
              production_location_id: editProduct.production_location_id
                ? String(editProduct.production_location_id)
                : '',
              storage_location_id: editProduct.storage_location_id
                ? String(editProduct.storage_location_id)
                : '',
              min_qty: editProduct.min_qty != null ? String(editProduct.min_qty) : '',
              max_qty: editProduct.max_qty != null ? String(editProduct.max_qty) : '',
            }
          : EMPTY_FORM,
      );
      setLines([]);
      setError(null);
    }
  }, [open, editProduct?.id]);

  const showRecipe = !isEdit && form.type !== 'raw';
  const componentOptions = useMemo(() => allProducts, [allProducts]);
  const filledCount = lines.filter(
    (l) => l.component_product_id !== '' && Number(l.qty_per_unit) > 0,
  ).length;

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function updateLine(i: number, patch: Partial<RecipeDraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (showRecipe) {
      const filled = lines.filter(
        (l) => l.component_product_id !== '' || l.qty_per_unit !== '',
      );
      for (const line of filled) {
        if (line.component_product_id === '') {
          setError("Har bir qatorda komponent tanlanishi kerak.");
          return;
        }
        const qty = Number(line.qty_per_unit);
        if (!Number.isFinite(qty) || qty <= 0) {
          setError("Har bir komponent miqdori 0 dan katta bo'lishi kerak.");
          return;
        }
      }
      const ids = filled.map((l) => l.component_product_id);
      if (new Set(ids).size !== ids.length) {
        setError('Bitta komponent ikki marta kiritilgan.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const body = {
        name: form.name.trim(),
        type: form.type,
        unit: form.unit,
        sku: form.sku.trim() === '' ? null : form.sku.trim(),
        ...(showProductionLocation && {
          production_location_id:
            form.production_location_id === '' ? null : Number(form.production_location_id),
        }),
        storage_location_id:
          form.storage_location_id === '' ? null : Number(form.storage_location_id),
        min_qty: form.min_qty === '' ? null : Number(form.min_qty),
        max_qty: form.max_qty === '' ? null : Number(form.max_qty),
      };

      if (isEdit && editProduct) {
        await apiRequest<{ product: Product }>(`/api/products/${editProduct.id}`, {
          method: 'PATCH',
          body,
        });
      } else {
        const created = await apiRequest<{ product: Product }>('/api/products', {
          method: 'POST',
          body,
        });
        if (showRecipe && lines.length > 0) {
          const filled = lines.filter(
            (l) => l.component_product_id !== '' && Number(l.qty_per_unit) > 0,
          );
          if (filled.length > 0) {
            await apiRequest(`/api/products/${created.product.id}/recipe`, {
              method: 'PUT',
              body: {
                recipe: filled.map((l) => ({
                  component_product_id: Number(l.component_product_id),
                  qty_per_unit: Number(l.qty_per_unit),
                  stage: l.stage,
                })),
              },
            });
          }
        }
      }

      notify('success', isEdit ? 'Mahsulot yangilandi.' : "Mahsulot qo'shildi.");
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[90vw] max-w-4xl h-full flex flex-col gap-0 p-0 overflow-hidden bg-background text-foreground"
        showClose={false}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            {isEdit
              ? <Pencil className="size-5 text-primary" aria-hidden="true" />
              : <ChefHat className="size-5 text-primary" aria-hidden="true" />
            }
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {isEdit ? `Tahrirlash — ${editProduct?.name}` : 'Yangi mahsulot'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {isEdit
                ? "Mahsulot asosiy ma'lumotlarini tahrirlash (retsept alohida)"
                : "Mahsulot ma'lumotlarini va retseptini kiriting"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Yopish"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* ── Body ── */}
        <form
          id="product-form"
          onSubmit={handleSubmit}
          className={showRecipe ? 'flex flex-1 min-h-0 overflow-hidden' : 'flex flex-1 flex-col overflow-hidden'}
        >
          {/* Two-column layout when recipe shown */}
          {showRecipe ? (
            <>
              {/* LEFT — basic fields */}
              <div className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border p-6">
                <div className="space-y-2">
                  <Label htmlFor="pf-name" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Nomi
                  </Label>
                  <Input
                    id="pf-name"
                    required
                    placeholder="Mahsulot nomi"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pf-type" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Turi
                  </Label>
                  <Select
                    id="pf-type"
                    value={form.type}
                    onChange={(e) =>
                      setForm({ ...form, type: e.target.value as ProductType })
                    }
                  >
                    {PRODUCT_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pf-unit" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    O'lchov birligi
                  </Label>
                  <Select
                    id="pf-unit"
                    value={form.unit}
                    onChange={(e) =>
                      setForm({ ...form, unit: e.target.value as Unit })
                    }
                  >
                    {UNIT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pf-sku" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    SKU <span className="normal-case font-normal">(ixtiyoriy)</span>
                  </Label>
                  <Input
                    id="pf-sku"
                    placeholder="masalan: CAKE-001"
                    value={form.sku}
                    onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  />
                </div>

                {showProductionLocation && (
                  <div className="space-y-2">
                    <Label htmlFor="pf-prod-loc" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Ishlab chiqarish sexi <span className="normal-case font-normal">(ixtiyoriy)</span>
                    </Label>
                    <Select
                      id="pf-prod-loc"
                      value={form.production_location_id}
                      onChange={(e) => setForm({ ...form, production_location_id: e.target.value })}
                    >
                      <option value="">— Belgilanmagan —</option>
                      {productionLocations.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="pf-stor-loc" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Saqlash omborxonasi <span className="normal-case font-normal">(ixtiyoriy)</span>
                  </Label>
                  <Select
                    id="pf-stor-loc"
                    value={form.storage_location_id}
                    onChange={(e) => setForm({ ...form, storage_location_id: e.target.value })}
                  >
                    <option value="">— Belgilanmagan —</option>
                    {allLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="pf-min-qty" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Min miqdor
                    </Label>
                    <Input
                      id="pf-min-qty"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="—"
                      value={form.min_qty}
                      onChange={(e) => setForm({ ...form, min_qty: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pf-max-qty" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Max miqdor
                    </Label>
                    <Input
                      id="pf-max-qty"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="—"
                      value={form.max_qty}
                      onChange={(e) => setForm({ ...form, max_qty: e.target.value })}
                    />
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
              </div>

              {/* RIGHT — recipe table */}
              <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
                  <div>
                    <span className="text-sm font-semibold">RETSEPT</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {filledCount} ta to'ldirilgan / {lines.length} ta qator
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled
                      title="Tez orada"
                      className="text-xs"
                    >
                      <CloudDownload className="size-3.5" aria-hidden="true" />
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
                </div>

                {lines.length > 0 && (
                  <div className="grid grid-cols-[32px_130px_1fr_90px_60px_36px] items-center gap-2 border-b border-border/50 bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span className="text-center">#</span>
                    <span>BOSQICH</span>
                    <span>KOMPONENT</span>
                    <span className="text-center">MIQDOR</span>
                    <span className="text-center">BIRLIK</span>
                    <span />
                  </div>
                )}

                <div className="flex-1 overflow-y-auto">
                  {lines.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                      <ChefHat className="size-10 opacity-20" />
                      <p className="text-sm">Retsept qatorlari yo'q</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addLine}
                      >
                        <Plus className="size-4" />
                        Birinchi qatorni qo'shing
                      </Button>
                    </div>
                  ) : (
                    lines.map((line, i) => {
                      const comp = componentOptions.find(
                        (p) => String(p.id) === line.component_product_id,
                      );
                      return (
                        <div
                          key={i}
                          className="grid grid-cols-[32px_130px_1fr_90px_60px_36px] items-center gap-2 border-b border-border/30 px-4 py-2.5 last:border-0 hover:bg-muted/20"
                        >
                          <span className="text-center text-xs font-medium text-muted-foreground">
                            {i + 1}
                          </span>
                          <Select
                            value={line.stage}
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
                            type="number"
                            min={0}
                            step="any"
                            value={line.qty_per_unit}
                            onChange={(e) =>
                              updateLine(i, { qty_per_unit: e.target.value })
                            }
                            className="h-8 text-center text-xs"
                            placeholder="0"
                          />
                          <span className="text-center text-xs text-muted-foreground">
                            {comp ? UNIT_LABELS[comp.unit] : '—'}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  Bo'sh qatorlar o'tkazib yuboriladi. Faqat nomi va miqdori bor qatorlar saqlanadi.
                </div>
              </div>
            </>
          ) : (
            /* Single-column layout for edit / raw products */
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mx-auto max-w-md space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="pf-name-s">Nomi</Label>
                  <Input
                    id="pf-name-s"
                    required
                    placeholder="Mahsulot nomi"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="pf-type-s">Turi</Label>
                    <Select
                      id="pf-type-s"
                      value={form.type}
                      onChange={(e) =>
                        setForm({ ...form, type: e.target.value as ProductType })
                      }
                    >
                      {PRODUCT_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pf-unit-s">O'lchov birligi</Label>
                    <Select
                      id="pf-unit-s"
                      value={form.unit}
                      onChange={(e) =>
                        setForm({ ...form, unit: e.target.value as Unit })
                      }
                    >
                      {UNIT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pf-sku-s">SKU (ixtiyoriy)</Label>
                  <Input
                    id="pf-sku-s"
                    placeholder="masalan: RAW-001"
                    value={form.sku}
                    onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  />
                </div>
                {showProductionLocation && (
                  <div className="space-y-2">
                    <Label htmlFor="pf-prod-loc-s">
                      Ishlab chiqarish sexi (ixtiyoriy)
                    </Label>
                    <Select
                      id="pf-prod-loc-s"
                      value={form.production_location_id}
                      onChange={(e) => setForm({ ...form, production_location_id: e.target.value })}
                    >
                      <option value="">— Belgilanmagan —</option>
                      {productionLocations.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="pf-stor-loc-s">Saqlash omborxonasi (ixtiyoriy)</Label>
                  <Select
                    id="pf-stor-loc-s"
                    value={form.storage_location_id}
                    onChange={(e) => setForm({ ...form, storage_location_id: e.target.value })}
                  >
                    <option value="">— Belgilanmagan —</option>
                    {allLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="pf-min-qty-s">Min miqdor</Label>
                    <Input
                      id="pf-min-qty-s"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="—"
                      value={form.min_qty}
                      onChange={(e) => setForm({ ...form, min_qty: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pf-max-qty-s">Max miqdor</Label>
                    <Input
                      id="pf-max-qty-s"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="—"
                      value={form.max_qty}
                      onChange={(e) => setForm({ ...form, max_qty: e.target.value })}
                    />
                  </div>
                </div>
                {error && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}
              </div>
            </div>
          )}
        </form>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="product-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
