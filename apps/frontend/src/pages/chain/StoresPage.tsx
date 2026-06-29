import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  RefreshCw,
  ShoppingBag,
  Store,
  TrendingUp,
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
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_LABELS,
} from '@/lib/labels';
import { ChainLayerLayout, type ChainKpi } from './ChainLayerLayout';
import type {
  ChainLayerLocation,
  ChainLayerOverview,
  ReplenishmentRequest,
  SaleRow,
  SalesResponse,
  StockRow,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.6 — `/stores` chain-layer screen.
 *
 * RBAC: `pm`, `store_manager`, `central_warehouse_manager` (read-only
 * for the latter; the route guard already enforces this).
 *
 * Each store card carries today's sales count + top-3 products. The
 * widgets surface open replenishment requests originating from stores
 * and an aggregate "top sold today" table sourced from `/api/sales`.
 */
const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

export function StoresPage() {
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/store',
  );
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=store',
  );
  const today = TODAY_ISO();
  // `/api/sales` returns the paginated envelope `{items, total, limit, offset}`,
  // so unwrap `.items` before treating it as a SaleRow[].
  const sales = useApiQuery<SalesResponse>(
    `/api/sales?from=${today}&to=${today}&limit=200`,
  );
  const replen = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Do‘konlar"
          description="Do‘konlar qoldig‘i, bugungi savdo va to‘ldirish so‘rovlari."
        />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Do‘konlar"
          description="Do‘konlar qoldig‘i, bugungi savdo va to‘ldirish so‘rovlari."
        />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null) return null;

  const { totals, locations, recent_movements } = overview.data;
  const allSales: SaleRow[] = sales.data?.items ?? [];
  const allReplen = replen.data ?? [];
  const openStoreReplen = allReplen.filter(
    (r) =>
      !TERMINAL_REPLENISHMENT_STATUSES.includes(r.status) &&
      locations.some((loc) => loc.id === r.requester_location_id),
  );

  // Aggregate today's sales by product (qty + sale count).
  const aggregated = aggregateSalesByProduct(allSales);
  const totalSalesQty = allSales.reduce((sum, row) => sum + row.qty, 0);
  const totalSalesCount = allSales.length;

  // Sales scoped per-store for the card top-3.
  const salesByStore = new Map<number, SaleRow[]>();
  for (const sale of allSales) {
    const bucket = salesByStore.get(sale.store_id) ?? [];
    bucket.push(sale);
    salesByStore.set(sale.store_id, bucket);
  }

  const kpis: ChainKpi[] = [
    {
      label: 'Do‘konlar',
      value: totals.total_locations,
      icon: Store,
      tone: 'accent',
      hint: `${formatQty(totals.total_products)} ta mahsulot`,
    },
    {
      label: 'Min’dan past',
      value: totals.below_min_count,
      icon: AlertTriangle,
      tone: totals.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: totals.below_min_count > 0
        ? 'Tezda to‘ldirish kerak'
        : 'Hammasi me’yorda',
    },
    {
      label: 'Bugungi savdo',
      value: totals.sales_today_count ?? totalSalesCount,
      icon: ShoppingBag,
      tone: 'accent',
      hint: `${formatQty(totalSalesQty)} dona/kg/l`,
    },
    {
      label: 'Ochiq so‘rovlar',
      value: totals.open_requests_count,
      icon: RefreshCw,
      tone: totals.open_requests_count > 0 ? 'amber' : 'neutral',
      hint: 'To‘ldirish kutilmoqda',
    },
  ];

  return (
    <ChainLayerLayout
      layerType="store"
      title="Do‘konlar"
      description="Do‘konlar qoldig‘i, bugungi savdo va to‘ldirish so‘rovlari."
      totals={totals}
      kpis={kpis}
      locations={locations}
      recentMovements={recent_movements}
      renderLocationCard={(location) => (
        <StoreCard
          location={location}
          sales={salesByStore.get(location.id) ?? []}
        />
      )}
      widgets={
        <div className="space-y-6">
          <OpenStoreReplenishmentPanel
            rows={openStoreReplen}
            isLoading={replen.isLoading}
            error={replen.error}
            onRetry={replen.refetch}
          />
          <TopSalesPanel
            aggregated={aggregated}
            isLoading={sales.isLoading}
            error={sales.error}
            onRetry={sales.refetch}
          />
          <StoreStockPanel
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
// Per-store card (overrides the default location card).
// ---------------------------------------------------------------------------

function StoreCard({
  location,
  sales,
}: {
  location: ChainLayerLocation;
  sales: SaleRow[];
}) {
  const top3 = aggregateSalesByProduct(sales).slice(0, 3);
  const salesQty = sales.reduce((sum, s) => sum + s.qty, 0);
  const hasDanger = location.below_min_count > 0;

  return (
    <Card
      className={cn(
        'p-4 flex flex-col gap-3',
        hasDanger ? 'ring-1 ring-destructive/30' : 'ring-1 ring-primary/30',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary"
        >
          <Store className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{location.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatQty(location.total_products)} ta mahsulot
          </p>
        </div>
        {hasDanger && (
          <Badge variant="danger" className="shrink-0">
            {formatQty(location.below_min_count)}
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-border/40 bg-background/40 p-2">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Bugungi savdo
          </dt>
          <dd className="mt-0.5 text-base tabular-nums leading-none">
            {formatQty(sales.length)}
            <span className="ml-1 text-[10px] text-muted-foreground">chek</span>
          </dd>
        </div>
        <div className="rounded-md border border-border/40 bg-background/40 p-2">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Sotilgan jami
          </dt>
          <dd className="mt-0.5 text-base tabular-nums leading-none">
            {formatQty(salesQty)}
          </dd>
        </div>
      </dl>

      {top3.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Bugungi top 3
          </p>
          <ol className="space-y-1">
            {top3.map((item, idx) => (
              <li
                key={item.product_id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="flex items-center gap-2 truncate">
                  <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="truncate font-medium">{item.product_name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatQty(item.qty)} {UNIT_LABELS[item.product_unit]}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Aggregate sales rows by product.
// ---------------------------------------------------------------------------

interface AggregatedSale {
  product_id: number;
  product_name: string;
  product_unit: SaleRow['product_unit'];
  qty: number;
  count: number;
  total: number;
}

function aggregateSalesByProduct(rows: SaleRow[]): AggregatedSale[] {
  const map = new Map<number, AggregatedSale>();
  for (const row of rows) {
    // Backend `/api/sales` rows carry unit `price`, not a line total — the
    // aggregate `total` (revenue) is `qty * price` summed per product.
    const lineTotal = row.qty * row.price;
    const existing = map.get(row.product_id);
    if (existing) {
      existing.qty += row.qty;
      existing.count += 1;
      existing.total += lineTotal;
    } else {
      map.set(row.product_id, {
        product_id: row.product_id,
        product_name: row.product_name,
        product_unit: row.product_unit,
        qty: row.qty,
        count: 1,
        total: lineTotal,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.qty - a.qty);
}

// ---------------------------------------------------------------------------
// Widget: open replenishment requests originating from stores.
// ---------------------------------------------------------------------------

function OpenStoreReplenishmentPanel({
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
            <RefreshCw className="size-4 text-primary" aria-hidden="true" />
            To‘ldirish kerak
          </h2>
          <p className="text-xs text-muted-foreground">
            Do‘konlardan tarqalgan ochiq to‘ldirish so‘rovlari.
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
        <EmptyState message="Hozircha ochiq so‘rovlar yo‘q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Do‘kon</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
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
                  <TableCell>{row.requester_location_name}</TableCell>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(row.qty_needed)} {UNIT_LABELS[row.product_unit]}
                  </TableCell>
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
// Widget: today's top-sold products across all stores.
// ---------------------------------------------------------------------------

function TopSalesPanel({
  aggregated,
  isLoading,
  error,
  onRetry,
}: {
  aggregated: AggregatedSale[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const top = aggregated.slice(0, 10);
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <TrendingUp className="size-4 text-primary" aria-hidden="true" />
            Bugungi top sotuv
          </h2>
          <p className="text-xs text-muted-foreground">
            Barcha do‘konlar bo‘yicha eng ko‘p sotilgan 10 ta mahsulot
            (Poster POS ma’lumotlari).
          </p>
        </div>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && top.length === 0 && (
        <EmptyState message="Bugun savdo yo‘q." />
      )}
      {!isLoading && !error && top.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Sotilgan miqdor</TableHead>
                <TableHead className="text-right">Chek soni</TableHead>
                <TableHead className="text-right">Summa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((item) => (
                <TableRow key={item.product_id}>
                  <TableCell className="font-medium">{item.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(item.qty)} {UNIT_LABELS[item.product_unit]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatQty(item.count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(item.total)}
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
// Widget: stock table (filtered to stores).
// ---------------------------------------------------------------------------

function StoreStockPanel({
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
            Do‘konlar qoldig‘i
          </h2>
          <p className="text-xs text-muted-foreground">
            Barcha do‘konlar bo‘yicha jami qoldiq.
          </p>
        </div>
        <Link to="/stock" className="text-xs font-medium text-primary hover:underline">
          To‘liq ko‘rish
        </Link>
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
