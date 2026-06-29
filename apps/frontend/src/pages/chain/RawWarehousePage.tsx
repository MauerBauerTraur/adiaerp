import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Loader2,
  Package,
  RefreshCw,
  ShoppingCart,
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
import { UNIT_LABELS } from '@/lib/labels';
import type {
  ChainKpi,
} from './ChainLayerLayout';
import { ChainLayerLayout } from './ChainLayerLayout';
import type {
  ChainLayerOverview,
  PurchaseOrder,
  StockRow,
} from '@/lib/types';

/**
 * F4.6 — `/raw-warehouse` chain-layer screen.
 *
 * RBAC: `pm`, `raw_warehouse_manager` (route-guarded by `AppRouter`).
 *
 * Composes:
 *   - the shared `ChainLayerLayout` (header + 4-card KPI strip +
 *     locations grid + recent movements);
 *   - two layer-specific widgets:
 *       · "Sotib olish — qabul kutilmoqda" — approved purchase orders
 *         waiting for receipt; one-click receive (`POST /:id/receive`);
 *       · "Yetishmovchilik xulosa" — top 10 raw items where qty ≤ min;
 *   - a stock-rows table filtered to raw warehouse locations.
 */
export function RawWarehousePage() {
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/raw_warehouse',
  );
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=raw_warehouse',
  );
  const incomingPurchases = useApiQuery<PurchaseOrder[]>(
    '/api/purchase-orders?status=approved',
  );

  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Xom-ashyo ombori"
          description="Xom-ashyo qoldig‘i, qabul kutilayotgan sotib olish va min’dan past pozitsiyalar."
        />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Xom-ashyo ombori"
          description="Xom-ashyo qoldig‘i, qabul kutilayotgan sotib olish va min’dan past pozitsiyalar."
        />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null) return null;

  const { totals, locations, recent_movements } = overview.data;
  const rows = stock.data ?? [];
  const belowMinRows = rows
    .filter((r) => r.qty <= r.min_level)
    .sort((a, b) => a.qty / Math.max(a.min_level, 1) - b.qty / Math.max(b.min_level, 1))
    .slice(0, 10);

  const kpis: ChainKpi[] = [
    {
      label: 'Xom-ashyo turlari',
      value: totals.total_products,
      icon: Boxes,
      tone: 'accent',
      hint: `${formatQty(totals.total_locations)} ta omborda`,
    },
    {
      label: 'Min’dan past',
      value: totals.below_min_count,
      icon: AlertTriangle,
      tone: totals.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: totals.below_min_count > 0
        ? 'Darhol to‘ldirish kerak'
        : 'Hammasi me’yorda',
    },
    {
      label: 'Ochiq to‘ldirish so‘rovlari',
      value: totals.open_requests_count,
      icon: RefreshCw,
      tone: totals.open_requests_count > 0 ? 'amber' : 'neutral',
      hint: 'Bo‘g‘in bo‘yicha jami',
    },
    {
      label: 'Qabul kutilmoqda',
      value: incomingPurchases.data?.length ?? 0,
      icon: ShoppingCart,
      tone: (incomingPurchases.data?.length ?? 0) > 0 ? 'accent' : 'neutral',
      hint: 'Tasdiqlangan sotib olish',
    },
  ];

  return (
    <>
      <ChainLayerLayout
        layerType="raw_warehouse"
        title="Xom-ashyo ombori"
        description="Xom-ashyo qoldig‘i, qabul kutilayotgan sotib olish va min’dan past pozitsiyalar."
        totals={totals}
        kpis={kpis}
        locations={locations}
        recentMovements={recent_movements}
        widgets={
          <div className="space-y-6">
            <IncomingPurchasesPanel
              rows={incomingPurchases.data ?? []}
              isLoading={incomingPurchases.isLoading}
              error={incomingPurchases.error}
              onRetry={incomingPurchases.refetch}
              onReceived={() => {
                overview.refetch();
                stock.refetch();
                incomingPurchases.refetch();
              }}
            />
            <ShortagesPanel rows={belowMinRows} />
            <StockTablePanel
              rows={rows}
              isLoading={stock.isLoading}
              error={stock.error}
              onRetry={stock.refetch}
            />
          </div>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Widget: incoming purchases (approved, awaiting receipt).
// ---------------------------------------------------------------------------

function IncomingPurchasesPanel({
  rows,
  isLoading,
  error,
  onRetry,
  onReceived,
}: {
  rows: PurchaseOrder[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onReceived: () => void;
}) {
  const { notify } = useToast();
  const { canActOn } = useCanAct();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function receive(id: number) {
    setBusyId(id);
    try {
      await apiRequest(`/api/purchase-orders/${id}/receive`, { method: 'POST' });
      notify('success', 'Sotib olish qabul qilindi va omborga kirim qilindi.');
      onReceived();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul amalga oshmadi.',
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
            <ShoppingCart className="size-4 text-primary" aria-hidden="true" />
            Sotib olish — qabul kutilmoqda
          </h2>
          <p className="text-xs text-muted-foreground">
            Tasdiqlangan sotib olish so‘rovlari xom-ashyo omboriga kirim qilinishi
            kutilmoqda.
          </p>
        </div>
        <Link
          to="/purchase-orders"
          className="text-xs font-medium text-primary hover:underline"
        >
          Hammasini ko‘rish
        </Link>
      </header>
      {isLoading && <LoadingState />}
      {!isLoading && error && <ErrorState message={error} onRetry={onRetry} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState message="Qabul kutilayotgan sotib olish so‘rovlari yo‘q." />
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Manzil ombor</TableHead>
                <TableHead>Yetkazib beruvchi</TableHead>
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
                  <TableCell>{row.target_location_name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.supplier_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {canActOn(row.target_location_id) ? (
                      <Button
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => receive(row.id)}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="size-4" aria-hidden="true" />
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
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Widget: shortages summary (top-10 below-min raw rows).
// ---------------------------------------------------------------------------

function ShortagesPanel({ rows }: { rows: StockRow[] }) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
            Yetishmovchilik xulosa
          </h2>
          <p className="text-xs text-muted-foreground">
            Eng kritik 10 ta xom-ashyo pozitsiyasi (min’dan past).
          </p>
        </div>
        <Badge variant={rows.length > 0 ? 'danger' : 'success'}>
          {formatQty(rows.length)}
        </Badge>
      </header>
      {rows.length === 0 ? (
        <EmptyState message="Min’dan past pozitsiyalar yo‘q — hammasi me’yorda." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Qoldiq</TableHead>
                <TableHead className="text-right">Min</TableHead>
                <TableHead className="text-right">Max</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={`${r.location_id}-${r.product_id}`}
                  className="bg-destructive/5 hover:bg-destructive/10"
                >
                  <TableCell className="font-medium">{r.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold text-destructive">
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
// Widget: stock table (filtered to raw warehouses).
// ---------------------------------------------------------------------------

function StockTablePanel({
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
            <Package className="size-4 text-muted-foreground" aria-hidden="true" />
            Qoldiq jadvali
          </h2>
          <p className="text-xs text-muted-foreground">
            Xom-ashyo omborlari bo‘yicha jami qoldiq.
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
                <TableHead className="text-right">Min</TableHead>
                <TableHead className="text-right">Max</TableHead>
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
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatQty(r.max_level)}
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
