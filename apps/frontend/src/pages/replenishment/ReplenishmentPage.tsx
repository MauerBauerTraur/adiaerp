import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_OPTIONS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_OPTIONS,
} from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import type {
  ReplenishmentRequest,
  Unit,
} from '@/lib/types';

/**
 * EPIC 4.1 — the three filter dimensions of the replenishment list:
 *   - "O'lchov birligi" (l/kg/dona) — matched against `product_unit`;
 *   - "Holat"          — the 10-status replenishment state machine;
 *   - "Bo'lim"         — the requesting bo'g'in (built from the data set
 *                         so only locations actually present appear).
 *
 * The bo'lim options are derived per-render from the fetched rows, so this
 * group lives in the component (the static groups are hoisted out).
 */
const STATIC_FILTER_GROUPS: FilterGroup[] = [
  {
    key: 'unit',
    label: 'O‘lchov birligi',
    searchable: false,
    options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
  },
  {
    key: 'status',
    label: 'Holat',
    searchable: false,
    options: REPLENISHMENT_STATUS_OPTIONS.map((s) => ({
      value: s.value,
      label: s.label,
    })),
  },
];

const EMPTY_FILTER: FilterValue = { unit: [], status: [], department: [] };

/**
 * M4 — replenishment list screen.
 * `GET /api/replenishment` returns a bare `ReplenishmentRequest[]`
 * (RBAC-scoped by the backend). F4.10 removed manual creation — the
 * replenishment engine raises requests automatically; managers only
 * advance / cancel them. The boshliq sees the list read-only.
 *
 * EPIC 4.1 — the single status `<Select>` is replaced by the reusable
 * `FilterPopover` (o'lchov birligi + holat + bo'lim) plus a translit-aware
 * smart search box. Filtering is client-side over the full list (Faza-1
 * volumes are small and the list endpoint stays a single round-trip).
 */
export function ReplenishmentPage() {
  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [view, setView] = useViewMode('replenishment', 'card');
  const [filter, setFilter] = useState<FilterValue>(EMPTY_FILTER);
  const [search, setSearch] = useState('');

  // Fetch the full list once and filter client-side so the o'lchov / holat /
  // bo'lim multi-select and translit search all compose without extra trips.
  const { data, isLoading, error, refetch } =
    useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  const allRows = useMemo(() => data ?? [], [data]);

  // EPIC 4.1 — "Bo'lim" options are the distinct requesting bo'g'inlar in
  // the current data set (id → name), so the picker never lists a location
  // the user can't actually see.
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const seen = new Map<string, string>();
    for (const row of allRows) {
      seen.set(String(row.requester_location_id), row.requester_location_name);
    }
    const departmentOptions = Array.from(seen, ([value, label]) => ({
      value,
      label,
    })).sort((a, b) => a.label.localeCompare(b.label, 'uz'));
    return [
      ...STATIC_FILTER_GROUPS,
      {
        key: 'department',
        label: 'Bo‘lim',
        options: departmentOptions,
      },
    ];
  }, [allRows]);

  const rows = useMemo(() => {
    const units = filter.unit ?? [];
    const statuses = filter.status ?? [];
    const departments = filter.department ?? [];
    return allRows.filter((row) => {
      if (units.length > 0 && !units.includes(row.product_unit as Unit)) {
        return false;
      }
      if (statuses.length > 0 && !statuses.includes(row.status)) {
        return false;
      }
      if (
        departments.length > 0 &&
        !departments.includes(String(row.requester_location_id))
      ) {
        return false;
      }
      // EPIC 4.1 — smart search across product name + requesting bo'g'in,
      // translit-aware (Latin ↔ Cyrillic) via the shared helper.
      if (
        !matchesSearch(
          `${row.product_name} ${row.requester_location_name}`,
          search,
        )
      ) {
        return false;
      }
      return true;
    });
  }, [allRows, filter, search]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="To‘ldirish so‘rovlari"
        description="Avtomatik to‘ldirish tsikli va so‘rovlar holati."
        action={<ViewToggle value={view} onChange={setView} />}
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Qidirish (lotin yoki kirill)…"
            aria-label="So‘rov qidirish"
            className="pl-9 pr-9"
          />
          {search !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Qidiruvni tozalash"
              className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <FilterPopover
          groups={filterGroups}
          value={filter}
          onApply={setFilter}
        />
        <p
          className="text-sm text-muted-foreground sm:ml-auto"
          aria-live="polite"
        >
          {`${rows.length} ta so‘rov`}
        </p>
      </div>

      <Card
        className={
          view === 'card' && !showMobileCards
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && rows.length === 0 && (
          <EmptyState message="So‘rovlar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && (showMobileCards || view === 'card') && (
          <div>
            {showMobileCards ? (
              <MobileCardList
                items={rows.map((row) => ({
                  id: row.id,
                  title: `#${row.id} · ${row.product_name}`,
                  subtitle: row.requester_location_name,
                  badge: (
                    <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                      {REPLENISHMENT_STATUS_LABELS[row.status]}
                    </Badge>
                  ),
                  fields: [
                    {
                      label: 'Miqdor',
                      value: `${formatQty(row.qty_needed)} ${row.product_unit}`,
                    },
                    { label: 'Yaratilgan', value: formatDateTime(row.created_at) },
                  ],
                  footer: (
                    <Button variant="outline" size="sm" asChild className="w-full">
                      <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                    </Button>
                  ),
                }))}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">#{row.id}</p>
                        <p className="truncate text-sm font-semibold">
                          {row.product_name}
                        </p>
                      </div>
                      <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                        {REPLENISHMENT_STATUS_LABELS[row.status]}
                      </Badge>
                    </div>
                    <dl className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Miqdor</dt>
                        <dd className="tabular-nums">
                          {formatQty(row.qty_needed)} {row.product_unit}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">So‘rovchi</dt>
                        <dd className="truncate text-right">
                          {row.requester_location_name}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Yaratilgan</dt>
                        <dd className="text-right text-muted-foreground">
                          {formatDateTime(row.created_at)}
                        </dd>
                      </div>
                    </dl>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="w-full"
                    >
                      <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && !showMobileCards && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>So‘rovchi bo‘g‘in</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Yaratilgan</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">
                      #{row.id}
                    </TableCell>
                    <TableCell className="font-medium">
                      {row.product_name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(row.qty_needed)} {row.product_unit}
                    </TableCell>
                    <TableCell>{row.requester_location_name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={REPLENISHMENT_STATUS_VARIANT[row.status]}
                      >
                        {REPLENISHMENT_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(row.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
