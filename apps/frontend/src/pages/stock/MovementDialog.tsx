import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
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
import { apiRequest, ApiError } from '@/lib/api-client';
import type { Location, Product } from '@/lib/types';

/** The three movement directions a user can record manually. */
type MovementKind = 'in' | 'out' | 'transfer';

const KIND_OPTIONS: { value: MovementKind; label: string }[] = [
  { value: 'in', label: 'Kirim' },
  { value: 'out', label: 'Chiqim' },
  { value: 'transfer', label: 'Ko‘chirish (transfer)' },
];

interface MovementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations: Location[];
  /** Location currently in scope — used as the default for in/out. */
  scopeLocationId: string;
  onSaved: () => void;
}

interface FormState {
  kind: MovementKind;
  product_id: string;
  location_id: string;
  from_location_id: string;
  to_location_id: string;
  qty: string;
  note: string;
}

function emptyForm(scopeLocationId: string): FormState {
  return {
    kind: 'in',
    product_id: '',
    location_id: scopeLocationId,
    from_location_id: scopeLocationId,
    to_location_id: '',
    qty: '',
    note: '',
  };
}

/**
 * Records a stock movement — `POST /api/stock/movement` (M3, §4.4).
 *
 * Kirim → `to_location_id` only · Chiqim → `from_location_id` only ·
 * Transfer → both. A `409 INSUFFICIENT_STOCK` is surfaced as a clear
 * Uzbek message so the user understands the source lacked enough qty.
 */
export function MovementDialog({
  open,
  onOpenChange,
  products,
  locations,
  scopeLocationId,
  onSaved,
}: MovementDialogProps) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(() =>
    emptyForm(scopeLocationId),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(emptyForm(scopeLocationId));
      setError(null);
    }
  }, [open, scopeLocationId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const qty = Number(form.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Miqdor 0 dan katta bo‘lishi kerak.');
      return;
    }

    // Map the chosen direction to the API's from/to fields and reason.
    // A `<select>` value is always a string; the backend expects numeric
    // ids, so each chosen id is converted with `Number(...)` before send.
    // `reason`: a one-sided in/out movement is an inventory `adjust`;
    // a two-sided move is a `transfer`. `purchase`/`sale`/`production`
    // reasons are produced by the backend / Poster sync, not the client.
    let from_location_id: number | null = null;
    let to_location_id: number | null = null;
    let reason: 'adjust' | 'transfer';

    if (form.kind === 'in') {
      to_location_id = Number(form.location_id);
      reason = 'adjust';
    } else if (form.kind === 'out') {
      from_location_id = Number(form.location_id);
      reason = 'adjust';
    } else {
      if (form.from_location_id === '' || form.to_location_id === '') {
        setError('Manba va qabul qiluvchi bo‘g‘inni tanlang.');
        return;
      }
      if (form.from_location_id === form.to_location_id) {
        setError('Manba va qabul qiluvchi bo‘g‘in bir xil bo‘lmasligi kerak.');
        return;
      }
      from_location_id = Number(form.from_location_id);
      to_location_id = Number(form.to_location_id);
      reason = 'transfer';
    }

    if (form.product_id === '') {
      setError('Mahsulotni tanlang.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/stock/movement', {
        method: 'POST',
        body: {
          product_id: Number(form.product_id),
          from_location_id,
          to_location_id,
          qty,
          reason,
          note: form.note.trim() === '' ? null : form.note.trim(),
        },
      });
      notify('success', 'Harakat saqlandi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setError(
          'Manba bo‘g‘inda yetarli qoldiq yo‘q. Harakat bajarilmadi.',
        );
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Harakatni saqlab bo‘lmadi.',
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const showSingleLocation = form.kind !== 'transfer';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ombor harakati</DialogTitle>
          <DialogDescription>
            Kirim, chiqim yoki bo‘g‘inlararo ko‘chirishni qayd eting.
          </DialogDescription>
        </DialogHeader>

        <form id="movement-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="mv-kind">Harakat turi</Label>
            <Select
              id="mv-kind"
              name="kind"
              value={form.kind}
              onChange={(e) =>
                setForm({ ...form, kind: e.target.value as MovementKind })
              }
            >
              {KIND_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="mv-product">Mahsulot</Label>
            <Select
              id="mv-product"
              name="product_id"
              required
              value={form.product_id}
              onChange={(e) =>
                setForm({ ...form, product_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          {showSingleLocation ? (
            <div className="space-y-2">
              <Label htmlFor="mv-location">Bo‘g‘in</Label>
              <Select
                id="mv-location"
                name="location_id"
                required
                value={form.location_id}
                onChange={(e) =>
                  setForm({ ...form, location_id: e.target.value })
                }
              >
                <option value="">— Tanlang —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="mv-from">Manba bo‘g‘in</Label>
                <Select
                  id="mv-from"
                  name="from_location_id"
                  required
                  value={form.from_location_id}
                  onChange={(e) =>
                    setForm({ ...form, from_location_id: e.target.value })
                  }
                >
                  <option value="">— Tanlang —</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mv-to">Qabul qiluvchi</Label>
                <Select
                  id="mv-to"
                  name="to_location_id"
                  required
                  value={form.to_location_id}
                  onChange={(e) =>
                    setForm({ ...form, to_location_id: e.target.value })
                  }
                >
                  <option value="">— Tanlang —</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="mv-qty">Miqdor</Label>
            <Input
              id="mv-qty"
              name="qty"
              type="number"
              min={0}
              step="any"
              required
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mv-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="mv-note"
              name="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
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

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="movement-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
