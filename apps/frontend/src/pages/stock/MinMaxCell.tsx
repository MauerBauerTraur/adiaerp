import { useState } from 'react';
import {
  Check,
  Pencil,
  X,
  Loader2,
  RefreshCw,
  Hand,
  ChevronDown,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty, formatDateTime } from '@/lib/format';
import type { StockRow } from '@/lib/types';

/**
 * Extra fields the backend may add once F2.1 ships (`last_recalc_at`).
 * Treated as optional so the cell renders correctly on a Faza-1 backend
 * that hasn't yet been upgraded — the badge tooltip just omits the line.
 */
interface StockRowWithRecalc extends StockRow {
  last_recalc_at?: string | null;
}

interface MinMaxCellProps {
  row: StockRow;
  /** True if the current role may edit min/max for this row (§6). */
  canEdit: boolean;
  /** Called after a successful save to refresh the table. */
  onSaved: () => void;
}

/**
 * Inline min/max editor for one stock row — `PATCH /api/stock/minmax`
 * for the values and `PATCH /api/stock/minmax-mode` for the manual ↔
 * dynamic toggle (Faza-2 F2.1, ADR-0007).
 *
 * Display layout:
 *   `min / max  [✋ Manual | 🔄 Dynamic]  ✏`
 *
 * In `dynamic` mode inline editing of the numbers is disabled — the
 * nightly recalc owns those values. The user can switch back to
 * `manual` first (confirmation dialog) and then edit.
 */
export function MinMaxCell({ row, canEdit, onSaved }: MinMaxCellProps) {
  const { notify } = useToast();
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(row.min_level));
  const [max, setMax] = useState(String(row.max_level));
  const [isSaving, setIsSaving] = useState(false);

  // Mode toggle (Faza-2 F2.1). The confirm dialog opens when the user
  // clicks the badge — the actual PATCH only fires after confirmation.
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [isTogglingMode, setIsTogglingMode] = useState(false);

  const isDynamic = row.minmax_mode === 'dynamic';
  const lastRecalcAt = (row as StockRowWithRecalc).last_recalc_at ?? null;

  function startEdit() {
    if (isDynamic) {
      // Dynamic mode locks the numeric editor — the helper text and the
      // disabled pencil already convey this, but a defensive guard keeps
      // any future call sites honest.
      return;
    }
    setMin(String(row.min_level));
    setMax(String(row.max_level));
    setEditing(true);
  }

  async function save() {
    const minNum = Number(min);
    const maxNum = Number(max);
    if (
      !Number.isFinite(minNum) ||
      !Number.isFinite(maxNum) ||
      minNum < 0 ||
      maxNum < 0
    ) {
      notify('error', 'Min/max manfiy bo‘lmasligi kerak.');
      return;
    }
    if (minNum > maxNum) {
      notify('error', 'Min qiymat max dan katta bo‘lmasligi kerak.');
      return;
    }

    setIsSaving(true);
    try {
      await apiRequest('/api/stock/minmax', {
        method: 'PATCH',
        body: {
          location_id: row.location_id,
          product_id: row.product_id,
          min_level: minNum,
          max_level: maxNum,
        },
      });
      notify('success', 'Min/max yangilandi.');
      setEditing(false);
      onSaved();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleMode() {
    const next: 'manual' | 'dynamic' = isDynamic ? 'manual' : 'dynamic';
    setIsTogglingMode(true);
    try {
      await apiRequest('/api/stock/minmax-mode', {
        method: 'PATCH',
        body: {
          location_id: row.location_id,
          product_id: row.product_id,
          mode: next,
        },
      });
      notify(
        'success',
        next === 'dynamic'
          ? 'Dynamic rejim yoqildi. Keyingi tungi cron qayta hisoblaydi.'
          : 'Manual rejimga o‘tildi.',
      );
      setModeDialogOpen(false);
      onSaved();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Rejimni o‘zgartirib bo‘lmadi.',
      );
    } finally {
      setIsTogglingMode(false);
    }
  }

  const modeBadgeTooltip = isDynamic
    ? `Tungi cron sales tarixiga qarab qayta hisoblaydi.${
        lastRecalcAt ? `\nOxirgi qayta hisob: ${formatDateTime(lastRecalcAt)}` : ''
      }`
    : 'PM yoki bo‘g‘in boshlig‘i qo‘lda kiritadi.';

  const modeBadge = (
    <Badge
      variant={isDynamic ? 'info' : 'outline'}
      className="gap-1 px-1.5 py-0.5 text-[11px]"
      title={modeBadgeTooltip}
      aria-label={
        isDynamic
          ? 'Min/max rejimi: dinamik'
          : 'Min/max rejimi: qo‘lda'
      }
    >
      {isDynamic ? (
        <RefreshCw className="size-3" aria-hidden="true" />
      ) : (
        <Hand className="size-3" aria-hidden="true" />
      )}
      {isDynamic ? 'Dynamic' : 'Manual'}
    </Badge>
  );

  if (!editing) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">
            {formatQty(row.min_level)} / {formatQty(row.max_level)}
          </span>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setModeDialogOpen(true)}
              className="inline-flex items-center gap-0.5 rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label={
                isDynamic
                  ? 'Rejimni manual ga almashtirish'
                  : 'Rejimni dynamic ga almashtirish'
              }
            >
              {modeBadge}
              <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : (
            modeBadge
          )}
          {canEdit && !isDynamic && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={startEdit}
              aria-label="Min/max ni tahrirlash"
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
        </div>
        {isDynamic && canEdit && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Dynamic rejimda qiymatlar avtomatik.{' '}
            <button
              type="button"
              onClick={() => setModeDialogOpen(true)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Manual ga o‘ting
            </button>{' '}
            tahrirlash uchun.
          </p>
        )}

        <Dialog open={modeDialogOpen} onOpenChange={setModeDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {isDynamic
                  ? 'Manual rejimga o‘tkazasizmi?'
                  : 'Dynamic rejimga o‘tkazasizmi?'}
              </DialogTitle>
              <DialogDescription>
                {isDynamic
                  ? 'Joriy min/max qiymatlari saqlanadi. Tungi cron ushbu qatorga endi tegmaydi — qiymatlar qo‘lda boshqariladi.'
                  : 'Keyingi tungi cron sales tarixiga qarab min/max ni qayta hisoblaydi. Qo‘lda kiritilgan qiymatlar o‘zgarishi mumkin.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setModeDialogOpen(false)}
                disabled={isTogglingMode}
              >
                Bekor qilish
              </Button>
              <Button onClick={toggleMode} disabled={isTogglingMode}>
                {isTogglingMode && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                {isDynamic ? 'Manual ga o‘tkazish' : 'Dynamic ga o‘tkazish'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 w-20"
        type="number"
        min={0}
        step="any"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        aria-label="Minimal daraja"
      />
      <span className="text-muted-foreground">/</span>
      <Input
        className="h-8 w-20"
        type="number"
        min={0}
        step="any"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        aria-label="Maksimal daraja"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={save}
        disabled={isSaving}
        aria-label="Saqlash"
      >
        {isSaving ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => setEditing(false)}
        disabled={isSaving}
        aria-label="Bekor qilish"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
