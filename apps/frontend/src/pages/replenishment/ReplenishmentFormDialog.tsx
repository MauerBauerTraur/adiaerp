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

interface ReplenishmentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations: Location[];
  onSaved: () => void;
}

interface FormState {
  product_id: string;
  requester_location_id: string;
  qty_needed: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  product_id: '',
  requester_location_id: '',
  qty_needed: '',
  note: '',
};

/**
 * Manual replenishment creation — `POST /api/replenishment` (M4, §4.5).
 * Allowed for `pm` and `central_warehouse_manager` only (D2 — boshqalar
 * faqat avtomatik tsikl orqali so‘rov ko‘taradi).
 *
 * The backend's partial UNIQUE index guards against duplicate open
 * requests per `(product, location)` (invariant 2); a 409
 * `OPEN_REQUEST_EXISTS` is surfaced as a clear Uzbek message.
 */
export function ReplenishmentFormDialog({
  open,
  onOpenChange,
  products,
  locations,
  onSaved,
}: ReplenishmentFormDialogProps) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (form.product_id === '' || form.requester_location_id === '') {
      setError('Mahsulot va bo‘g‘inni tanlang.');
      return;
    }
    const qty = Number(form.qty_needed);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Miqdor 0 dan katta bo‘lishi kerak.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/replenishment', {
        method: 'POST',
        body: {
          product_id: Number(form.product_id),
          requester_location_id: Number(form.requester_location_id),
          qty_needed: qty,
          note: form.note.trim() === '' ? null : form.note.trim(),
        },
      });
      notify('success', 'So‘rov yaratildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'OPEN_REQUEST_EXISTS') {
        setError(
          'Bu mahsulot uchun ushbu bo‘g‘inda ochiq so‘rov allaqachon bor.',
        );
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : 'So‘rovni yaratib bo‘lmadi.',
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Qo‘lda to‘ldirish so‘rovi</DialogTitle>
          <DialogDescription>
            Bo‘g‘in uchun mahsulot va kerakli miqdorni belgilang.
          </DialogDescription>
        </DialogHeader>

        <form id="repl-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="repl-product">Mahsulot</Label>
            <Select
              id="repl-product"
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

          <div className="space-y-2">
            <Label htmlFor="repl-location">So‘rovchi bo‘g‘in</Label>
            <Select
              id="repl-location"
              name="requester_location_id"
              required
              value={form.requester_location_id}
              onChange={(e) =>
                setForm({ ...form, requester_location_id: e.target.value })
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
            <Label htmlFor="repl-qty">Kerakli miqdor</Label>
            <Input
              id="repl-qty"
              name="qty_needed"
              type="number"
              min={0}
              step="any"
              required
              value={form.qty_needed}
              onChange={(e) => setForm({ ...form, qty_needed: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="repl-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="repl-note"
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
          <Button type="submit" form="repl-form" disabled={isSubmitting}>
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
