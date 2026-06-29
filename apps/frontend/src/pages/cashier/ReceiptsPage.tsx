import { useMemo, useState } from 'react';
import { AlertTriangle, ReceiptText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { cn } from '@/lib/utils';
import { formatQty, formatSom, formatDateTime } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { ReceiptsStockResponse, ReceiptWithStock } from '@/lib/types';

/**
 * EPIC 8.2 / 8.3 — kassa cheklari bo'yicha ostatka.
 *
 * Har chek bo'yicha: Ost (boshlang'ich) − sotildi − qoldi. Agar kassada
 * bazadagidan ko'p urilsa (ost 10 − sotildi 11 = −1) — "fors-major /
 * noto'g'ri urilgan" holat: chek qizil bilan belgilanadi va ogohlantiriladi
 * (8.3). Ostatka real bazada hech qachon manfiy bo'lmaydi (invariant 3) —
 * bu faqat hisobot signali.
 *
 * Backend: `GET /api/sales/receipts/stock` (P10 — chek-darajali ostatka)
 * hali yo'q. 404 bo'lsa "tayyorlanmoqda" empty-state ko'rsatiladi.
 * TODO(backend): EPIC 8.2 chek-darajali ost−sotildi−qoldi endpoint.
 */
export function ReceiptsPage() {
  const { data, isLoading, error, refetch } =
    useApiQuery<ReceiptsStockResponse>('/api/sales/receipts/stock');

  const [onlyForceMajeure, setOnlyForceMajeure] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);
  const notImplemented =
    error !== null && /404|topilmadi|mavjud emas/i.test(error);

  const forceMajeureCount = useMemo(
    () => items.filter((r) => r.has_force_majeure).length,
    [items],
  );

  const rows = useMemo<ReceiptWithStock[]>(
    () => (onlyForceMajeure ? items.filter((r) => r.has_force_majeure) : items),
    [items, onlyForceMajeure],
  );

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Kassa cheklari"
        description="Har chek bo‘yicha ostatka: ost − sotildi − qoldi. Manfiy qoldiq — noto‘g‘ri urilgan chek (fors-major)."
        dateTime
      />

      {/* Fors-major summary + toggle. */}
      {!isLoading && !error && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {forceMajeureCount > 0 ? (
            <button
              type="button"
              onClick={() => setOnlyForceMajeure((v) => !v)}
              aria-pressed={onlyForceMajeure}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                onlyForceMajeure
                  ? 'border-destructive bg-destructive/15 text-destructive'
                  : 'border-destructive/40 text-destructive hover:bg-destructive/10',
              )}
            >
              <AlertTriangle className="size-4" aria-hidden="true" />
              {forceMajeureCount} ta noto‘g‘ri urilgan chek
              {onlyForceMajeure ? ' — barchasini ko‘rsatish' : ''}
            </button>
          ) : (
            <Badge variant="secondary">Barcha cheklar to‘g‘ri urilgan</Badge>
          )}
        </div>
      )}

      {isLoading && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!isLoading && error && notImplemented && (
        <Card>
          <EmptyState message="Chek-darajali ostatka moduli tayyorlanmoqda — backend kontrakti hali ulanmagan." />
        </Card>
      )}

      {!isLoading && error && !notImplemented && (
        <Card>
          <ErrorState message={error} onRetry={refetch} />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <EmptyState message="Cheklar topilmadi." />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((r) => (
            <ReceiptCard key={`${r.poster_transaction_id}-${r.store_id}`} receipt={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReceiptCard({ receipt }: { receipt: ReceiptWithStock }) {
  return (
    <article
      className={cn(
        'space-y-3 rounded-lg border bg-card/50 p-4',
        receipt.has_force_majeure
          ? 'border-destructive/50 bg-destructive/5'
          : 'border-border/60',
      )}
      aria-label={`Chek #${receipt.poster_transaction_id}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
        <div className="flex items-start gap-2">
          <ReceiptText
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              Chek #{receipt.poster_transaction_id}
            </p>
            <p className="text-xs text-muted-foreground">
              {receipt.store_name} · {formatDateTime(receipt.sold_at)}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums">
            {formatSom(receipt.total_revenue)}
          </p>
          {receipt.has_force_majeure && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
              <AlertTriangle className="size-3" aria-hidden="true" />
              Fors-major
            </span>
          )}
        </div>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="pb-1 font-medium">Mahsulot</th>
            <th className="pb-1 text-right font-medium">Ost</th>
            <th className="pb-1 text-right font-medium">Sotildi</th>
            <th className="pb-1 text-right font-medium">Qoldi</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {receipt.lines.map((line) => {
            const over = line.remaining_qty < 0;
            const unit = UNIT_LABELS[line.product_unit];
            return (
              <tr key={line.product_id}>
                <td className="py-1.5 pr-2">
                  <span className="block truncate">{line.product_name}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatQty(line.opening_qty)} {unit}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatQty(line.sold_qty)} {unit}
                </td>
                <td
                  className={cn(
                    'py-1.5 text-right font-medium tabular-nums',
                    over && 'text-destructive',
                  )}
                >
                  {formatQty(line.remaining_qty)} {unit}
                  {over && (
                    <span className="sr-only"> — noto‘g‘ri urilgan</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}
