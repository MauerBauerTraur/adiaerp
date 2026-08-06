import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { FilterSheet, FilterField, FilterTrigger } from '@/components/ui/filter-sheet';
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
  production_cost: number | null;
  sell_price: number | null;
  foyda_per_unit: number | null;
  total_foyda: number | null;
  sof_foyda_per_unit: number | null;
  total_sof_foyda: number | null;
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
    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return { from: fmt(mon), to: fmt(now) };
  }
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

function FoydaCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const pos = value > 0;
  const neg = value < 0;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${pos ? 'text-emerald-600 dark:text-emerald-400' : neg ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>
      {pos ? <TrendingUp className="size-3" /> : neg ? <TrendingDown className="size-3" /> : <Minus className="size-3" />}
      {value.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm
    </span>
  );
}

const PAGE_SIZE = 50;

export function ProfitReportPage() {
  const [preset, setPreset] = useState<RangePreset>('month');
  const [page, setPage] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftPreset, setDraftPreset] = useState<RangePreset>('month');
  const { from, to } = getRangeDates(preset);

  useEffect(() => { setPage(0); }, [preset]);

  const activeCount = preset !== 'month' ? 1 : 0;

  function openFilter() { setDraftPreset(preset); setFilterOpen(true); }
  function applyFilter() { setPreset(draftPreset); setFilterOpen(false); }
  function clearFilter() { setDraftPreset('month'); setPreset('month'); setFilterOpen(false); }

  const { data, isLoading, error } = useApiQuery<{ items: ProfitRow[]; from: string; to: string }>(
    `/api/reports/profit?from=${from}&to=${to}`,
  );

  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const totals = useMemo(() => {
    let totalQty = 0;
    let totalFoyda = 0;
    let totalSofFoyda = 0;
    let withFoyda = 0;
    let withSofFoyda = 0;
    for (const row of items) {
      totalQty += row.total_qty;
      if (row.total_foyda != null) { totalFoyda += row.total_foyda; withFoyda++; }
      if (row.total_sof_foyda != null) { totalSofFoyda += row.total_sof_foyda; withSofFoyda++; }
    }
    return { totalQty, totalFoyda, totalSofFoyda, withFoyda, withSofFoyda, total: items.length };
  }, [items]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Foyda hisoboti"
        description="Ishlab chiqarilgan mahsulotlar bo'yicha tan narxi, sotuv narxi va foyda"
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="text-xs text-muted-foreground">{from} — {to}</span>
        <div className="ml-auto">
          <FilterTrigger onClick={openFilter} activeCount={activeCount} />
        </div>
      </div>

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={applyFilter}
        onClear={clearFilter}
        activeCount={activeCount}
      >
        <FilterField label="Sana oraligi">
          <div className="flex flex-col gap-2">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDraftPreset(opt.value)}
                className={`w-full rounded-lg border px-3 py-2 text-sm font-medium text-left transition-colors ${
                  draftPreset === opt.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </FilterField>
      </FilterSheet>

      {/* Summary cards */}
      {!isLoading && !error && items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-4">
          <SummaryCard
            label="Jami ishlab chiqarildi"
            value={`${totals.totalQty.toLocaleString('uz-UZ')} dona`}
            sub={`${totals.total} turdagi mahsulot`}
          />
          <SummaryCard
            label="Jami foyda (sotuv − xarid)"
            value={formatSom(totals.totalFoyda)}
            sub={`${totals.withFoyda}/${totals.total} mahsulotda belgilangan`}
            accent={totals.totalFoyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
          />
          <SummaryCard
            label="Sof foyda (sotuv − ish. narxi)"
            value={formatSom(totals.totalSofFoyda)}
            sub={`${totals.withSofFoyda}/${totals.total} mahsulotda belgilangan`}
            accent={totals.totalSofFoyda >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
          />
          <SummaryCard
            label="O'rtacha sof foyda/dona"
            value={totals.totalQty > 0 ? formatSom(totals.totalSofFoyda / totals.totalQty) : '—'}
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
                  <TableHead className="text-right">Xarid narxi</TableHead>
                  <TableHead className="text-right">Ish. narxi</TableHead>
                  <TableHead className="text-right">Sotuv narxi</TableHead>
                  <TableHead className="text-right">Foyda/dona</TableHead>
                  <TableHead className="text-right">Sof foyda/dona</TableHead>
                  <TableHead className="text-right">Jami sof foyda</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((row) => {
                  const unitLabel = UNIT_LABELS[row.product_unit as keyof typeof UNIT_LABELS] ?? row.product_unit;
                  const sofPos = (row.total_sof_foyda ?? 0) >= 0;

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
                      <TableCell className="text-right tabular-nums text-violet-600 dark:text-violet-400">
                        {row.production_cost != null
                          ? `${row.production_cost.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {row.sell_price != null
                          ? `${row.sell_price.toLocaleString('uz-UZ', { maximumFractionDigits: 0 })} so'm`
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <FoydaCell value={row.foyda_per_unit} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <FoydaCell value={row.sof_foyda_per_unit} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {row.total_sof_foyda != null ? (
                          <span className={sofPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                            {formatSom(row.total_sof_foyda)}
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
        {!isLoading && !error && items.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-border/40 px-4 py-2">
            <span className="text-xs text-muted-foreground">
              Jami {items.length} ta mahsulot — {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, items.length)} ko&apos;rsatilmoqda
            </span>
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
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        * Xarid narxi — Posterdan olingan (cost_price). Ish. narxi — mahsulot kartasidagi ishlab chiqarish xarajati (production_cost). Sof foyda = Sotuv − Ish. narxi.
      </p>
    </div>
  );
}
