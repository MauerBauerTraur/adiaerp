import { useMemo, useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { cn } from '@/lib/utils';

type RangePreset = 'today' | 'week' | 'month';

const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Bugun',
  week: 'Bu hafta',
  month: 'Bu oy',
};

type SalesItem = {
  id: number;
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  price: number;
  sold_at: string;
  poster_transaction_id: number;
};

function getRangeDates(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toIso = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = toIso(now);

  if (preset === 'today') {
    return { from: today, to: today };
  }
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return { from: toIso(mon), to: today };
  }
  // month
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: toIso(first), to: today };
}

function formatMoney(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} mlrd`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} mln`;
  return value.toLocaleString('uz-UZ');
}

export function SalesChart({
  className,
}: {
  /** @deprecated kept for backwards compat — not used */
  points?: unknown;
  rangePreset?: string;
  className?: string;
}) {
  const [range, setRange] = useState<RangePreset>('today');
  const { from, to } = getRangeDates(range);

  const { data, isLoading } = useApiQuery<{ items: SalesItem[]; total: number }>(
    `/api/sales?from=${from}&to=${to}&limit=200`,
  );

  const items = data?.items ?? [];

  const totals = useMemo(() => {
    const revenue = items.reduce((s, r) => s + r.qty * r.price, 0);
    const qty = items.reduce((s, r) => s + r.qty, 0);
    const receipts = new Set(items.map((r) => r.poster_transaction_id)).size;
    return { revenue, qty, receipts };
  }, [items]);

  const rangeLabel = RANGE_LABELS[range];

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShoppingCart className="size-4 text-primary" aria-hidden="true" />
            {rangeLabel} savdolari
          </h2>
          <p className="text-xs text-muted-foreground">Posterdan sinxronlangan ma&apos;lumotlar</p>
        </div>
        <div className="flex overflow-hidden rounded-lg border border-border text-xs font-medium">
          {(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                range === r
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </header>

      {/* Summary row */}
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border/60">
        <div className="flex flex-col items-center gap-0.5 px-4 py-3 text-center">
          <span className="text-xs text-muted-foreground">Tushum</span>
          <span className="text-base font-semibold tabular-nums leading-none text-primary">
            {formatMoney(totals.revenue)}
          </span>
          <span className="text-[10px] text-muted-foreground">so&apos;m</span>
        </div>
        <div className="flex flex-col items-center gap-0.5 px-4 py-3 text-center">
          <span className="text-xs text-muted-foreground">Cheklar</span>
          <span className="text-base font-semibold tabular-nums leading-none">
            {totals.receipts}
          </span>
        </div>
        <div className="flex flex-col items-center gap-0.5 px-4 py-3 text-center">
          <span className="text-xs text-muted-foreground">Miqdor</span>
          <span className="text-base font-semibold tabular-nums leading-none">
            {totals.qty.toLocaleString('uz-UZ')}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-auto">
        {isLoading && items.length === 0 ? (
          <div className="p-5">
            <LoadingState />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState message="Sotuv ma'lumotlari yo'q." />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Mahsulot nomi</th>
                <th className="px-4 py-2.5 font-medium text-right">Soni</th>
                <th className="px-4 py-2.5 font-medium text-right">Narxi</th>
                <th className="px-4 py-2.5 font-medium text-right">Summa</th>
                <th className="px-4 py-2.5 font-medium">Do&apos;kon / Ombor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-foreground">{item.product_name}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{item.product_unit}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {item.qty.toLocaleString('uz-UZ')}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {item.price.toLocaleString('uz-UZ')}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                    {(item.qty * item.price).toLocaleString('uz-UZ')}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{item.store_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data !== null && data.total > 200 && (
          <p className="border-t border-border/40 px-4 py-2 text-center text-xs text-muted-foreground">
            Jami {data.total} ta yozuv — faqat birinchi 200 ta ko&apos;rsatilmoqda
          </p>
        )}
      </div>
    </Card>
  );
}
