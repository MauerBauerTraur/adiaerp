import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Check, ChevronsUpDown, Loader2, Package } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { apiRequest, ApiError } from '@/lib/api-client';
import type {
  BomPreviewResponse,
  Location,
  Product,
  ProductionOrder,
} from '@/lib/types';
import {
  BomTreeNode,
  calcTotalCost,
  collectExpandableKeys,
  fmtCost,
  fmtQty,
  TYPE_CHIP,
  TYPE_LABELS,
} from './BomTree';

// ---------------------------------------------------------------------------
// Searchable product combobox
// ---------------------------------------------------------------------------
interface ComboOption {
  value: string;
  label: string;
}

function ProductCombobox({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? '',
    [options, value],
  );

  function closeDropdown() {
    setOpen(false);
    setQuery('');
  }

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const displayValue = open ? query : selectedLabel;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          value={displayValue}
          placeholder="Qidiring yoki tanlang…"
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setQuery('');
            setOpen(true);
          }}
          className="pr-8"
        />
        <ChevronsUpDown
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Mahsulot topilmadi.
            </p>
          ) : (
            filtered.map((opt) => (
              <div
                key={opt.value}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 ${
                  opt.value === value
                    ? 'bg-primary/10 font-medium text-primary'
                    : ''
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.value);
                  closeDropdown();
                  inputRef.current?.blur();
                }}
              >
                {opt.value === value ? (
                  <Check className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOM preview panel (right column)
// ---------------------------------------------------------------------------
function BomPreviewPanel({
  productId,
  qty,
  productName,
  onSuggestLocation,
}: {
  productId: string;
  qty: string;
  productName: string;
  onSuggestLocation?: (locationId: number | null) => void;
}) {
  const parsedQty = Number(qty);
  const ready = productId !== '' && Number.isFinite(parsedQty) && parsedQty > 0;

  // Debounce qty so we don't fire a request on every keystroke
  const [debouncedQty, setDebouncedQty] = useState(qty);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQty(qty), 450);
    return () => clearTimeout(t);
  }, [qty]);

  const url = ready
    ? `/api/production-orders/bom-preview?product_id=${productId}&qty=${debouncedQty}`
    : null;
  const { data, isLoading } = useApiQuery<BomPreviewResponse>(url);

  // Propagate suggested location to parent form
  const onSuggestLocationRef = useRef(onSuggestLocation);
  onSuggestLocationRef.current = onSuggestLocation;
  useEffect(() => {
    if (data && onSuggestLocationRef.current) {
      onSuggestLocationRef.current(data.suggested_location_id ?? null);
    }
  }, [data]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const keys = new Set<string>();
    collectExpandableKeys(data.bom, 0, keys);
    setExpanded(keys);
  }, [data]);

  function toggleNode(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 p-8 text-center text-muted-foreground">
        <Package className="size-10 opacity-30" />
        <p className="text-sm">
          Mahsulot va miqdor tanlanganidan keyin kerakli materiallar ko'rinadi.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Materiallar hisoblanmoqda…
      </div>
    );
  }

  const bom = data?.bom ?? [];
  const dispatch = data?.dispatch ?? [];
  const totalCost = calcTotalCost(bom);

  if (bom.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 p-8 text-center text-muted-foreground">
        <Package className="size-8 opacity-30" />
        <p className="text-sm">Bu mahsulot uchun retsept topilmadi.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/10">
      {/* Header */}
      <div className="border-b border-border/60 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Zarur materiallar
        </p>
        <p className="mt-0.5 truncate text-sm font-medium">{productName}</p>
      </div>

      {/* Type legend */}
      <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-4 py-2">
        {(['raw', 'semi', 'finished'] as const).map((t) => (
          <span
            key={t}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_CHIP[t]}`}
          >
            {TYPE_LABELS[t]}
          </span>
        ))}
      </div>

      {/* BOM tree (scrollable) */}
      <div className="flex-1 overflow-y-auto p-2">
        {bom.map((node) => (
          <BomTreeNode
            key={`0-${node.component_product_id}`}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggleNode}
          />
        ))}
      </div>

      {/* Sebestoimost total */}
      {totalCost != null && (
        <div className="border-t border-border/60 px-4 py-2.5 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sebestoimost (jami)
          </span>
          <span className="text-sm font-bold tabular-nums text-amber-600 dark:text-amber-400">
            ≈ {fmtCost(totalCost)}
          </span>
        </div>
      )}

      {/* Dispatch summary */}
      {dispatch.length > 0 && (
        <div className="border-t border-border/60">
          <div className="border-b border-border/40 px-4 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Ombordan berish — xomashyo jami
            </p>
          </div>
          <div className="max-h-44 overflow-y-auto divide-y divide-border/30">
            {dispatch.map((line) => (
              <div
                key={line.product_id}
                className="flex items-center justify-between px-4 py-1.5 text-sm"
              >
                <span className="truncate">{line.product_name}</span>
                <span className="ml-3 shrink-0 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {fmtQty(line.qty, line.product_unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form types
// ---------------------------------------------------------------------------
interface ProductionOrderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations?: Location[];
  editOrder?: ProductionOrder;
  defaultProductId?: number;
  onSaved: () => void;
}

interface FormState {
  product_id: string;
  qty: string;
  location_id: string;
  target_location_id: string;
  deadline: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  product_id: '',
  qty: '',
  location_id: '',
  target_location_id: '',
  deadline: '',
  note: '',
};

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------
export function ProductionOrderFormDialog({
  open,
  onOpenChange,
  products,
  locations,
  editOrder,
  defaultProductId,
  onSaved,
}: ProductionOrderFormDialogProps) {
  const { notify } = useToast();
  const isEdit = editOrder !== undefined;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-populate form when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (isEdit && editOrder) {
      setForm({
        product_id: String(editOrder.product_id),
        qty: String(editOrder.qty),
        location_id: String(editOrder.location_id),
        target_location_id: editOrder.target_location_id
          ? String(editOrder.target_location_id)
          : '',
        deadline: editOrder.deadline ?? '',
        note: editOrder.note ?? '',
      });
    } else {
      setForm({
        ...EMPTY_FORM,
        product_id: defaultProductId !== undefined ? String(defaultProductId) : '',
      });
    }
  }, [open, isEdit, editOrder?.id, defaultProductId]);

  // Self-fetch production locations
  const hasProductionLocs =
    locations !== undefined && locations.some((l) => l.type === 'production');
  const productionLocsFetch = useApiQuery<Location[]>(
    open && !isEdit && !hasProductionLocs ? '/api/locations?type=production' : null,
  );
  const productionLocations = useMemo<Location[]>(() => {
    if (hasProductionLocs) return (locations ?? []).filter((l) => l.type === 'production');
    return productionLocsFetch.data ?? [];
  }, [hasProductionLocs, locations, productionLocsFetch.data]);

  // Auto-select location when only one is available
  useEffect(() => {
    if (isEdit || form.location_id !== '' || productionLocations.length !== 1) return;
    setForm((prev) => ({
      ...prev,
      location_id: String(productionLocations[0]!.id),
    }));
  }, [isEdit, productionLocations, form.location_id]);

  // Apply suggested location from bom-preview (historical most-used location)
  const handleSuggestLocation = useCallback(
    (locationId: number | null) => {
      if (isEdit || locationId === null) return;
      setForm((prev) => {
        if (prev.location_id !== '') return prev;
        return { ...prev, location_id: String(locationId) };
      });
    },
    [isEdit],
  );

  // Reset location when product changes so a new suggestion can apply.
  // If the product has a fixed production_location_id, auto-apply it.
  const prevProductIdRef = useRef(form.product_id);
  useEffect(() => {
    if (isEdit) return;
    if (prevProductIdRef.current !== form.product_id) {
      prevProductIdRef.current = form.product_id;
      const selectedProduct = products.find((p) => String(p.id) === form.product_id);
      if (selectedProduct?.production_location_id) {
        setForm((prev) => ({
          ...prev,
          location_id: String(selectedProduct.production_location_id),
        }));
      } else if (productionLocations.length !== 1) {
        setForm((prev) => ({ ...prev, location_id: '' }));
      }
    }
  }, [form.product_id, isEdit, products, productionLocations.length]);

  // Target locations
  const centralWarehouses = useApiQuery<Location[]>(
    open && !isEdit ? '/api/locations?type=central_warehouse' : null,
  );
  const supplyLocations = useApiQuery<Location[]>(
    open && !isEdit ? '/api/locations?type=supply' : null,
  );
  const targetLocations = useMemo<Location[]>(() => {
    const rows = [
      ...(centralWarehouses.data ?? []),
      ...(supplyLocations.data ?? []),
    ];
    const byId = new Map<number, Location>();
    for (const row of rows) byId.set(row.id, row);
    return Array.from(byId.values());
  }, [centralWarehouses.data, supplyLocations.data]);

  const eligibleProducts = useMemo(
    () => products.filter((p) => p.type === 'semi' || p.type === 'finished'),
    [products],
  );
  const productOptions = useMemo<ComboOption[]>(
    () => eligibleProducts.map((p) => ({ value: String(p.id), label: p.name })),
    [eligibleProducts],
  );

  const lockProduct = isEdit || defaultProductId !== undefined;
  const lockLocation = isEdit;

  const lockedProductName = useMemo(() => {
    if (!lockProduct) return null;
    const pid = isEdit ? editOrder?.product_id : defaultProductId;
    return products.find((p) => p.id === pid)?.name ?? `#${pid}`;
  }, [lockProduct, isEdit, editOrder?.product_id, defaultProductId, products]);

  const selectedProductName = useMemo(() => {
    if (lockProduct) return lockedProductName ?? '';
    return products.find((p) => String(p.id) === form.product_id)?.name ?? '';
  }, [lockProduct, lockedProductName, products, form.product_id]);

  const lockedLocationName = useMemo(() => {
    if (!lockLocation) return null;
    return (
      editOrder?.location_name ??
      (locations ?? []).find((l) => l.id === editOrder?.location_id)?.name ??
      `#${editOrder?.location_id}`
    );
  }, [lockLocation, editOrder, locations]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const qty = Number(form.qty.replace(',', '.'));
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Miqdor 0 dan katta bo'lishi kerak.");
      return;
    }
    if (!isEdit && (form.product_id === '' || form.location_id === '')) {
      setError("Mahsulot va ishlab chiqarish bo'g'inini tanlang.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (isEdit && editOrder) {
        await apiRequest(`/api/production-orders/${editOrder.id}`, {
          method: 'PUT',
          body: {
            qty,
            deadline: form.deadline === '' ? null : form.deadline,
            note: form.note.trim() === '' ? null : form.note.trim(),
          },
        });
        notify('success', 'Zayavka yangilandi.');
      } else {
        const result = await apiRequest<{
          production_order: unknown;
          sub_orders: { id: number; product_name?: string }[];
          stock_notes: { product_name: string; available: number; needed: number }[];
        }>('/api/production-orders', {
          method: 'POST',
          body: {
            product_id: Number(form.product_id),
            qty,
            location_id: Number(form.location_id),
            target_location_id:
              form.target_location_id === '' ? null : Number(form.target_location_id),
            deadline: form.deadline === '' ? null : form.deadline,
            note: form.note.trim() === '' ? null : form.note.trim(),
          },
        });
        if (result.sub_orders.length > 0) {
          const names = result.sub_orders.map((s) => `#${s.id}`).join(', ');
          notify('success', `Zayafka yaratildi. Avtomat sub-zayavkalar: ${names}`);
        } else if (result.stock_notes.length > 0) {
          const names = result.stock_notes.map((n) => n.product_name).join(', ');
          notify('success', `Zayafka yaratildi. Skladda yetarli: ${names}`);
        } else {
          notify('success', 'Zayafka yaratildi.');
        }
      }
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : isEdit
            ? "Zayavkani yangilab bo'lmadi."
            : "Zayafkani yaratib bo'lmadi.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const previewProductId = lockProduct
    ? String(isEdit ? editOrder?.product_id ?? '' : defaultProductId ?? '')
    : form.product_id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Full-screen on all breakpoints */}
      <DialogContent className="flex flex-col sm:left-0 sm:top-0 sm:h-screen sm:max-h-screen sm:w-screen sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none sm:border-0">
        {/* Header */}
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pt-6">
          <DialogTitle>
            {isEdit
              ? `Zayavkani tahrirlash — #${editOrder?.id}`
              : 'Yangi ishlab chiqarish zayafkasi'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Miqdor, muddat va izohni o'zgartirish mumkin."
              : 'Tayyor yoki yarim tayyor mahsulot uchun zayafka tuzing.'}
          </DialogDescription>
        </DialogHeader>

        {/* Two-column body (scrollable) */}
        <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          {/* LEFT — form fields */}
          <div className="flex shrink-0 flex-col overflow-y-auto border-b border-border/60 px-6 py-6 lg:w-[420px] lg:border-b-0 lg:border-r">
            <form id="po-form" className="flex flex-col gap-5" onSubmit={handleSubmit}>
              {/* Product */}
              <div className="space-y-2">
                <Label htmlFor="po-product">Mahsulot</Label>
                {lockProduct ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                    {lockedProductName}
                  </div>
                ) : (
                  <ProductCombobox
                    id="po-product"
                    options={productOptions}
                    value={form.product_id}
                    onChange={(val) =>
                      setForm((prev) => ({ ...prev, product_id: val }))
                    }
                  />
                )}
              </div>

              {/* Qty */}
              <div className="space-y-2">
                <Label htmlFor="po-qty">Miqdor</Label>
                <Input
                  id="po-qty"
                  name="qty"
                  type="text"
                  inputMode="decimal"
                  required
                  placeholder="0"
                  value={form.qty}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, qty: e.target.value }))
                  }
                />
              </div>

              {/* Location — locked in edit mode */}
              {!isEdit && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="po-loc">Ishlab chiqarish bo'g'ini</Label>
                    <Select
                      id="po-loc"
                      name="location_id"
                      required
                      value={form.location_id}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          location_id: e.target.value,
                        }))
                      }
                    >
                      <option value="">— Tanlang —</option>
                      {productionLocations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="po-target">Maqsad (ixtiyoriy)</Label>
                    <Select
                      id="po-target"
                      name="target_location_id"
                      value={form.target_location_id}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          target_location_id: e.target.value,
                        }))
                      }
                    >
                      <option value="">— Tanlanmagan —</option>
                      {targetLocations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}

              {/* Locked location (edit mode) */}
              {isEdit && (
                <div className="space-y-2">
                  <Label>Ishlab chiqarish bo'g'ini</Label>
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                    {lockedLocationName}
                    {editOrder?.target_location_name && (
                      <span className="ml-2 text-muted-foreground">
                        → {editOrder.target_location_name}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Deadline */}
              <div className="space-y-2">
                <Label htmlFor="po-deadline">Muddat (ixtiyoriy)</Label>
                <Input
                  id="po-deadline"
                  name="deadline"
                  type="date"
                  value={form.deadline}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, deadline: e.target.value }))
                  }
                />
              </div>

              {/* Note */}
              <div className="space-y-2">
                <Label htmlFor="po-note">Izoh (ixtiyoriy)</Label>
                <Textarea
                  id="po-note"
                  name="note"
                  rows={3}
                  value={form.note}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, note: e.target.value }))
                  }
                />
              </div>

              {error && (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </form>
          </div>

          {/* RIGHT — BOM preview */}
          <div className="flex min-h-[240px] flex-1 overflow-hidden p-6">
            <div className="w-full">
              <BomPreviewPanel
                productId={previewProductId}
                qty={form.qty}
                productName={selectedProductName}
                onSuggestLocation={isEdit ? undefined : handleSuggestLocation}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="po-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {isEdit ? 'Saqlash' : 'Yaratish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
