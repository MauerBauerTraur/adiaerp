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

interface PurchaseOrderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations: Location[];
  onSaved: () => void;
}

interface FormState {
  product_id: string;
  qty: string;
  target_location_id: string;
  supplier_id: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  product_id: '',
  qty: '',
  target_location_id: '',
  supplier_id: '',
  note: '',
};

/**
 * Create a purchase order draft — `POST /api/purchase-orders` (M6, §4.7).
 * Only `pm` and `supply_manager` may raise a draft. The target_location_id
 * is typically the raw warehouse that will receive the inbound stock.
 *
 * The draft must then be approved through two steps (manager + keeper)
 * — see `ApprovalPanel`.
 */
export function PurchaseOrderFormDialog({
  open,
  onOpenChange,
  products,
  locations,
  onSaved,
}: PurchaseOrderFormDialogProps) {
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

  // Raw materials go to a raw warehouse — narrow the targets list.
  const rawWarehouses = locations.filter((l) => l.type === 'raw_warehouse');
  const rawProducts = products.filter((p) => p.type === 'raw');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (form.product_id === '' || form.target_location_id === '') {
      setError('Mahsulot va qabul qiluvchi bo‘g‘inni tanlang.');
      return;
    }
    const qty = Number(form.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Miqdor 0 dan katta bo‘lishi kerak.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/purchase-orders', {
        method: 'POST',
        body: {
          product_id: Number(form.product_id),
          qty,
          target_location_id: Number(form.target_location_id),
          supplier_id:
            form.supplier_id.trim() === '' ? null : Number(form.supplier_id),
          note: form.note.trim() === '' ? null : form.note.trim(),
        },
      });
      notify('success', 'Sotib olish so‘rovi yaratildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'So‘rovni yaratib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yangi sotib olish so‘rovi</DialogTitle>
          <DialogDescription>
            Xom-ashyo uchun loyiha so‘rov tuzing — keyin u ikki bosqichli
            tasdiqdan o‘tadi.
          </DialogDescription>
        </DialogHeader>

        <form id="purch-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="purch-product">Mahsulot</Label>
            <Select
              id="purch-product"
              name="product_id"
              required
              value={form.product_id}
              onChange={(e) =>
                setForm({ ...form, product_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {rawProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="purch-qty">Miqdor</Label>
            <Input
              id="purch-qty"
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
            <Label htmlFor="purch-target">Qabul qiluvchi bo‘g‘in</Label>
            <Select
              id="purch-target"
              name="target_location_id"
              required
              value={form.target_location_id}
              onChange={(e) =>
                setForm({ ...form, target_location_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {rawWarehouses.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="purch-supplier">Yetkazib beruvchi ID (ixtiyoriy)</Label>
            <Input
              id="purch-supplier"
              name="supplier_id"
              type="number"
              min={1}
              value={form.supplier_id}
              onChange={(e) =>
                setForm({ ...form, supplier_id: e.target.value })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="purch-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="purch-note"
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
          <Button type="submit" form="purch-form" disabled={isSubmitting}>
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
