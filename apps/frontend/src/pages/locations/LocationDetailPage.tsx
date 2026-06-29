import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  MapPin,
  User as UserIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import {
  LOCATION_TYPE_LABELS,
  MOVEMENT_REASON_LABELS,
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  ROLE_LABELS,
  UNIT_LABELS,
} from '@/lib/labels';
import { formatDateTime, formatQty, formatRelative } from '@/lib/format';
import { CHAIN_CLASSES, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import { cn } from '@/lib/utils';
import type {
  Location,
  LocationType,
  MovementsResponse,
  ReplenishmentRequest,
  StockRow,
  User,
} from '@/lib/types';

/**
 * Per-location detail page (Ekosistema canvas → click a node).
 *
 * Composition:
 *   1. PageHeader — back link + name + type badge + status dot
 *   2. KPI strip — SKU count / below-min / open requests / last movement
 *   3. Stock table — sortable per-product qty + min/max
 *   4. Recent movements — last 20 (paginated envelope, no extra query)
 *   5. Open requests — replenishment_requests touching this location
 *   6. Manager info — embedded from `locations.manager_user_id`
 */
export function LocationDetailPage() {
  const { locationId: idParam } = useParams<{ locationId: string }>();
  const locationId = idParam ? Number(idParam) : Number.NaN;
  const validId = Number.isFinite(locationId) && locationId > 0;

  const locationQuery = useApiQuery<{ location: Location }>(
    validId ? `/api/locations/${locationId}` : null,
  );
  const stockQuery = useApiQuery<StockRow[]>(
    validId ? `/api/stock?location_id=${locationId}` : null,
  );
  const movementsQuery = useApiQuery<MovementsResponse>(
    validId ? `/api/stock/movements?location_id=${locationId}&limit=20` : null,
  );
  const requestsQuery = useApiQuery<ReplenishmentRequest[]>(
    validId ? `/api/replenishment?status=NEW` : null,
  );

  // Manager lookup — only PM has access to `/api/users`; other roles see
  // a "#id" fallback so the page does not surface a forbidden fetch.
  const { user } = useAuth();
  const isPm = user?.role === 'pm';
  const usersQuery = useApiQuery<User[]>(isPm ? '/api/users' : null);

  const allRequests = requestsQuery.data ?? [];
  const requestsForLocation = useMemo(
    () =>
      allRequests.filter(
        (r) =>
          r.requester_location_id === locationId ||
          r.target_location_id === locationId,
      ),
    [allRequests, locationId],
  );

  if (!validId) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="p-6">
          <EmptyState message="Bo'g'in topilmadi." />
        </Card>
      </div>
    );
  }

  if (locationQuery.isLoading && locationQuery.data === null) {
    return <LoadingState />;
  }

  if (locationQuery.error && locationQuery.data === null) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState
          message={locationQuery.error}
          onRetry={locationQuery.refetch}
        />
      </div>
    );
  }

  const location = locationQuery.data?.location ?? null;
  if (location === null) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="p-6">
          <EmptyState message="Bo'g'in topilmadi." />
        </Card>
      </div>
    );
  }

  const stockRows = stockQuery.data ?? [];
  const movements = movementsQuery.data?.items ?? [];
  const managerUser =
    location.manager_user_id !== null && usersQuery.data
      ? usersQuery.data.find((u) => u.id === location.manager_user_id) ?? null
      : null;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <BackLink />

      <LocationHeader location={location} stockRows={stockRows} />

      <KpiStrip
        stockRows={stockRows}
        openRequestsCount={requestsForLocation.length}
        lastMovementAt={movements[0]?.created_at ?? null}
      />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-12">
        <StockSection
          rows={stockRows}
          isLoading={stockQuery.isLoading}
          error={stockQuery.error}
          onRetry={stockQuery.refetch}
          className="xl:col-span-8"
        />
        <ManagerCard
          location={location}
          manager={managerUser}
          isPm={isPm}
          className="xl:col-span-4"
        />
      </div>

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-12">
        <MovementsSection
          movements={movements}
          isLoading={movementsQuery.isLoading}
          error={movementsQuery.error}
          onRetry={movementsQuery.refetch}
          className="xl:col-span-7"
        />
        <OpenRequestsSection
          requests={requestsForLocation}
          locationId={locationId}
          isLoading={requestsQuery.isLoading}
          error={requestsQuery.error}
          onRetry={requestsQuery.refetch}
          className="xl:col-span-5"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackLink() {
  return (
    <Link
      to="/dashboard"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm"
      data-testid="location-detail-back"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Boshqaruv paneliga
    </Link>
  );
}

const LOCATION_TYPE_ICON: Record<LocationType, typeof MapPin> = {
  raw_warehouse: Boxes,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

function deriveStatus(stockRows: StockRow[]): 'ok' | 'warn' | 'danger' {
  const below = stockRows.filter(
    (r) => r.min_level > 0 && Number(r.qty) <= r.min_level,
  ).length;
  if (below === 0) return 'ok';
  if (below <= 3) return 'warn';
  return 'danger';
}

function statusLabel(status: 'ok' | 'warn' | 'danger'): string {
  if (status === 'ok') return 'Holat: yaxshi';
  if (status === 'warn') return 'Holat: ogohlantirish';
  return 'Holat: kritik';
}

function statusDotClass(status: 'ok' | 'warn' | 'danger'): string {
  if (status === 'ok') return 'bg-success';
  if (status === 'warn') return 'bg-warning';
  return 'bg-destructive';
}

function LocationHeader({
  location,
  stockRows,
}: {
  location: Location;
  stockRows: StockRow[];
}) {
  const Icon = LOCATION_TYPE_ICON[location.type] ?? MapPin;
  const tone = CHAIN_TONE_BY_TYPE[location.type];
  const classes = CHAIN_CLASSES[tone];
  const status = deriveStatus(stockRows);

  return (
    <PageHeader
      title={location.name}
      description={LOCATION_TYPE_LABELS[location.type]}
      action={
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="location-detail-header-meta"
        >
          <Badge variant="outline" className={cn('gap-1.5', classes.text)}>
            <Icon className="size-3.5" aria-hidden="true" />
            {LOCATION_TYPE_LABELS[location.type]}
          </Badge>
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 py-0.5 text-xs"
            data-testid="location-detail-status"
            aria-label={statusLabel(status)}
          >
            <span
              aria-hidden="true"
              className={cn('inline-block size-2 rounded-full', statusDotClass(status))}
            />
            {statusLabel(status)}
          </span>
        </div>
      }
    />
  );
}

function KpiStrip({
  stockRows,
  openRequestsCount,
  lastMovementAt,
}: {
  stockRows: StockRow[];
  openRequestsCount: number;
  lastMovementAt: string | null;
}) {
  const skuCount = stockRows.length;
  const belowMin = stockRows.filter(
    (r) => r.min_level > 0 && Number(r.qty) <= r.min_level,
  ).length;

  const cards: Array<{
    id: string;
    label: string;
    value: string;
    tone: 'neutral' | 'warning' | 'danger';
  }> = [
    { id: 'sku', label: 'SKU soni', value: formatQty(skuCount), tone: 'neutral' },
    {
      id: 'below-min',
      label: "Min'dan past",
      value: formatQty(belowMin),
      tone: belowMin > 0 ? 'danger' : 'neutral',
    },
    {
      id: 'open-requests',
      label: "Ochiq so'rovlar",
      value: formatQty(openRequestsCount),
      tone: openRequestsCount > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'last-movement',
      label: 'Oxirgi harakat',
      value: lastMovementAt ? formatRelative(lastMovementAt) : '—',
      tone: 'neutral',
    },
  ];

  return (
    <div
      className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4"
      data-testid="location-detail-kpis"
    >
      {cards.map((c) => (
        <Card
          key={c.id}
          className={cn(
            'flex min-h-[120px] flex-col p-4 sm:p-5',
            c.tone === 'danger' && 'ring-1 ring-destructive/40',
            c.tone === 'warning' && 'ring-1 ring-warning/40',
          )}
          data-testid={`location-detail-kpi-${c.id}`}
          data-tone={c.tone}
        >
          <p className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {c.label}
          </p>
          <p
            className={cn(
              'mt-2 text-3xl font-bold tabular-nums leading-none sm:text-4xl',
              c.tone === 'danger' && 'text-destructive',
              c.tone === 'warning' && 'text-warning',
            )}
          >
            {c.value}
          </p>
        </Card>
      ))}
    </div>
  );
}

type SortDirection = 'asc' | 'desc';

function StockSection({
  rows,
  isLoading,
  error,
  onRetry,
  className,
}: {
  rows: StockRow[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}) {
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const diff = Number(a.qty) - Number(b.qty);
      return sortDir === 'asc' ? diff : -diff;
    });
    return copy;
  }, [rows, sortDir]);

  function toggleSort() {
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  return (
    <Card className={cn('p-4 sm:p-5', className)} data-testid="location-detail-stock">
      <header className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Mahsulot qoldig'i
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatQty(rows.length)} ta SKU
        </span>
      </header>

      {isLoading && rows.length === 0 ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState message="Bu bo'g'inda qoldiq mahsulot yo'q." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mahsulot</TableHead>
              <TableHead className="text-right">
                <button
                  type="button"
                  onClick={toggleSort}
                  className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm"
                  aria-label={
                    sortDir === 'asc'
                      ? 'Qoldiq bo\'yicha kamayish tartibida saralash'
                      : 'Qoldiq bo\'yicha ortish tartibida saralash'
                  }
                  data-testid="location-detail-stock-sort"
                >
                  Qoldiq
                  {sortDir === 'asc' ? (
                    <ArrowUp className="size-3" aria-hidden="true" />
                  ) : sortDir === 'desc' ? (
                    <ArrowDown className="size-3" aria-hidden="true" />
                  ) : (
                    <ArrowUpDown className="size-3" aria-hidden="true" />
                  )}
                </button>
              </TableHead>
              <TableHead className="text-right">Min</TableHead>
              <TableHead className="text-right">Max</TableHead>
              <TableHead className="text-right">Holat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const qty = Number(row.qty);
              const below = row.min_level > 0 && qty <= row.min_level;
              const near =
                !below && row.min_level > 0 && qty <= row.min_level * 1.25;
              const variant: 'success' | 'warning' | 'danger' = below
                ? 'danger'
                : near
                  ? 'warning'
                  : 'success';
              const label = below ? "Min'dan past" : near ? "Min'ga yaqin" : 'Yaxshi';
              return (
                <TableRow key={row.product_id}>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(qty)} {UNIT_LABELS[row.product_unit]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatQty(row.min_level)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatQty(row.max_level)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={variant}>{label}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function MovementsSection({
  movements,
  isLoading,
  error,
  onRetry,
  className,
}: {
  movements: MovementsResponse['items'];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <Card
      className={cn('p-4 sm:p-5', className)}
      data-testid="location-detail-movements"
    >
      <header className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Oxirgi harakatlar
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatQty(movements.length)} ta
        </span>
      </header>

      {isLoading && movements.length === 0 ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : movements.length === 0 ? (
        <EmptyState message="Harakatlar topilmadi." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vaqt</TableHead>
              <TableHead>Mahsulot</TableHead>
              <TableHead>Manba → Qabul</TableHead>
              <TableHead className="text-right">Miqdor</TableHead>
              <TableHead>Sabab</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movements.map((m) => (
              <TableRow key={m.id}>
                <TableCell
                  className="whitespace-nowrap text-xs text-muted-foreground"
                  title={formatDateTime(m.created_at)}
                >
                  {formatRelative(m.created_at)}
                </TableCell>
                <TableCell className="font-medium">{m.product_name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {m.from_location_name ?? '—'} → {m.to_location_name ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(Number(m.qty))} {UNIT_LABELS[m.product_unit]}
                </TableCell>
                <TableCell className="text-xs">
                  <Badge variant="outline">
                    {MOVEMENT_REASON_LABELS[m.reason]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function OpenRequestsSection({
  requests,
  locationId,
  isLoading,
  error,
  onRetry,
  className,
}: {
  requests: ReplenishmentRequest[];
  locationId: number;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <Card
      className={cn('flex flex-col p-4 sm:p-5', className)}
      data-testid="location-detail-requests"
    >
      <header className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Ochiq so'rovlar
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatQty(requests.length)} ta
        </span>
      </header>

      {isLoading && requests.length === 0 ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : requests.length === 0 ? (
        <EmptyState message="Bu bo'g'in uchun ochiq so'rov yo'q." />
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => {
            const direction =
              r.requester_location_id === locationId
                ? "kelgan"
                : "yo'naltirilgan";
            return (
              <li key={r.id}>
                <Link
                  to={`/replenishment/${r.id}`}
                  className="block rounded-md border border-border/60 bg-card/40 px-3 py-2 transition-colors hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {r.product_name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        #{r.id} · {formatQty(Number(r.qty_needed))}{' '}
                        {UNIT_LABELS[r.product_unit]} · {direction}
                      </p>
                    </div>
                    <Badge variant={REPLENISHMENT_STATUS_VARIANT[r.status]}>
                      {REPLENISHMENT_STATUS_LABELS[r.status]}
                    </Badge>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ManagerCard({
  location,
  manager,
  isPm,
  className,
}: {
  location: Location;
  manager: User | null;
  isPm: boolean;
  className?: string;
}) {
  const hasManagerId = location.manager_user_id !== null;
  return (
    <Card
      className={cn('flex flex-col gap-3 p-4 sm:p-5', className)}
      data-testid="location-detail-manager"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Bo'g'in boshlig'i
        </h2>
      </header>

      {!hasManagerId ? (
        <EmptyState message="Bu bo'g'in uchun boshliq tayinlanmagan." />
      ) : manager !== null ? (
        <div className="flex items-start gap-3">
          <div
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <UserIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{manager.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {ROLE_LABELS[manager.role]}
            </p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              @{manager.username}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isPm
            ? `Boshliq #${location.manager_user_id}`
            : `Boshliq tayinlangan (#${location.manager_user_id}). To'liq ma'lumotni ko'rish uchun loyiha rahbari roli kerak.`}
        </p>
      )}
    </Card>
  );
}

