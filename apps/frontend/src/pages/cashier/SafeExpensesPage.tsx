import { useMemo, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatSom, formatDateTime } from '@/lib/format';
import type { SafeExpensesResponse, SafeExpense } from '@/lib/types';

/**
 * EPIC 8.7 — seyf rasxodlari.
 *
 * Seyfdan chiqarilgan har bir rasxod (ijara, maosh, transport...) bir
 * transaksiya sifatida qayd etiladi — sodda ro'yxat + jami. Egasi
 * qarori: Poster read-only, shuning uchun seyf rasxodi ADIA ichida
 * yashaydi.
 *
 * Backend: `GET /api/safe-expenses` (finance.getTransactions — gap P8/P11)
 * hali yo'q. 404 → "tayyorlanmoqda" empty-state.
 * TODO(backend): EPIC 8.7 seyf rasxodi endpoint (yaratish + ro'yxat).
 */
export function SafeExpensesPage() {
  const { data, isLoading, error, refetch } =
    useApiQuery<SafeExpensesResponse>('/api/safe-expenses');

  const [filter, setFilter] = useState<FilterValue>({});

  const items = useMemo(() => data?.items ?? [], [data]);
  const notImplemented =
    error !== null && /404|topilmadi|mavjud emas/i.test(error);

  const filterGroups = useMemo<FilterGroup[]>(() => {
    const categories = [...new Set(items.map((e) => e.category))].sort();
    if (categories.length === 0) return [];
    return [
      {
        key: 'category',
        label: 'Turkum',
        options: categories.map((c) => ({ value: c, label: c })),
      },
    ];
  }, [items]);

  const rows = useMemo<SafeExpense[]>(() => {
    const cats = filter['category'] ?? [];
    if (cats.length === 0) return items;
    const set = new Set(cats);
    return items.filter((e) => set.has(e.category));
  }, [items, filter]);

  const total = useMemo(
    () => rows.reduce((sum, e) => sum + e.amount, 0),
    [rows],
  );

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Seyf rasxodlari"
        description="Seyfdan chiqarilgan rasxodlar (ijara, maosh, transport...) — har biri transaksiya sifatida qayd etiladi."
        dateTime
        filter={
          filterGroups.length > 0 ? (
            <FilterPopover
              groups={filterGroups}
              value={filter}
              onApply={setFilter}
            />
          ) : undefined
        }
      />

      {isLoading && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!isLoading && error && notImplemented && (
        <Card>
          <EmptyState message="Seyf rasxodi moduli tayyorlanmoqda — backend kontrakti hali ulanmagan." />
        </Card>
      )}

      {!isLoading && error && !notImplemented && (
        <Card>
          <ErrorState message={error} onRetry={refetch} />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <EmptyState message="Seyf rasxodlari topilmadi." />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="size-4" aria-hidden="true" />
              {rows.length} ta rasxod
            </span>
            <span className="text-sm font-semibold tabular-nums">
              Jami: {formatSom(total)}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sana</TableHead>
                <TableHead>Turkum</TableHead>
                <TableHead>Izoh</TableHead>
                <TableHead>Kim</TableHead>
                <TableHead className="text-right">Summa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(e.spent_at)}
                  </TableCell>
                  <TableCell className="font-medium">{e.category}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.note ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.recorded_by_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSom(e.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
