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

interface RecipeAuditRestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Recipes the last bulk apply changed, when the apply report is known. */
  appliedCount: number | null;
  onConfirm: () => void;
  isSubmitting: boolean;
  error: string | null;
}

/** Confirms undoing the last bulk apply from its snapshot. */
export function RecipeAuditRestoreDialog({
  open,
  onOpenChange,
  appliedCount,
  onConfirm,
  isSubmitting,
  error,
}: RecipeAuditRestoreDialogProps) {
  const what =
    appliedCount === null
      ? 'Oxirgi ommaviy yangilashda o\'zgargan retseptlar'
      : `Oxirgi ommaviy yangilashda o'zgargan ${appliedCount} ta retsept`;
  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Oxirgi ommaviy yangilashni bekor qilish</DialogTitle>
          <DialogDescription>
            {what} va ularning qulflari o'sha yangilashdan oldingi holatiga qaytariladi
            (yangilashdan oldin audit jurnaliga saqlangan nusxadan).
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            O'sha yangilashdan oldin qulfsiz bo'lgan retseptlar qulfsiz qaytadi — soatlik Poster
            sinxronlash ularni yana yangilashi mumkin.
          </li>
          <li>Qulflangan bo'lgan retseptlar qulflangan holda qaytadi.</li>
        </ul>
        <p className="text-sm font-medium">Davom etasizmi?</p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Yo'q
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Ha, bekor qilish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
