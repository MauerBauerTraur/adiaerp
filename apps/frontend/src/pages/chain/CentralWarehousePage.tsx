import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Inbox,
  Loader2,
  Package,
  Send,
  Truck,
  Warehouse,
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
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_LABELS,
} from '@/lib/labels';
import { ChainLayerLayout, type ChainKpi } from './ChainLayerLayout';
import type {
  ChainLayerOverview,
  ReplenishmentRequest,
  StockRow,
} from '@/lib/types';

/**
 * F4.6 — `/central-warehouse` chain-layer screen.
 *
 * RBAC: `pm`, `central_warehouse_manager`.
 *
 * Layer-specific widgets:
 *   - "Do'konlardan kelgan so'rovlar" — replenishment requests in
 *     `SHIP_TO_REQUESTER`; one-click "Jo'natmani bajarish" advances the
 *     state machine.
 *   - "Sex skladidan kelmoqda" — replenishment requests in
 *     `DONE_TO_WAREHOUSE` (sex storage finished, central will receive).
 *   - Stock table (filtered to central warehouse locations).
 */
export function CentralWarehousePage() {
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/central_warehouse',
  );
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=central_warehouse',
  );
  const shipTasks = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=SHIP_TO_REQUESTER',
  );
  const incomingReady = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=DONE_TO_WAREHOUSE',
  );
  const incomingProducing = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=PRODUCING',
  );

  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Markaziy sklad"
          description="Markaziy sklad qoldig'i, kelayotgan jo'natmalar va do'konlarga jo'natma vazifalari."
        />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Markaziy sklad"
          description="Markaziy sklad qoldig'i, kelayotgan jo'natmalar va do'konlarga jo'natma vazifalari."
        />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null) return null;

  const { totals, locations, recent_movements } = overview.data;

  const kpis: ChainKpi[] = [
    {
      label: 'Tayyor mahsulot turlari',
      value: totals.total_products,
      icon: Package,
      tone: 'accent',
      hint: "Markaziy sklad qoldig'i",
      href: '/stock?location_type=central_warehouse',
    },
    {
      label: "Min'dan past",
      value: totals.below_min_count,
      icon: AlertTriangle,
      tone: totals.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: "Tezda jo'natma kerak",
      href: '/stock?location_type=central_warehouse',
    },
    {
      label: "Jo'natma topshiriqlari",
      value: totals.pending_shipments ?? (shipTasks.data?.length ?? 0),
      icon: Send,
      tone: (shipTasks.data?.length ?? 0) > 0 ? 'amber' : 'neutral',
      hint: "Do'konlarga jo'natish",
      href: '/replenishment?status=SHIP_TO_REQUESTER',
    },
    {
      label: 'Kelayotgan',
      value: (incomingReady.data?.length ?? 0) + (incomingProducing.data?.length ?? 0),
      icon: Inbox,
      tone: ((incomingReady.data?.length ?? 0) + (incomingProducing.data?.length ?? 0)) > 0 ? 'accent' : 'neutral',
      hint: 'Sex skladidan topshiriladi',
      href: '/replenishment?status=DONE_TO_WAREHOUSE',
    },
  ];

  return (
    <ChainLayerLayout
      layerType="central_warehouse"
      title="Markaziy sklad"
      description="Markaziy sklad qoldig'i, kelayotgan jo'natmalar va do'konlarga jo'natma vazifalari."
      totals={totals}
      kpis={kpis}
      locations={locations}
      recentMovements={recent_movements}
      widgets={
        <div className="space-y-6">
          <ShipToStoresPanel
            rows={shipTasks.data ?? []}
            isLoading={shipTasks.isLoading}
            error={shipTasks.error}
            onRetry={shipTasks.refetch}
            onAdvanced={() => {
              shipTasks.refetch();
              overview.refetch();
              stock.refetch();
            }}
          />
          <IncomingFromSupplyPanel
            readyRows={incomingReady.data ?? []}
            producingRows={incomingProducing.data ?? []}
            isLoading={incomingReady.isLoading || incomingProducing.isLoading}
            error={incomingReady.error ?? incomingProducing.error}
            onRetry={() => { incomingReady.refetch(); incomingProducing.refetch(); }}
            onAccepted={() => {
              incomingReady.refetch();
              incomingProducing.refetch();
              shipTasks.refetch();
              overview.refetch();
            }}
          />
          <CentralStockPanel
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
// Widget: ship-to-stores (SHIP_TO_REQUESTER → next step).
// ---------------------------------------------------------------------------

function ShipToStoresPanel({
  rows,
  isLoading,
  error,
  onRetry,
  onAdvanced,
}: {
  rows: ReplenishmentRequest[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onAdvanced: () => void;
}) {
  const { notify } = useToast();
  const { canActOn } = useCanAct();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function advance(id: number) {
    setBusyId(id);
    try {
      await apiRequest(`/api/replenishment/${id}/advance`, { method: 'POST' });
      notify('success', "Jo'natma bajarildi, so'rov holati yangilandi.");
      onAdvanced();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : "Jo'natma bajarilmadi.",
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
            <Send className="size-4 text-emerald-300" aria-hidden="true" />
            Do'konlarga jo'natish kerak
          </h2>
          <p className="text-xs text-muted-foreground">
            Do'konlardan kelgan va markaziy skladdan jo'natilishi kerak bo'lgan
            so'rovlar.
          </p>
        </div>
        <Link
          to="/replenishment"
          className="text-xs font-medium text-primary hover:underline"
        >
          Hammasini ko'rish
        </Link>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Hozircha jo'natma topshiriqlari yo'q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Do'kon</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground">
                    <Link
                      to={`/replenishment/${row.id}`}
                      className="hover:underline"
                    >
                      #{row.id}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(row.qty_needed)} {UNIT_LABELS[row.product_unit]}
                  </TableCell>
                  <TableCell>{row.requester_location_name}</TableCell>
                  <TableCell className="text-right">
                    {(canActOn(row.requester_location_id) ||
                      canActOn(row.target_location_id)) ? (
                      <Button
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => advance(row.id)}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Truck className="size-4" aria-hidden="true" />
                        )}
                        Jo'natmani bajarish
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
// Widget: incoming from supply (PRODUCING + DONE_TO_WAREHOUSE).
// ---------------------------------------------------------------------------

function IncomingFromSupplyPanel({
  readyRows,
  producingRows,
  isLoading,
  error,
  onRetry,
  onAccepted,
}: {
  readyRows: ReplenishmentRequest[];
  producingRows: ReplenishmentRequest[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onAccepted: () => void;
}) {
  const { notify } = useToast();
  const { canActOn } = useCanAct();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function accept(id: number) {
    setBusyId(id);
    try {
      await apiRequest(`/api/replenishment/${id}/advance`, { method: 'POST' });
      notify('success', 'Qabul qilindi — so\'rovni jo\'natish navbatiga o\'tdi.');
      onAccepted();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul amalga oshmadi.',
      );
    } finally {
      setBusyId(null);
    }
  }

  const total = readyRows.length + producingRows.length;

  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Inbox className="size-4 text-primary" aria-hidden="true" />
            Sex skladidan kelmoqda
          </h2>
          <p className="text-xs text-muted-foreground">
            Sexda ishlab chiqarilayotgan va markaziy sklad qabul qilishi kerak
            bo'lgan so'rovlar.
          </p>
        </div>
        <Badge variant={total > 0 ? 'warning' : 'success'}>
          {total}
        </Badge>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && total === 0 && (
        <EmptyState message="Hozircha kelayotgan jo'natmalar yo'q. Sex produkt ishlab chiqarib tugatgach bu yerda ko'rinadi." />
      )}
      {!isLoading && !error && total > 0 && (
        <div className="divide-y divide-border/40">
          {/* DONE_TO_WAREHOUSE — tayyor, qabul kutmoqda */}
          {readyRows.length > 0 && (
            <div>
              <div className="flex items-center gap-2 bg-emerald-500/5 px-5 py-2">
                <span className="size-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  Tayyor — qabul kutmoqda ({readyRows.length})
                </span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Mahsulot</TableHead>
                      <TableHead className="text-right">Miqdor</TableHead>
                      <TableHead>So'rovchi</TableHead>
                      <TableHead className="text-right">Amal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {readyRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-muted-foreground">
                          <Link to={`/replenishment/${row.id}`} className="hover:underline">
                            #{row.id}
                          </Link>
                        </TableCell>
                        <TableCell className="font-medium">{row.product_name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(row.qty_needed)} {UNIT_LABELS[row.product_unit]}
                        </TableCell>
                        <TableCell>{row.requester_location_name}</TableCell>
                        <TableCell className="text-right">
                          {(canActOn(row.requester_location_id) || canActOn(row.target_location_id)) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === row.id}
                              onClick={() => accept(row.id)}
                            >
                              {busyId === row.id ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <Inbox className="size-4" aria-hidden="true" />
                              )}
                              Qabul qilish
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
            </div>
          )}

          {/* PRODUCING — hali ishlab chiqarilmoqda */}
          {producingRows.length > 0 && (
            <div>
              <div className="flex items-center gap-2 bg-primary/5 px-5 py-2">
                <span className="size-2 rounded-full bg-primary/70" />
                <span className="text-xs font-semibold text-primary/80">
                  Ishlab chiqarilmoqda ({producingRows.length})
                </span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Mahsulot</TableHead>
                      <TableHead className="text-right">Miqdor</TableHead>
                      <TableHead>So'rovchi</TableHead>
                      <TableHead>Holat</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {producingRows.map((row) => (
                      <TableRow key={row.id} className="opacity-75">
                        <TableCell className="text-muted-foreground">
                          <Link to={`/replenishment/${row.id}`} className="hover:underline">
                            #{row.id}
                          </Link>
                        </TableCell>
                        <TableCell className="font-medium">{row.product_name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(row.qty_needed)} {UNIT_LABELS[row.product_unit]}
                        </TableCell>
                        <TableCell>{row.requester_location_name}</TableCell>
                        <TableCell>
                          <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                            {REPLENISHMENT_STATUS_LABELS[row.status]}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Widget: stock table (filtered to central warehouse).
// ---------------------------------------------------------------------------

function CentralStockPanel({
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
            <Warehouse className="size-4 text-muted-foreground" aria-hidden="true" />
            Markaziy sklad qoldig'i
          </h2>
          <p className="text-xs text-muted-foreground">
            Markaziy sklad bo'yicha jami qoldiq.
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
                <TableHead className="text-right">Min / Max</TableHead>
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
                      {formatQty(r.min_level)} / {formatQty(r.max_level)}
                    </TableCell>
                    <TableCell>
                      {isLow ? (
                        <Badge variant="danger">Min'dan past</Badge>
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

