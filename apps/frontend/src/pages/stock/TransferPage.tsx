import { useState, useMemo, useCallback, type FormEvent } from 'react';
import { ArrowRight, Loader2, PackageCheck, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ProductCombobox } from '@/components/ui/product-combobox';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty, formatDateTime } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { Location, Product, StockRow, StockMovement } from '@/lib/types';

// One row in the items list
interface TransferItem {
  id: number;
  product_id: string;
  qty: string;
}

let nextId = 1;
function makeItem(): TransferItem {
  return { id: nextId++, product_id: '', qty: '' };
}

export function TransferPage() {
  const { user } = useAuth();
  const { notify } = useToast();

  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<TransferItem[]>([makeItem()]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const isSuperUser = user?.role === 'pm' || user?.role === 'super_admin';

  const { data: locations } = useApiQuery<Location[]>('/api/locations');
  const { data: products } = useApiQuery<Product[]>('/api/products');

  // Stock at from_location
  const { data: fromStock } = useApiQuery<StockRow[]>(
    fromLocationId ? `/api/stock?location_id=${fromLocationId}` : null,
  );

  // Recent transfers
  const historyPath = useMemo(() => {
    const params = new URLSearchParams({ reason: 'transfer', limit: '30' });
    if (fromLocationId) params.set('location_id', fromLocationId);
    else if (!isSuperUser && user?.location_id) params.set('location_id', String(user.location_id));
    return `/api/stock/movements?${params.toString()}&_k=${refreshKey}`;
  }, [fromLocationId, isSuperUser, user?.location_id, refreshKey]);

  const { data: historyEnvelope } = useApiQuery<{ items: StockMovement[] }>(historyPath);
  const recentTransfers = historyEnvelope?.items ?? [];

  // Products with stock at from_location
  const availableProducts = useMemo(() => {
    if (!products) return [];
    if (!fromStock) return products;
    const hasStock = new Set(fromStock.filter((r) => r.qty > 0).map((r) => r.product_id));
    return products.filter((p) => hasStock.has(p.id));
  }, [products, fromStock]);

  // Products not yet chosen in other rows (to avoid duplicates)
  function unusedProducts(currentItemId: number) {
    const chosen = new Set(
      items.filter((i) => i.id !== currentItemId && i.product_id !== '').map((i) => Number(i.product_id)),
    );
    return availableProducts.filter((p) => !chosen.has(p.id));
  }

  const toLocations = useMemo(
    () => (locations ?? []).filter((l) => String(l.id) !== fromLocationId),
    [locations, fromLocationId],
  );

  function stockFor(productId: string): StockRow | undefined {
    if (!fromStock || !productId) return undefined;
    return fromStock.find((r) => r.product_id === Number(productId));
  }

  // ── item mutations ──────────────────────────────────────────────────────────
  const addItem = useCallback(() => setItems((prev) => [...prev, makeItem()]), []);

  const removeItem = useCallback(
    (id: number) => setItems((prev) => prev.filter((i) => i.id !== id)),
    [],
  );

  const updateItem = useCallback(
    (id: number, patch: Partial<Omit<TransferItem, 'id'>>) =>
      setItems((prev) =>
        prev.map((i) => {
          if (i.id !== id) return i;
          const next = { ...i, ...patch };
          // Reset qty when product changes
          if ('product_id' in patch) next.qty = '';
          return next;
        }),
      ),
    [],
  );

  function handleFromChange(val: string) {
    setFromLocationId(val);
    // Reset items when from changes — stock changes
    setItems([makeItem()]);
    setErrors({});
    setFormError(null);
    if (toLocationId === val) setToLocationId('');
  }

  // ── submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setErrors({});

    if (!fromLocationId || !toLocationId) {
      setFormError("Manba va qabul qiluvchi omborni tanlang.");
      return;
    }
    if (fromLocationId === toLocationId) {
      setFormError("Manba va qabul qiluvchi ombor bir xil bo'lmasligi kerak.");
      return;
    }

    // Validate each item
    const rowErrors: Record<number, string> = {};
    for (const item of items) {
      if (!item.product_id) {
        rowErrors[item.id] = "Mahsulotni tanlang.";
        continue;
      }
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        rowErrors[item.id] = "Miqdor 0 dan katta bo'lishi kerak.";
        continue;
      }
      const avail = stockFor(item.product_id)?.qty ?? null;
      if (avail !== null && qty > avail) {
        rowErrors[item.id] = `Yetarli qoldiq yo'q. Mavjud: ${formatQty(avail)}`;
      }
    }
    if (Object.keys(rowErrors).length > 0) {
      setErrors(rowErrors);
      return;
    }

    setIsSubmitting(true);
    const noteVal = note.trim() || null;
    const fromId = Number(fromLocationId);
    const toId = Number(toLocationId);
    let failCount = 0;

    // Send each item sequentially — stops on first insufficient-stock error
    for (const item of items) {
      try {
        await apiRequest('/api/stock/movement', {
          method: 'POST',
          body: {
            product_id: Number(item.product_id),
            from_location_id: fromId,
            to_location_id: toId,
            qty: Number(item.qty),
            reason: 'transfer',
            note: noteVal,
          },
        });
      } catch (err) {
        failCount++;
        const msg =
          err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'
            ? "Yetarli qoldiq yo'q."
            : err instanceof ApiError
            ? err.message
            : "Xatolik yuz berdi.";
        setErrors((prev) => ({ ...prev, [item.id]: msg }));
      }
    }

    setIsSubmitting(false);

    if (failCount === 0) {
      notify('success', `${items.length} ta mahsulot o'tkazildi.`);
      setItems([makeItem()]);
      setNote('');
      setErrors({});
      setRefreshKey((k) => k + 1);
    } else {
      setFormError(`${failCount} ta mahsulot o'tkazilmadi. Xatoliklarni tekshiring.`);
      setRefreshKey((k) => k + 1);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Omborlararo o'tkazish"
        description="Bir ombordan boshqa omborga mahsulot(lar) o'tkazish"
      />

      <Card className="p-5">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* From → To */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <div className="space-y-2">
              <Label htmlFor="tr-from">Qayerdan (manba)</Label>
              <Select
                id="tr-from"
                value={fromLocationId}
                onChange={(e) => handleFromChange(e.target.value)}
              >
                <option value="">— Tanlang —</option>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </div>

            <div className="flex items-end justify-center pb-1">
              <ArrowRight className="size-5 text-muted-foreground" aria-hidden="true" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tr-to">Qayerga (qabul)</Label>
              <Select
                id="tr-to"
                value={toLocationId}
                onChange={(e) => { setToLocationId(e.target.value); setFormError(null); }}
                disabled={!fromLocationId}
              >
                <option value="">— Tanlang —</option>
                {toLocations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </div>
          </div>

          {/* Items table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Mahsulotlar</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!fromLocationId}
                onClick={addItem}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Qo'shish
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Mahsulot</th>
                    <th className="w-24 px-3 py-2 text-left font-medium text-muted-foreground">Mavjud</th>
                    <th className="w-36 px-3 py-2 text-left font-medium text-muted-foreground">Miqdor</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => {
                    const stock = stockFor(item.product_id);
                    const avail = stock?.qty ?? null;
                    const unit = stock ? (UNIT_LABELS[stock.product_unit as keyof typeof UNIT_LABELS] ?? stock.product_unit) : '';
                    const rowError = errors[item.id];
                    const opts = unusedProducts(item.id);

                    return (
                      <tr key={item.id} className={idx % 2 === 0 ? '' : 'bg-muted/20'}>
                        <td className="px-3 py-2">
                          <ProductCombobox
                            value={item.product_id}
                            onChange={(v) => updateItem(item.id, { product_id: v })}
                            disabled={!fromLocationId}
                            className="w-full min-w-[180px]"
                            options={opts.map((p) => {
                              const s = fromStock?.find((r) => r.product_id === p.id);
                              const u = s ? (UNIT_LABELS[s.product_unit as keyof typeof UNIT_LABELS] ?? s.product_unit) : '';
                              const q = s ? ` (${formatQty(s.qty)} ${u})` : '';
                              return { value: String(p.id), label: `${p.name}${q}` };
                            })}
                          />
                          {rowError && (
                            <p className="mt-1 text-xs text-destructive">{rowError}</p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {avail !== null ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <PackageCheck className="size-3" aria-hidden="true" />
                              <span className="font-semibold text-foreground">{formatQty(avail)}</span>
                              {unit}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            min={0.001}
                            step="any"
                            max={avail ?? undefined}
                            value={item.qty}
                            disabled={!item.product_id}
                            onChange={(e) => updateItem(item.id, { qty: e.target.value })}
                            className="w-full"
                          />
                        </td>
                        <td className="px-2 py-2">
                          {items.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeItem(item.id)}
                              className="flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              aria-label="Qatorni o'chirish"
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Note */}
          <div className="space-y-2">
            <Label htmlFor="tr-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="tr-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="resize-none"
              placeholder="Masalan: Ishlab chiqarish uchun"
            />
          </div>

          {formError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting || !fromLocationId || !toLocationId}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            O'tkazish ({items.length} mahsulot)
          </Button>
        </form>
      </Card>

      {/* Recent transfers */}
      <div>
        <h2 className="mb-3 text-base font-semibold">So'nggi o'tkazishlar</h2>
        <RecentTransfersTable transfers={recentTransfers} />
      </div>
    </div>
  );
}

function RecentTransfersTable({ transfers }: { transfers: StockMovement[] }) {
  if (transfers.length === 0) {
    return <EmptyState message="O'tkazishlar tarixi topilmadi." />;
  }
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sana</TableHead>
            <TableHead>Mahsulot</TableHead>
            <TableHead>Qayerdan</TableHead>
            <TableHead>Qayerga</TableHead>
            <TableHead className="text-right">Miqdor</TableHead>
            <TableHead>Izoh</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transfers.map((t) => {
            const unit = UNIT_LABELS[t.product_unit as keyof typeof UNIT_LABELS] ?? t.product_unit;
            return (
              <TableRow key={t.id}>
                <TableCell className="tabular-nums text-sm text-muted-foreground whitespace-nowrap">
                  {formatDateTime(t.created_at)}
                </TableCell>
                <TableCell className="font-medium">{t.product_name}</TableCell>
                <TableCell className="text-muted-foreground">{t.from_location_name ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{t.to_location_name ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(t.qty)} <span className="text-xs text-muted-foreground">{unit}</span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{t.note ?? '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
