import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { formatSom, formatDateTime } from '@/lib/format';
import { CASH_SHIFT_STATUS_LABELS } from '@/lib/labels';
import type { CashShiftsResponse, CashShift, CashShiftStatus } from '@/lib/types';

/**
 * EPIC 8.5 — do'kon kassa smenasi (cash shift) topshiriqlari.
 *
 * Smena yopilganda kassir kunlik pul oqimini topshiradi; egasiga
 * kniжный/факт balansli ko'rinish kerak (image2): itogo savdo, naqd,
 * karta, rasxod, inkassatsiya va yopilish qoldig'i. Balans nomuvofiq
 * bo'lsa (kniжный ≠ факт) ogohlantirish ko'rinadi.
 *
 * Backend: `GET /api/cash-shifts` (Poster finance.getCashshifts — gap P8)
 * hali yo'q. 404 → "tayyorlanmoqda" empty-state.
 * TODO(backend): EPIC 8.5 kassa smenasi endpoint + TG topshirish.
 */
export function CashShiftsPage() {
  const { data, isLoading, error, refetch } =
    useApiQuery<CashShiftsResponse>('/api/cash-shifts');

  const [filter, setFilter] = useState<FilterValue>({});

  const items = useMemo(() => data?.items ?? [], [data]);
  const notImplemented =
    error !== null && /404|topilmadi|mavjud emas/i.test(error);

  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      {
        key: 'status',
        label: 'Holat',
        searchable: false,
        options: (['open', 'closed'] as CashShiftStatus[]).map((s) => ({
          value: s,
          label: CASH_SHIFT_STATUS_LABELS[s],
        })),
      },
    ],
    [],
  );

  const rows = useMemo<CashShift[]>(() => {
    const statuses = filter['status'] ?? [];
    if (statuses.length === 0) return items;
    const set = new Set(statuses);
    return items.filter((s) => set.has(s.status));
  }, [items, filter]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Kassa smenalari"
        description="Do‘kon smenasi yopilganda: savdo, naqd/karta, rasxod, inkassatsiya va qoldiq. Nomuvofiqlik ogohlantiriladi."
        dateTime
        filter={
          <FilterPopover
            groups={filterGroups}
            value={filter}
            onApply={setFilter}
          />
        }
        action={
          <Link
            to="/cashier/nakladnoy"
            className="inline-flex items-center rounded-md border border-border bg-card/40 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Nakladnoylar
          </Link>
        }
      />

      {isLoading && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!isLoading && error && notImplemented && (
        <Card>
          <EmptyState message="Kassa smenasi moduli tayyorlanmoqda — Poster finance kontrakti hali ulanmagan." />
        </Card>
      )}

      {!isLoading && error && !notImplemented && (
        <Card>
          <ErrorState message={error} onRetry={refetch} />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <EmptyState message="Smenalar topilmadi." />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((s) => (
            <CashShiftCard key={s.id} shift={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function CashShiftCard({ shift }: { shift: CashShift }) {
  const unbalanced = shift.balance_discrepancy !== 0;
  return (
    <article
      className={cn(
        'space-y-3 rounded-lg border bg-card/50 p-4',
        unbalanced ? 'border-warning/50 bg-warning/5' : 'border-border/60',
      )}
      aria-label={`Smena #${shift.id}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{shift.store_name}</p>
          <p className="text-xs text-muted-foreground">
            Smena #{shift.id}
            {shift.cashier_name && <> · {shift.cashier_name}</>}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(shift.opened_at)}
            {shift.closed_at && <> — {formatDateTime(shift.closed_at)}</>}
          </p>
        </div>
        <Badge variant={shift.status === 'open' ? 'secondary' : 'outline'}>
          {CASH_SHIFT_STATUS_LABELS[shift.status]}
        </Badge>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <MoneyRow label="Itogo savdo" value={shift.total_sales} strong />
        <MoneyRow label="Naqd" value={shift.cash_amount} />
        <MoneyRow label="Karta" value={shift.card_amount} />
        <MoneyRow label="Rasxod" value={shift.expense_amount} />
        <MoneyRow label="Inkassatsiya" value={shift.collected_amount} />
        <MoneyRow label="Qoldiq" value={shift.closing_balance} strong />
      </dl>

      {unbalanced && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
          Kniжный/факт nomuvofiqligi: {formatSom(shift.balance_discrepancy)}
        </p>
      )}
    </article>
  );
}

function MoneyRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          strong ? 'font-semibold text-foreground' : 'text-foreground/90',
        )}
      >
        {formatSom(value)}
      </dd>
    </div>
  );
}
