import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { planIds, type ApplyPlan } from './recipeAuditModel';

interface RecipeAuditApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: ApplyPlan;
  /** When the report the plan was computed from was generated. */
  generatedAt: string;
  isStale: boolean;
  onConfirm: (includeStageResets: boolean) => void;
  isSubmitting: boolean;
  error: string | null;
}

/**
 * Confirms a bulk "replace from Poster". Counts are split the way they will
 * be treated: replaced, lock-only, and recipes that would lose their
 * Hamir/Krem/Bezak split — those are left out unless explicitly ticked.
 */
export function RecipeAuditApplyDialog({
  open,
  onOpenChange,
  plan,
  generatedAt,
  isStale,
  onConfirm,
  isSubmitting,
  error,
}: RecipeAuditApplyDialogProps) {
  const [includeStageResets, setIncludeStageResets] = useState(false);
  const checkboxId = useId();

  // Every opening starts from the safe choice.
  useEffect(() => {
    if (open) setIncludeStageResets(false);
  }, [open]);

  const differs = plan.differs.length;
  const lockedMatch = plan.lockedMatch.length;
  const stageResets = plan.stageResets.length;
  const total = planIds(plan, includeStageResets).length;

  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retseptlarni Poster'dan yangilash</DialogTitle>
          <DialogDescription>
            Hisobot vaqti: {formatDateTime(generatedAt)}. Joriy retseptlar audit jurnaliga
            saqlanadi.
          </DialogDescription>
        </DialogHeader>

        {isStale && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Hisobot 10 daqiqadan eski — retseptlar o'zgargan bo'lishi mumkin. Avval qayta
            tekshirish tavsiya etiladi; o'zgarganlari baribir o'tkazib yuboriladi.
          </p>
        )}

        <ul className="list-disc space-y-1 pl-5 text-sm">
          {differs > 0 && (
            <li>
              {differs} ta farqli retsept Poster'dagi bilan almashtiriladi va qulflari ochiladi.
            </li>
          )}
          {lockedMatch > 0 && (
            <li>
              {lockedMatch} ta mos lekin qulflangan retseptning qulfi ochiladi (miqdorlari
              Poster bilan allaqachon mos).
            </li>
          )}
        </ul>

        {stageResets > 0 && (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <span>
                {stageResets} ta retseptda Hamir/Krem/Bezak bo'linishi yo'qoladi — bu tortlar
                uchun zagatovka jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi.
              </span>
            </p>
            <label htmlFor={checkboxId} className="flex items-center gap-2 font-medium">
              <input
                id={checkboxId}
                type="checkbox"
                className="size-4 accent-primary"
                checked={includeStageResets}
                onChange={(e) => setIncludeStageResets(e.target.checked)}
                disabled={isSubmitting}
              />
              Bosqichlari yo'qoladigan {stageResets} ta retseptni ham yangilash
            </label>
            <p className="text-muted-foreground">
              {includeStageResets
                ? `Bu ${stageResets} ta retsept ham Poster'dagi bilan almashtiriladi va qulfi ochiladi — bosqichlarni keyin qayta belgilash kerak bo'ladi.`
                : `Belgilanmagan: bu ${stageResets} ta retsept o'tkazib yuboriladi va qulfi qoladi.`}
            </p>
          </div>
        )}

        <p className="text-sm font-medium">
          {total > 0
            ? `Jami yangilanadi: ${total} ta retsept. Davom etasizmi?`
            : "Yangilanadigan retsept qolmadi."}
        </p>

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
            Bekor qilish
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(includeStageResets)}
            disabled={isSubmitting || total === 0}
          >
            {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Ha, yangilash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
