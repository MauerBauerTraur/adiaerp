import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ShoppingCart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { cn } from '@/lib/utils';
import type { Location } from '@/lib/types';

type RangePreset = 'today' | 'week' | 'month';

const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Bugun',
  week: 'Bu hafta',
  month: 'Bu oy',
};

const PRODUCT_TYPE_OPTIONS = [
  { value: '', label: "Barcha kategoriyalar" },
  { value: 'finished', label: 'Tayyor mahsulot' },
  { value: 'gp', label: 'Готовая продукция' },
  { value: 'semi', label: 'Yarim tayyor' },
  { value: 'raw', label: 'Xom-ashyo' },
] as const;

type SalesItem = {
  id: number;
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  price: number;
  cost_price: number | null;
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
  const PAGE_SIZE = 50;
  const [range, setRange] = useState<RangePreset>('today');
  const [page, setPage] = useState(0);
  const [storeId, setStoreId] = useState<string>('');
  const [productType, setProductType] = useState<string>('');

  const { from, to } = getRangeDates(range);

  // Reset page when any filter changes
  useEffect(() => { setPage(0); }, [range, storeId, productType]);

  // Build query string
  const queryParams = useMemo(() => {
    const p = new URLSearchParams({
      from,
      to,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (storeId) p.set('location_id', storeId);
    if (productType) p.set('product_type', productType);
    return p.toString();
  }, [from, to, page, storeId, productType]);

  const { data, isLoading } = useApiQuery<{ items: SalesItem[]; total: number }>(
    `/api/sales?${queryParams}`,
  );

  // Fetch stores list for the dropdown
  const { data: locationsData } = useApiQuery<Location[]>('/api/locations?type=store');
  const stores = locationsData ?? [];

  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const totals = useMemo(() => {
    let revenue = 0, qty = 0, foyda = 0, foydaCount = 0;
    const receiptSet = new Set<number>();
    for (const r of items) {
      revenue += r.qty * r.price;
      qty += r.qty;
      receiptSet.add(r.poster_transaction_id);
      if (r.cost_price != null) { foyda += (r.price - r.cost_price) * r.qty; foydaCount++; }
    }
    return { revenue, qty, receipts: receiptSet.size, foyda, foydaCount };
  }, [items]);

  const rangeLabel = RANGE_LABELS[range];

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShoppingCart className="size-4 text-primary" aria-hidden="true" />
            {rangeLabel} savdolari
          </h2>
          <p className="text-xs text-muted-foreground">Posterdan sinxronlangan ma&apos;lumotlar</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Store filter */}
          {stores.length > 0 && (
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Barcha do&apos;konlar</option>
              {stores.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          )}

          {/* Department (product type) filter */}
          <select
            value={productType}
            onChange={(e) => setProductType(e.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {PRODUCT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* Range buttons */}
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
        </div>
      </header>

      {/* Summary row */}
      <div className="grid grid-cols-4 divide-x divide-border border-b border-border/60">
        <div className="flex flex-col items-center gap-0.5 px-4 py-3 text-center">
          <span className="text-xs text-muted-foreground">Tushum</span>
          <span className="text-base font-semibold tabular-nums leading-none text-primary">
            {formatMoney(totals.revenue)}
          </span>
          <span className="text-[10px] text-muted-foreground">so&apos;m</span>
        </div>
        <div className="flex flex-col items-center gap-0.5 px-4 py-3 text-center">
          <span className="text-xs text-muted-foreground">Foyda</span>
          <span className={`text-base font-semibold tabular-nums leading-none ${totals.foydaCount > 0 ? (totals.foyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400') : 'text-muted-foreground'}`}>
            {totals.foydaCount > 0 ? formatMoney(totals.foyda) : '—'}
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
                <th className="px-4 py-2.5 font-medium text-right">Tan narxi</th>
                <th className="px-4 py-2.5 font-medium text-right">Foyda</th>
                <th className="px-4 py-2.5 font-medium">Do&apos;kon / Ombor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {items.map((item) => {
                const foyda = item.cost_price != null ? (item.price - item.cost_price) * item.qty : null;
                return (
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
                  <td className="px-4 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {item.cost_price != null ? item.cost_price.toLocaleString('uz-UZ') : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                    {foyda != null ? (
                      <span className={foyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                        {foyda.toLocaleString('uz-UZ')}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{item.store_name}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between border-t border-border/40 px-4 py-2">
            <span className="text-xs text-muted-foreground">
              Jami {data.total} ta yozuv — {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} ko&apos;rsatilmoqda
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="min-w-[3rem] text-center text-xs font-medium tabular-nums">
                  {page + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
