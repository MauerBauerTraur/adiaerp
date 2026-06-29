import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Factory,
  Loader2,
  PlayCircle,
  Users as UsersIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
  UNIT_LABELS,
} from '@/lib/labels';
import { ChainLayerLayout, type ChainKpi } from './ChainLayerLayout';
import type {
  ChainLayerOverview,
  Location,
  ProductionOrder,
  StockRow,
  User,
} from '@/lib/types';

/**
 * F4.6 — `/production` chain-layer screen.
 *
 * RBAC: `pm`, `production_manager`.
 *
 * Layer-specific widgets:
 *   - "Faol zayafkalar" (status=in_progress) — list with one-click
 *     "Yakunlash" (PATCH status=done).
 *   - "Kutilayotgan zayafkalar" (status=new) — list with one-click
 *     "Boshlash" (PATCH status=in_progress).
 *   - "Production xom-ashyo" — raw stock in production locations.
 *   - Stock table (filtered to production locations).
 */
export function ProductionPage() {
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/production',
  );
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=production',
  );
  const active = useApiQuery<ProductionOrder[]>(
    '/api/production-orders?status=in_progress',
  );
  const pending = useApiQuery<ProductionOrder[]>(
    '/api/production-orders?status=new',
  );
  // F4.10 — sub-department tree. `parent_id` is non-null for sub-cehs
  // (Tort sexi, Perojniy sexi, Yarim Fabrika sexi etc.). The endpoint
  // already filters by `type=production`.
  const productionLocations = useApiQuery<Location[]>(
    '/api/locations?type=production',
  );
  const productionUsers = useApiQuery<User[]>('/api/users?role=production_manager');

  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Ishlab chiqarish"
          description="Faol zayafkalar, kutilayotgan reja va ishlab chiqarish bo‘g‘inlari xom-ashyosi."
        />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Ishlab chiqarish"
          description="Faol zayafkalar, kutilayotgan reja va ishlab chiqarish bo‘g‘inlari xom-ashyosi."
        />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null) return null;

  const { totals, locations, recent_movements } = overview.data;
  const activeCount = active.data?.length ?? 0;
  const pendingCount = pending.data?.length ?? 0;

  const kpis: ChainKpi[] = [
    {
      label: 'Faol zayafkalar',
      value: totals.active_production_orders ?? activeCount,
      icon: Factory,
      tone: 'accent',
      hint: 'Hozir ishlab chiqarilmoqda',
    },
    {
      label: 'Kutilayotgan',
      value: pendingCount,
      icon: ClipboardList,
      tone: pendingCount > 0 ? 'amber' : 'neutral',
      hint: 'Yangi zayafkalar',
    },
    {
      label: 'Xom-ashyo turlari',
      value: totals.total_products,
      icon: Boxes,
      tone: 'neutral',
      hint: `${formatQty(totals.total_locations)} ta bo‘g‘inda`,
    },
    {
      label: 'Min’dan past',
      value: totals.below_min_count,
      icon: AlertTriangle,
      tone: totals.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: totals.below_min_count > 0
        ? 'Ishlab chiqarish to‘xtashi mumkin'
        : 'Hammasi yetarli',
    },
  ];

  return (
    <ChainLayerLayout
      layerType="production"
      title="Ishlab chiqarish"
      description="Faol zayafkalar, kutilayotgan reja va ishlab chiqarish bo‘g‘inlari xom-ashyosi."
      totals={totals}
      kpis={kpis}
      locations={locations}
      recentMovements={recent_movements}
      widgets={
        <div className="space-y-6">
          <SubDepartmentsPanel
            locations={productionLocations.data ?? []}
            users={productionUsers.data ?? []}
            activeOrders={active.data ?? []}
            isLoading={productionLocations.isLoading}
            error={productionLocations.error}
            onRetry={productionLocations.refetch}
          />
          <ActiveOrdersPanel
            rows={active.data ?? []}
            isLoading={active.isLoading}
            error={active.error}
            onRetry={active.refetch}
            onTransitioned={() => {
              active.refetch();
              overview.refetch();
              stock.refetch();
            }}
          />
          <PendingOrdersPanel
            rows={pending.data ?? []}
            isLoading={pending.isLoading}
            error={pending.error}
            onRetry={pending.refetch}
            onTransitioned={() => {
              pending.refetch();
              active.refetch();
            }}
          />
          <ProductionStockPanel
            rows={stock.data ?? []}
            isLoading={stock.isLoading}
            error={stock.error}
            onRetry={stock.refetch}
          />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Widget: active orders (in_progress) with "Yakunlash" CTA.
// ---------------------------------------------------------------------------

function ActiveOrdersPanel({
  rows,
  isLoading,
  error,
  onRetry,
  onTransitioned,
}: {
  rows: ProductionOrder[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onTransitioned: () => void;
}) {
  const { notify } = useToast();
  const { canActOn } = useCanAct();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function complete(id: number) {
    setActionError(null);
    setBusyId(id);
    try {
      await apiRequest(`/api/production-orders/${id}`, {
        method: 'PATCH',
        body: { status: 'done' },
      });
      notify('success', 'Zayafka yakunlandi.');
      onTransitioned();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setActionError(
          'BOM komponentlari yetarli emas — zayafka yakunlanmadi. Avval xom-ashyoni to‘ldiring.',
        );
      } else {
        setActionError(
          err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Factory className="size-4 text-amber-300" aria-hidden="true" />
            Faol zayafkalar
          </h2>
          <p className="text-xs text-muted-foreground">
            Hozir ishlab chiqarilmoqda — yakunlash uchun BOM avtomatik sarflanadi.
          </p>
        </div>
        <Link
          to="/production-orders"
          className="text-xs font-medium text-primary hover:underline"
        >
          Hammasini ko‘rish
        </Link>
      </header>
      {actionError && (
        <p
          className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Faol zayafkalar yo‘q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Bo‘g‘in</TableHead>
                <TableHead>Muddat</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground">#{row.id}</TableCell>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(row.qty)}
                  </TableCell>
                  <TableCell>{row.location_name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.deadline ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {canActOn(row.location_id) ? (
                      <Button
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => complete(row.id)}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="size-4" aria-hidden="true" />
                        )}
                        Yakunlash
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Widget: pending orders (new) with "Boshlash" CTA.
// ---------------------------------------------------------------------------

function PendingOrdersPanel({
  rows,
  isLoading,
  error,
  onRetry,
  onTransitioned,
}: {
  rows: ProductionOrder[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onTransitioned: () => void;
}) {
  const { notify } = useToast();
  const { canActOn } = useCanAct();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function start(id: number) {
    setBusyId(id);
    try {
      await apiRequest(`/api/production-orders/${id}`, {
        method: 'PATCH',
        body: { status: 'in_progress' },
      });
      notify('success', 'Zayafka boshlandi.');
      onTransitioned();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ClipboardList className="size-4 text-primary" aria-hidden="true" />
            Kutilayotgan zayafkalar
          </h2>
          <p className="text-xs text-muted-foreground">
            Yangi zayafkalar — boshlash uchun "Boshlash" tugmasini bosing.
          </p>
        </div>
        <Badge variant={rows.length > 0 ? 'warning' : 'success'}>
          {formatQty(rows.length)}
        </Badge>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Yangi zayafkalar yo‘q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Bo‘g‘in</TableHead>
                <TableHead>Muddat</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground">#{row.id}</TableCell>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(row.qty)}
                  </TableCell>
                  <TableCell>{row.location_name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.deadline ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[row.status]}>
                      {PRODUCTION_ORDER_STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canActOn(row.location_id) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => start(row.id)}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <PlayCircle className="size-4" aria-hidden="true" />
                        )}
                        Boshlash
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Widget: production locations' stock (raw inputs available right now).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Widget: sub-department tree (F4.10). Roots have parent_id === null; their
// children are sub-cehs (e.g. "Tort sexi" under "Ishlab chiqarish").
// ---------------------------------------------------------------------------

function SubDepartmentsPanel({
  locations,
  users,
  activeOrders,
  isLoading,
  error,
  onRetry,
}: {
  locations: Location[];
  users: User[];
  activeOrders: ProductionOrder[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const tree = useMemo(() => {
    const byParent = new Map<number | null, Location[]>();
    for (const loc of locations) {
      const key = loc.parent_id;
      const bucket = byParent.get(key) ?? [];
      bucket.push(loc);
      byParent.set(key, bucket);
    }
    const roots = (byParent.get(null) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name, 'uz'),
    );
    return { roots, byParent };
  }, [locations]);

  // active orders count per location
  const activeByLocation = useMemo(() => {
    const m = new Map<number, number>();
    for (const o of activeOrders) {
      m.set(o.location_id, (m.get(o.location_id) ?? 0) + 1);
    }
    return m;
  }, [activeOrders]);

  // users per location — uses primary `location_id`. The M:N junction is
  // not flattened on /api/users, so this is a conservative undercount;
  // it stays useful as a quick "who's primary here" hint.
  const usersByLocation = useMemo(() => {
    const m = new Map<number, User[]>();
    for (const u of users) {
      if (u.location_id === null) continue;
      const bucket = m.get(u.location_id) ?? [];
      bucket.push(u);
      m.set(u.location_id, bucket);
    }
    return m;
  }, [users]);

  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Factory className="size-4 text-amber-300" aria-hidden="true" />
            Sub-bo‘limlar
          </h2>
          <p className="text-xs text-muted-foreground">
            Ishlab chiqarish bo‘g‘inining sub-sexlari, hodimlar va faol
            zayafkalari.
          </p>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/locations">Boshqarish</Link>
        </Button>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && tree.roots.length === 0 && (
        <EmptyState message="Ishlab chiqarish bo‘g‘ini topilmadi." />
      )}
      {!isLoading && !error && tree.roots.length > 0 && (
        <div className="space-y-4 p-5">
          {tree.roots.map((root) => {
            const subs = (tree.byParent.get(root.id) ?? []).sort((a, b) =>
              a.name.localeCompare(b.name, 'uz'),
            );
            return (
              <div key={root.id} className="space-y-3">
                <header className="flex items-center gap-2">
                  <Factory
                    className="size-4 text-amber-300"
                    aria-hidden="true"
                  />
                  <h3 className="text-sm font-semibold">{root.name}</h3>
                  <Badge variant="outline" className="ml-1">
                    {subs.length} sub-bo‘lim
                  </Badge>
                </header>
                {subs.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    Sub-bo‘lim yo‘q. <Link to="/locations" className="underline">Qo‘shish</Link>
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {subs.map((sub) => {
                      const subUsers = usersByLocation.get(sub.id) ?? [];
                      const activeCount = activeByLocation.get(sub.id) ?? 0;
                      return (
                        <div
                          key={sub.id}
                          className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3 shadow-sm"
                          data-testid={`sub-department-${sub.id}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-semibold">
                              {sub.name}
                            </p>
                            <Badge
                              variant={activeCount > 0 ? 'warning' : 'outline'}
                              className="tabular-nums"
                            >
                              {activeCount}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UsersIcon className="size-3" aria-hidden="true" />
                            {subUsers.length > 0 ? (
                              <span className="truncate">
                                {subUsers.map((u) => u.name).join(', ')}
                              </span>
                            ) : (
                              <span>Hodim biriktirilmagan</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ProductionStockPanel({
  rows,
  isLoading,
  error,
  onRetry,
}: {
  rows: StockRow[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
            Ishlab chiqarish xom-ashyosi
          </h2>
          <p className="text-xs text-muted-foreground">
            Ishlab chiqarish bo‘g‘inlaridagi qoldiq — BOM uchun mavjud xom-ashyo.
          </p>
        </div>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Qoldiq topilmadi." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Qoldiq</TableHead>
                <TableHead className="text-right">Min</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Yangilangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const isLow = r.qty <= r.min_level;
                return (
                  <TableRow
                    key={`${r.location_id}-${r.product_id}`}
                    className={isLow ? 'bg-destructive/5' : undefined}
                  >
                    <TableCell className="font-medium">{r.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(r.qty)} {UNIT_LABELS[r.product_unit]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatQty(r.min_level)}
                    </TableCell>
                    <TableCell>
                      {isLow ? (
                        <Badge variant="danger">Min’dan past</Badge>
                      ) : (
                        <Badge variant="success">Yetarli</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.updated_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
