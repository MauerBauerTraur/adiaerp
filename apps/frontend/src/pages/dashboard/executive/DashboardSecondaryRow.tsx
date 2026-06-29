import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { SalesChart } from '../SalesChart';
import { ForecastsPanel } from '../ForecastsPanel';
import { OpenRequestsChart } from '../OpenRequestsChart';
import { PosterStatusCard } from '../PosterStatusCard';
import type {
  DashboardEcosystem,
  DashboardOverview,
  DashboardProductionPlanItem,
  ReplenishmentStatus,
} from '@/lib/types';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatQty } from '@/lib/format';
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList, Factory } from 'lucide-react';

/**
 * F4.7 — Below-the-fold detail row for the executive dashboard.
 *
 * Reuses the existing widgets in a single vertical stack so the boshliq
 * can drill from the executive hero into the operations widgets without
 * leaving the page. `RecentMovementsPanel` is intentionally excluded —
 * the boshliq does not need an audit ledger here (F4.7 spec).
 */
export function DashboardSecondaryRow({
  overview,
  ecosystem,
  onSynced,
}: {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
  onSynced?: () => void;
}) {
  return (
    <div className="space-y-6">
      {ecosystem !== null && (
        <SalesChart points={ecosystem.sales_chart.days} />
      )}

      <ForecastsPanel />

      <ProductionPlanPanel items={overview.production_plan} />

      <div className="grid gap-6 xl:grid-cols-2">
        <PosterStatusCard status={ecosystem?.poster_status ?? null} onSynced={onSynced} />
        <OpenRequestsPanel overview={overview} />
      </div>
    </div>
  );
}

function ProductionPlanPanel({
  items,
}: {
  items: DashboardProductionPlanItem[];
}) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Factory className="size-4 text-primary" aria-hidden="true" />
            Bugungi ishlab chiqarish rejasi
          </h2>
          <p className="text-xs text-muted-foreground">
            Faol va muddati o‘tgan zayafkalar.
          </p>
        </div>
        <Link
          to="/production-orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Hammasi
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>
      {items.length === 0 ? (
        <EmptyState message="Bugungi reja bo‘sh." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Muddat</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead>Bo‘g‘in</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>
                  <span className="sr-only">Manzil</span>
                  <ClipboardList
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">
                    {row.deadline ?? '—'}
                  </TableCell>
                  <TableCell className="font-medium">
                    {row.product_name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.location_name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(row.qty)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={PRODUCTION_ORDER_STATUS_VARIANT[row.status]}
                    >
                      {PRODUCTION_ORDER_STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.target_location_name ?? '—'}
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

function OpenRequestsPanel({ overview }: { overview: DashboardOverview }) {
  const entries = Object.entries(overview.open_requests.by_status) as [
    ReplenishmentStatus,
    number,
  ][];
  const total = overview.open_requests.total;
  return (
    <Card className="flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Ochiq so‘rovlar — status</h2>
          <p className="text-xs text-muted-foreground">
            Holat bo‘yicha guruhlangan ochiq to‘ldirish so‘rovlari.
          </p>
        </div>
        <Link
          to="/replenishment"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          So‘rovlar
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>
      <div className="flex flex-1 flex-col gap-4 p-5">
        {total === 0 ? (
          <EmptyState message="Ochiq so‘rovlar yo‘q." />
        ) : (
          <OpenRequestsChart entries={entries} total={total} />
        )}
      </div>
    </Card>
  );
}
