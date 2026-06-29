import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  Inbox,
  PackageCheck,
  Truck,
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
 * F4.6 — `/supply` chain-layer screen ("Sex skladlari").
 *
 * Renamed from "Ta'minot" — the layer is now "Sex skladi" (Tort skladi,
 * Perojniy skladi, Yarim Fabrika skladi). The `/supply` URL is kept so
 * external bookmarks keep working; the route label and on-page copy now
 * read "Sex skladlari". The backend ENUM is migrating from `supply` to
 * `sex_storage` — this page calls `chain-layer/supply` until the API
 * flips, then will switch via a single string change.
 *
 * RBAC: `pm`, `supply_manager` (role enum key unchanged).
 *
 * Layer-specific widgets:
 *   - "Jo'natmaga tayyor" — semi/finished products held by sex storages
 *     that have qty > 0 (ready to ship to central warehouse).
 *   - "Replenishment so'rovlari" — open replenishment requests routed
 *     through this layer (status=CHECK_STORE_SUPPLIER and similar).
 *   - Stock table (filtered to sex-storage locations).
 */
export function SupplyPage() {
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/supply',
  );
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=supply',
  );
  const checkRequests = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=CHECK_STORE_SUPPLIER',
  );

  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Sex skladlari"
          description="Sex skladlari — Tort skladi, Perojniy skladi, Yarim Fabrika skladi va kelayotgan so‘rovlar."
        />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Sex skladlari"
          description="Sex skladlari — Tort skladi, Perojniy skladi, Yarim Fabrika skladi va kelayotgan so‘rovlar."
        />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null) return null;

  const { totals, locations, recent_movements } = overview.data;
  const rows = stock.data ?? [];
  const readyToShip = rows.filter((r) => r.qty > 0);

  const kpis: ChainKpi[] = [
    {
      label: 'Sex skladlari',
      value: totals.total_locations,
      icon: Truck,
      tone: 'accent',
      hint: 'Tort skladi, Perojniy skladi, Yarim Fabrika skladi',
    },
    {
      label: 'Jo‘natmaga tayyor',
      value: totals.pending_shipments ?? readyToShip.length,
      icon: PackageCheck,
      tone: (totals.pending_shipments ?? readyToShip.length) > 0 ? 'accent' : 'neutral',
      hint: 'Markaziy skladga',
    },
    {
      label: 'Kelayotgan so‘rovlar',
      value: checkRequests.data?.length ?? 0,
      icon: Inbox,
      tone: (checkRequests.data?.length ?? 0) > 0 ? 'amber' : 'neutral',
      hint: 'Tekshiruv: sex skladi/markaziy',
    },
    {
      label: 'Min’dan past',
      value: totals.below_min_count,
      icon: AlertTriangle,
      tone: totals.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: 'Xom-ashyo yetishmovchiligi',
    },
  ];

  return (
    <ChainLayerLayout
      layerType="supply"
      title="Sex skladlari"
      description="Sex skladlari — Tort skladi, Perojniy skladi, Yarim Fabrika skladi va kelayotgan so‘rovlar."
      totals={totals}
      kpis={kpis}
      locations={locations}
      recentMovements={recent_movements}
      widgets={
        <div className="space-y-6">
          <ReadyToShipPanel rows={readyToShip} />
          <PendingReplenishmentPanel
            rows={checkRequests.data ?? []}
            isLoading={checkRequests.isLoading}
            error={checkRequests.error}
            onRetry={checkRequests.refetch}
          />
          <SupplyStockPanel
            rows={rows}
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
// Widget: ready-to-ship stock (qty>0 in supply locations).
// ---------------------------------------------------------------------------

function ReadyToShipPanel({ rows }: { rows: StockRow[] }) {
  const top = rows.slice(0, 10);
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <PackageCheck className="size-4 text-sky-300" aria-hidden="true" />
            Jo‘natmaga tayyor
          </h2>
          <p className="text-xs text-muted-foreground">
            Sex skladlarida mavjud tayyor/yarim tayyor mahsulotlar.
          </p>
        </div>
        <Badge variant="outline" className="tabular-nums">
          {formatQty(rows.length)}
        </Badge>
      </header>
      {top.length === 0 ? (
        <EmptyState message="Hozircha jo‘natmaga tayyor mahsulot yo‘q." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Mavjud qoldiq</TableHead>
                <TableHead className="text-right">Min</TableHead>
                <TableHead className="text-right">Max</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((r) => (
                <TableRow key={`${r.location_id}-${r.product_id}`}>
                  <TableCell className="font-medium">{r.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">
                    {formatQty(r.qty)} {UNIT_LABELS[r.product_unit]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatQty(r.min_level)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatQty(r.max_level)}
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
// Widget: pending replenishment in CHECK_STORE_SUPPLIER state.
// ---------------------------------------------------------------------------

function PendingReplenishmentPanel({
  rows,
  isLoading,
  error,
  onRetry,
}: {
  rows: ReplenishmentRequest[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Inbox className="size-4 text-primary" aria-hidden="true" />
            Kutmoqda — to‘ldirish so‘rovlari
          </h2>
          <p className="text-xs text-muted-foreground">
            Do‘konlardan kelgan va sex skladi tekshiruvini kutayotgan
            so‘rovlar.
          </p>
        </div>
        <Link
          to="/replenishment"
          className="text-xs font-medium text-primary hover:underline"
        >
          Hammasini ko‘rish
        </Link>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Kutilayotgan so‘rovlar yo‘q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>So‘rovchi</TableHead>
                <TableHead>Holat</TableHead>
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
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Widget: stock table (filtered to supply locations).
// ---------------------------------------------------------------------------

function SupplyStockPanel({
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
            Qoldiq jadvali
          </h2>
          <p className="text-xs text-muted-foreground">
            Sex skladlari bo‘yicha jami qoldiq.
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
