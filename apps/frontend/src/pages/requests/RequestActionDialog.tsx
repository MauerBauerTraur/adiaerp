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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatQty } from '@/lib/format';
import type { ReplenishmentRequest } from '@/lib/types';

/**
 * F4.14 — accept / reject / partial / return action dialog for an
 * open replenishment_request. One component, four `action` modes:
 *
 *   - `accept_full`    → POST /api/replenishment/:id/accept
 *                        { qty_accepted: <qty_needed>, note? }
 *   - `accept_partial` → POST /api/replenishment/:id/accept
 *                        { qty_accepted: <input>, note }  (note majburiy,
 *                        input < qty_needed)
 *   - `reject`         → POST /api/replenishment/:id/reject  { reason }
 *   - `return`         → POST /api/replenishment/:id/return
 *                        { qty_returned, reason }
 *
 * The dialog is fully controlled: parent decides which action to render
 * and handles the actual fetch (so the same dialog can be used from the
 * list view and the detail view without duplicating the API plumbing).
 */
export type RequestActionMode =
  | 'accept_full'
  | 'accept_partial'
  | 'reject'
  | 'return';

export interface RequestActionPayload {
  mode: RequestActionMode;
  qty?: number;
  note?: string;
  reason?: string;
}

interface RequestActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: RequestActionMode;
  request: ReplenishmentRequest;
  onConfirm: (payload: RequestActionPayload) => Promise<void> | void;
  isSubmitting?: boolean;
}

interface ModeCopy {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Shown above the textarea. */
  noteLabel: string;
  /** Whether the freeform note/reason input is required. */
  noteRequired: boolean;
  /** Placeholder hint for the note/reason input. */
  notePlaceholder: string;
  /** Renders a quantity input above the note. */
  showQtyInput: boolean;
  /** Label for the qty input when shown. */
  qtyLabel?: string;
}

function modeCopy(mode: RequestActionMode): ModeCopy {
  switch (mode) {
    case 'accept_full':
      return {
        title: "To'liq qabul qilish",
        description: "So'rovning to'liq miqdori qabul qilindi.",
        confirmLabel: 'Tasdiqlash',
        noteLabel: 'Izoh (ixtiyoriy)',
        noteRequired: false,
        notePlaceholder: "Masalan: barcha tovar yetib keldi",
        showQtyInput: false,
      };
    case 'accept_partial':
      return {
        title: 'Qisman qabul qilish',
        description:
          "Qabul qilingan miqdorni va sababini kiriting. Qolgan qism ortga qaytariladi.",
        confirmLabel: 'Tasdiqlash',
        noteLabel: 'Izoh (majburiy)',
        noteRequired: true,
        notePlaceholder:
          "Masalan: 3 dona kam keldi, qolganini qaytarib yubordik",
        showQtyInput: true,
        qtyLabel: 'Qabul qilingan miqdor',
      };
    case 'reject':
      return {
        title: 'Rad etish — kelmadi',
        description:
          "Tovar yetib kelmadi yoki butunlay rad etilmoqda. Sababini yozing.",
        confirmLabel: 'Rad etish',
        destructive: true,
        noteLabel: 'Sababi (majburiy)',
        noteRequired: true,
        notePlaceholder: "Masalan: yetkazib beruvchi olib kelmadi",
        showQtyInput: false,
      };
    case 'return':
      return {
        title: 'Qaytarish',
        description:
          "Yetkazilgan tovarni qisman yoki to'liq qaytarish. Miqdor va sababini kiriting.",
        confirmLabel: 'Qaytarish',
        destructive: true,
        noteLabel: 'Sababi (majburiy)',
        noteRequired: true,
        notePlaceholder: 'Masalan: yaroqsiz, sifati past',
        showQtyInput: true,
        qtyLabel: 'Qaytariladigan miqdor',
      };
  }
}

export function RequestActionDialog({
  open,
  onOpenChange,
  mode,
  request,
  onConfirm,
  isSubmitting = false,
}: RequestActionDialogProps) {
  const copy = modeCopy(mode);
  const [qty, setQty] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Reset every time the dialog (re)opens, so a previous typed value
  // does not bleed into the next action attempt.
  useEffect(() => {
    if (open) {
      setQty('');
      setNote('');
      setError(null);
    }
  }, [open, mode]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const trimmedNote = note.trim();

    // Required-note guard for reject / partial / return.
    if (copy.noteRequired && trimmedNote === '') {
      setError("Izoh / sababini kiriting — bu maydon majburiy.");
      return;
    }

    // Quantity guard for partial / return.
    let qtyValue: number | undefined;
    if (copy.showQtyInput) {
      const parsed = Number(qty.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("Miqdorni musbat raqam qilib kiriting.");
        return;
      }
      if (mode === 'accept_partial' && parsed >= request.qty_needed) {
        setError(
          `Qisman qabul uchun miqdor so'rovdan kichik bo'lishi kerak (so'rov: ${formatQty(request.qty_needed)} ${request.product_unit}).`,
        );
        return;
      }
      if (mode === 'return' && parsed > request.qty_needed) {
        setError(
          `Qaytariladigan miqdor so'rovdan oshib ketdi (so'rov: ${formatQty(request.qty_needed)} ${request.product_unit}).`,
        );
        return;
      }
      qtyValue = parsed;
    }

    const payload: RequestActionPayload = {
      mode,
      qty:
        mode === 'accept_full'
          ? request.qty_needed
          : qtyValue,
      note: trimmedNote === '' ? undefined : trimmedNote,
      reason: mode === 'reject' || mode === 'return' ? trimmedNote : undefined,
    };

    await onConfirm(payload);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <form
          id="request-action-form"
          className="space-y-4"
          onSubmit={handleSubmit}
        >
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">
              #{request.id} · {request.product_name}
            </p>
            <p className="text-xs text-muted-foreground">
              So'rovchi: {request.requester_location_name} ·{' '}
              Miqdor: {formatQty(request.qty_needed)} {request.product_unit}
            </p>
          </div>

          {copy.showQtyInput && (
            <div className="space-y-1">
              <Label htmlFor="action-qty">{copy.qtyLabel}</Label>
              <Input
                id="action-qty"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                placeholder={`Max: ${formatQty(request.qty_needed)}`}
                disabled={isSubmitting}
                required
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="action-note">{copy.noteLabel}</Label>
            <Textarea
              id="action-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={copy.notePlaceholder}
              maxLength={500}
              disabled={isSubmitting}
              required={copy.noteRequired}
            />
            <div
              className="text-right text-xs text-muted-foreground tabular-nums"
              aria-live="polite"
            >
              {note.length} / 500
            </div>
          </div>

          {error !== null && (
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
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Yopish
          </Button>
          <Button
            type="submit"
            form="request-action-form"
            variant={copy.destructive ? 'destructive' : 'default'}
            disabled={isSubmitting}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
