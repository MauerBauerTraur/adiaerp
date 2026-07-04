import { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, LoadingState, ErrorState, PageHeader } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatSom } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';

type ProfitRow = {
  product_id: number;
  product_name: string;
  product_unit: string;
  total_qty: number;
  cost_price: number | null;
  sell_price: number | null;
  foyda_per_unit: number | null;
  total_foyda: number | null;
};

type RangePreset = 'today' | 'week' | 'month';

const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Bugun' },
  { value: 'week', label: 'Bu hafta' },
  { value: 'month', label: 'Bu oy' },
];

function getRangeDates(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (preset === 'today') {
    const today = fmt(now);
    return { from: today, to: today };
  }
  if (preset === 'week') {
    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // Monday-based
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return { from: fmt(mon), to: fmt(now) };
  }
  // month
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: fmt(firstDay), to: fmt(now) };
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${accent ?? ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </Card>
  );
}

export function ProfitReportPage() {
  const [preset, setPreset] = useState<RangePreset>('month');
  const { from, to } = getRangeDates(preset);

  const { data, isLoading, error } = useApiQuery<{ items: ProfitRow[]; from: string; to: string }>(
    `/api/reports/profit?from=${from}&to=${to}`,
  );

  const items = data?.items ?? [];

  const totals = useMemo(() => {
    let totalQty = 0;
    let totalFoyda = 0;
    let withFoyda = 0;
    for (const row of items) {
      totalQty += row.total_qty;
      if (row.total_foyda != null) {
        totalFoyda += row.total_foyda;
        withFoyda++;
      }
    }
    return { totalQty, totalFoyda, withFoyda, total: items.length };
  }, [items]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Foyda hisoboti"
        description="Ishlab chiqarilgan mahsulotlar bo'yicha tan narxi, sotuv narxi va foyda"
      />

      {/* Range selector */}
      <div className="flex gap-2">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setPreset(opt.value)}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              preset === opt.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="ml-auto flex items-center text-xs text-muted-foreground">
          {from} — {to}
        </span>
      </div>

      {/* Summary cards */}
      {!isLoading && !error && items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <SummaryCard
            label="Jami ishlab chiqarildi"
            value={`${totals.totalQty.toLocaleString('uz-UZ')} dona`}
            sub={`${totals.total} turdagi mahsulot`}
          />
          <SummaryCard
            label="Jami foyda"
            value={formatSom(totals.totalFoyda)}
            sub={`${totals.withFoyda}/${totals.total} mahsulotda narx belgilangan`}
            accent={totals.totalFoyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
          />
          <SummaryCard
            label="O'rtacha foyda/dona"
            value={totals.totalQty > 0 ? formatSom(totals.totalFoyda / totals.totalQty) : '—'}
          />
        </div>
      )}

      {/* Table */}
      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} />}
        {!isLoading && !error && items.length === 0 && (
          <EmptyState message="Bu davr uchun ishlab chiqarish ma'lumotlari topilmadi." />
        )}
        {!isLoading && !error && items.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  <TableHead className="text-right">Miqdor</TableHead>
                  <TableHead className="text-right">Tan narxi</TableHead>
                  <TableHead className="text-right">Sotuv narxi</TableHead>
                  <TableHead className="text-right">Foyda/dona</TableHead>
                  <TableHead className="text-right">Jami foyda</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => {
                  const unitLabel = UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ?? row.product_unit;
                  const hasFoyda = row.foyda_per_unit != null;
                  const foydaPositive = hasFoyda && row.foyda_per_unit! > 0;
                  const foydaNegative = hasFoyda && row.foyda_per_unit! < 0;

                  return (
                    <TableRow key={row.product_id}>
                      <TableCell className="font-medium">{row.product_name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.total_qty.toLocaleString('uz-UZ')} {unitLabel}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {row.cost_price != null
                          ? `${row.cost_price.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {row.sell_price != null
                          ? `${row.sell_price.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {hasFoyda ? (
                          <span className={`inline-flex items-center gap-1 font-medium ${foydaPositive ? 'text-emerald-600 dark:text-emerald-400' : foydaNegative ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>
                            {foydaPositive ? <TrendingUp className="size-3" /> : foydaNegative ? <TrendingDown className="size-3" /> : <Minus className="size-3" />}
                            {row.foyda_per_unit!.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {row.total_foyda != null ? (
                          <span className={row.total_foyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                            {formatSom(row.total_foyda)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        * Tan narxi — Posterdan olingan xarid narxi (cost_price). Aniqroq hisob uchun mahsulot retseptiga narxlar kiritilsin.
      </p>
    </div>
  );
}
