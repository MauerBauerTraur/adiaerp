import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import { Textarea } from '@/components/ui/textarea';

interface CancelDialogProps {
  /** Controls whether the dialog is visible. */
  open: boolean;
  /** Called when the dialog requests open/close — wires up the Escape key,
   * overlay click, and the close button. */
  onOpenChange: (open: boolean) => void;
  /**
   * Invoked when the user confirms the cancellation. The reason is the
   * trimmed textarea value or `undefined` when left blank (the backend
   * accepts an optional `reason` on `POST /api/replenishment/:id/cancel`).
   * The function may be async — the dialog disables its actions while it
   * is pending and closes itself only after a successful resolve.
   */
  onConfirm: (reason: string | undefined) => Promise<void> | void;
  /** Indicates that the parent is performing the cancel request — disables
   * both action buttons and shows the spinner on the destructive button. */
  isSubmitting?: boolean;
}

const REASON_MAX_LENGTH = 500;

/**
 * Confirmation dialog for cancelling a replenishment_request. Replaces the
 * Faza-1 `window.prompt` so the cancel flow lives inside the dark-premium
 * design system, supports the keyboard (Escape + focus-trap via Radix),
 * and gives screen readers a labelled form region.
 *
 * The destructive action uses the shared `destructive` button variant —
 * the cobalt palette maps that token to a red surface so the user is
 * reminded that a successful cancel is terminal (state machine moves to
 * `CANCELLED`, the request can no longer be advanced).
 */
export function CancelDialog({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting = false,
}: CancelDialogProps) {
  const [reason, setReason] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset the textarea every time the dialog re-opens — a previously typed
  // reason should not bleed into the next cancellation attempt.
  useEffect(() => {
    if (open) {
      setReason('');
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = reason.trim();
    await onConfirm(trimmed === '' ? undefined : trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Radix focuses the first tabbable element by default — that
          // would land on the close (X) icon. Pull focus onto the
          // textarea so a keyboard user lands directly on the input.
          event.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <DialogHeader>
          {/* Radix wires `aria-labelledby` / `aria-describedby` on the
              dialog automatically when `DialogTitle` / `DialogDescription`
              are rendered, so we don't override the ids manually. */}
          <DialogTitle>So‘rovni bekor qilish</DialogTitle>
          <DialogDescription>
            Bekor qilish tasdiqlangach, so‘rov terminal holatga o‘tadi va
            keyingi qadamga o‘tkazib bo‘lmaydi.
          </DialogDescription>
        </DialogHeader>

        <form
          id="cancel-replenishment-form"
          className="space-y-2"
          onSubmit={handleSubmit}
        >
          <Label htmlFor="cancel-reason">Bekor qilish sababi (ixtiyoriy)</Label>
          <Textarea
            id="cancel-reason"
            name="reason"
            ref={textareaRef}
            value={reason}
            maxLength={REASON_MAX_LENGTH}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Masalan: ortiqcha so‘rov, mahsulot keldi"
            disabled={isSubmitting}
          />
          <div
            className="text-right text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {reason.length} / {REASON_MAX_LENGTH}
          </div>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Rad et
          </Button>
          <Button
            type="submit"
            form="cancel-replenishment-form"
            variant="destructive"
            disabled={isSubmitting}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Bekor qilish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
