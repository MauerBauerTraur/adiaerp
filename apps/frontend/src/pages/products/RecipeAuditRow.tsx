import { AlertTriangle, ChevronDown, ChevronRight, Lock, LockOpen } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { PRODUCT_TYPE_LABELS, RECIPE_STAGE_LABELS, UNIT_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type {
  ProductType,
  RecipeAuditItem,
  RecipeAuditLine,
  RecipeAuditStatus,
  RecipeStage,
  Unit,
} from '@/lib/types';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

const STATUS_META: Record<RecipeAuditStatus, { label: string; variant: BadgeVariant }> = {
  match: { label: 'Mos', variant: 'success' },
  differs: { label: 'Farqli', variant: 'warning' },
  poster_missing: { label: "Poster'da yo'q", variant: 'outline' },
  poster_error: { label: 'Poster xatosi', variant: 'danger' },
  unresolved: { label: 'Topilmagan komponent', variant: 'danger' },
};

const APPLY_META: Record<NonNullable<RecipeAuditItem['apply_result']>, { label: string; variant: BadgeVariant }> = {
  applied: { label: 'Yangilandi', variant: 'success' },
  skipped: { label: "O'tkazib yuborildi", variant: 'warning' },
  failed: { label: 'Xato', variant: 'danger' },
  restored: { label: 'Tiklandi', variant: 'info' },
};

/** Row tint + text tag per diff kind; the tag keeps it readable without colour. */
const DIFF_META: Record<RecipeAuditLine['diff'], { row: string; tag: string | null; variant: BadgeVariant }> = {
  same: { row: '', tag: null, variant: 'outline' },
  changed: { row: 'bg-amber-50 dark:bg-amber-900/20', tag: "o'zgargan", variant: 'warning' },
  erp_only: { row: 'bg-red-50 dark:bg-red-900/20', tag: "faqat ERP'da", variant: 'danger' },
  poster_only: { row: 'bg-sky-50 dark:bg-sky-900/20', tag: "faqat Poster'da", variant: 'info' },
};

const qtyFormat = new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 6 });
const diffFormat = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 6,
  signDisplay: 'exceptZero',
});

/** The ERP stage of a line (Hamir/Krem/Bezak); Poster has no stages. */
function stageLabel(stage: string | null): string {
  if (stage === null) return '—';
  return RECIPE_STAGE_LABELS[stage as RecipeStage] ?? stage;
}

function formatQty(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : qtyFormat.format(value);
}

/** Poster minus ERP, only where both sides have the component and they differ. */
function formatDiff(line: RecipeAuditLine): string {
  if (line.diff !== 'changed' || line.erp_qty === null || line.poster_qty === null) return '—';
  // Round away float noise (0.2 - 0.25 = -0.04999999…).
  return diffFormat.format(Math.round((line.poster_qty - line.erp_qty) * 1e6) / 1e6);
}

interface RecipeAuditRowProps {
  item: RecipeAuditItem;
  expanded: boolean;
  onToggle: () => void;
  /** Render the selection column at all (pm only). */
  showSelect: boolean;
  /** Whether this row can be applied from Poster. */
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  /** Render the apply-result column (the report followed a bulk apply). */
  showApplyResult: boolean;
  columnCount: number;
}

export function RecipeAuditRow({
  item,
  expanded,
  onToggle,
  showSelect,
  selectable,
  selected,
  onSelectedChange,
  showApplyResult,
  columnCount,
}: RecipeAuditRowProps) {
  const status = STATUS_META[item.status];
  const erpCount = item.lines.filter((l) => l.erp_qty !== null).length;
  const posterCount = item.lines.filter((l) => l.poster_qty !== null).length;
  const diffCount = item.lines.filter((l) => l.diff !== 'same').length;
  const detailId = `recipe-audit-detail-${item.product_id}`;
  const needsAttention = item.apply_result === 'skipped' || item.apply_result === 'failed';

  return (
    <>
      <TableRow className={cn(needsAttention && 'bg-warning/5')}>
        {showSelect && (
          <TableCell className="w-10">
            {selectable && (
              <input
                type="checkbox"
                className="size-4 cursor-pointer rounded accent-primary"
                checked={selected}
                onChange={(e) => onSelectedChange(e.target.checked)}
                aria-label={`${item.product_name} ni tanlash`}
              />
            )}
          </TableCell>
        )}
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            className="flex items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0">
              <span className="font-medium" data-testid="audit-row-name">
                {item.product_name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {PRODUCT_TYPE_LABELS[item.product_type as ProductType] ?? item.product_type}
                {item.poster_name !== null &&
                  item.poster_name !== item.product_name &&
                  ` · Poster: ${item.poster_name}`}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            <Badge variant={status.variant}>{status.label}</Badge>
            {item.stages_will_reset === true && (
              <Badge
                variant="warning"
                title="Poster'dan yangilansa Hamir/Krem/Bezak bo'linishi yo'qoladi. Soatlik sinxron bu retseptni o'zgartirmaydi — shu yerda tasdiqlang."
              >
                Bosqichlar yo'qoladi
              </Badge>
            )}
          </div>
          {/* A per-product Poster error lands in `warnings` (status
              poster_missing), so flag them on the row, not only when expanded. */}
          {item.warnings.length > 0 && (
            <span className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              {item.warnings.length} ta ogohlantirish
            </span>
          )}
        </TableCell>
        <TableCell>
          {item.recipe_locked ? (
            <span className="inline-flex text-violet-600 dark:text-violet-400" title="Qulflangan">
              <Lock className="size-4" aria-hidden="true" />
              <span className="sr-only">Qulflangan</span>
            </span>
          ) : (
            <span className="inline-flex text-muted-foreground/60" title="Qulfsiz">
              <LockOpen className="size-4" aria-hidden="true" />
              <span className="sr-only">Qulfsiz</span>
            </span>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm tabular-nums">
          ERP {erpCount} · Poster {posterCount}
          {diffCount > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">({diffCount} ta farq)</span>
          )}
        </TableCell>
        {showApplyResult && (
          <TableCell className="max-w-sm text-sm">
            {item.apply_result ? (
              <div className="space-y-1">
                <Badge variant={APPLY_META[item.apply_result].variant}>
                  {APPLY_META[item.apply_result].label}
                </Badge>
                {item.apply_message && (
                  <p className="text-xs text-muted-foreground">{item.apply_message}</p>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </TableCell>
        )}
      </TableRow>
      {expanded && (
        <TableRow id={detailId} className="hover:bg-transparent">
          <TableCell colSpan={columnCount} className="bg-muted/20 p-4">
            <LineDiff item={item} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function LineDiff({ item }: { item: RecipeAuditItem }) {
  const unit = UNIT_LABELS[item.product_unit as Unit] ?? item.product_unit;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        1 {unit} mahsulot uchun, brutto
        {item.source !== null &&
          ` · Poster manbasi: ${item.source === 'prepack' ? 'yarim tayyor (prepack)' : 'menyu'}`}
      </p>
      {item.stages_will_reset === true && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          Poster'dan yangilansa bu retseptning Hamir/Krem/Bezak bo'linishi yo'qoladi — zagatovka
          jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi. Soatlik Poster sinxronlash bu
          retseptni o'zgartirmaydi — Poster'dagi tarkibni qabul qilish uchun shu yerda tasdiqlang.
        </p>
      )}
      {item.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">Komponentlar yo'q.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">
              {item.product_name} — ERP va Poster retsepti farqi
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Komponent</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Bosqich</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">ERP miqdor</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Poster miqdor</th>
                <th scope="col" className="py-1.5 text-right font-medium">Farq</th>
              </tr>
            </thead>
            <tbody>
              {item.lines.map((line, i) => {
                const meta = DIFF_META[line.diff];
                return (
                  <tr
                    key={`${line.component_product_id ?? 'x'}-${i}`}
                    data-diff={line.diff}
                    className={cn('border-b border-border/40 last:border-0', meta.row)}
                  >
                    <td className="py-1.5 pl-1 pr-3">
                      <span>{line.component_name}</span>
                      {meta.tag && (
                        <Badge variant={meta.variant} className="ml-2 align-middle">
                          {meta.tag}
                        </Badge>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{stageLabel(line.stage)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatQty(line.erp_qty)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatQty(line.poster_qty)}</td>
                    <td className="py-1.5 pr-1 text-right font-medium tabular-nums">{formatDiff(line)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {item.not_found.length > 0 && (
        <p className="text-sm text-destructive">
          ERP'da topilmagan komponentlar: {item.not_found.join(', ')}
        </p>
      )}
      {item.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
          {item.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
