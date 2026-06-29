import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  Factory,
  RefreshCw,
  ShieldCheck,
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
  MOVEMENT_REASON_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_LABELS,
} from '@/lib/labels';
import type {
  DashboardEcosystem,
  DashboardOverview,
  ReplenishmentStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { OpenRequestsChart } from './OpenRequestsChart';
import { ForecastsPanel } from './ForecastsPanel';
import { SalesChart } from './SalesChart';

/**
 * M8 — Boshqaruv paneli (phase-1-mvp.md §2.8, §4.8).
 *
 * Reads `GET /api/dashboard/overview` (RBAC-scoped by the backend) and
 * renders:
 *   - 4-card KPI strip (total open requests, below-min count, active
 *     production orders, pending purchase approvals).
 *   - A two-column block: below-min stock table (left) and an
 *     open-requests-by-status chart (right).
 *   - Today's production plan table.
 *   - The 20 most-recent stock movements as a feed.
 *
 * Auto-refresh: a hidden 30 s `setInterval` calls `refetch`; the timer
 * is paused while the tab is hidden (`document.hidden`) so a background
 * tab never thrashes the backend.
 */
export function DashboardPage() {
  const { data, isLoading, error, refetch } = useApiQuery<DashboardOverview>(
    '/api/dashboard/overview',
  );
  const ecosystem = useApiQuery<DashboardEcosystem>(
    '/api/dashboard/ecosystem',
  );

  // Auto-refresh — 30 s when the tab is visible, paused when hidden.
  // The ecosystem widgets share the same cadence as the overview.
  useEffect(() => {
    const REFRESH_MS = 30_000;
    let timer: number | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (!document.hidden) {
          refetch();
          ecosystem.refetch();
        }
      }, REFRESH_MS);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    if (!document.hidden) start();
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refetch, ecosystem.refetch]);

  if (isLoading && data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Boshqaruv paneli"
          description="Butun zanjir holati, ogohlantirishlar va kunlik reja."
        />
        <LoadingState />
      </div>
    );
  }

  if (error && data === null) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Boshqaruv paneli"
          description="Butun zanjir holati, ogohlantirishlar va kunlik reja."
        />
        <ErrorState message={error} onRetry={refetch} />
      </div>
    );
  }

  if (data === null) {
    return null;
  }

  const isEmpty =
    data.kpis.total_open_requests === 0 &&
    data.kpis.below_min_count === 0 &&
    data.kpis.active_production_orders === 0 &&
    data.kpis.pending_approvals === 0 &&
    data.recent_movements.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Boshqaruv paneli"
        description="Butun zanjir holati, ogohlantirishlar va kunlik reja."
      />

      <KpiStrip overview={data} />

      {isEmpty ? (
        <Card className="p-6">
          <EmptyState message="Hozircha kuzatish uchun ma’lumot yo‘q." />
        </Card>
      ) : (
        <>
          <div className="space-y-6">
            <BelowMinPanel overview={data} />
            <OpenRequestsPanel overview={data} />
          </div>

          {ecosystem.data !== null && (
            <SalesChart points={ecosystem.data.sales_chart.days} />
          )}

          <ForecastsPanel />

          <ProductionPlanPanel overview={data} />

          <RecentMovementsPanel overview={data} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

interface KpiCardData {
  label: string;
  value: number;
  icon: typeof RefreshCw;
  tone: 'neutral' | 'amber' | 'destructive';
  hint?: string;
}

function KpiStrip({ overview }: { overview: DashboardOverview }) {
  const { kpis } = overview;
  const oldestHint =
    overview.open_requests.oldest_created_at !== null
      ? `Eng eski: ${formatDateTime(overview.open_requests.oldest_created_at)}`
      : undefined;

  const cards: KpiCardData[] = [
    {
      label: 'Ochiq to‘ldirish so‘rovlari',
      value: kpis.total_open_requests,
      icon: RefreshCw,
      tone: 'neutral',
      hint: oldestHint,
    },
    {
      label: 'Min’dan tushgan pozitsiyalar',
      value: kpis.below_min_count,
      icon: AlertTriangle,
      tone: kpis.below_min_count > 0 ? 'destructive' : 'neutral',
      hint: kpis.below_min_count > 0 ? 'Darhol ko‘rib chiqilsin' : 'Hammasi me’yorda',
    },
    {
      label: 'Faol ishlab chiqarish',
      value: kpis.active_production_orders,
      icon: Factory,
      tone: kpis.active_production_orders > 0 ? 'amber' : 'neutral',
      hint: 'Yangi yoki jarayonda',
    },
    {
      label: 'Tasdiqlash kutmoqda',
      value: kpis.pending_approvals,
      icon: ShieldCheck,
      tone: kpis.pending_approvals > 0 ? 'amber' : 'neutral',
      hint: 'Loyiha sotib olish so‘rovlari',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <KpiCard key={card.label} card={card} />
      ))}
    </div>
  );
}

function KpiCard({ card }: { card: KpiCardData }) {
  const Icon = card.icon;
  const toneRing =
    card.tone === 'destructive'
      ? 'ring-1 ring-destructive/30'
      : card.tone === 'amber'
        ? 'ring-1 ring-primary/30'
        : '';
  const iconWrap =
    card.tone === 'destructive'
      ? 'bg-destructive/15 text-destructive'
      : card.tone === 'amber'
        ? 'bg-primary/15 text-primary'
        : 'bg-muted text-muted-foreground';
  const numberTone =
    card.tone === 'destructive'
      ? 'text-destructive'
      : card.tone === 'amber'
        ? 'text-primary'
        : 'text-foreground';

  return (
    <Card className={cn('p-5', toneRing)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {card.label}
          </p>
          <p
            className={cn(
              'text-3xl font-semibold tabular-nums leading-none',
              numberTone,
            )}
          >
            {formatQty(card.value)}
          </p>
          {card.hint && (
            <p className="text-xs text-muted-foreground">{card.hint}</p>
          )}
        </div>
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-md',
            iconWrap,
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Below-min panel
// ---------------------------------------------------------------------------

const BELOW_MIN_PREVIEW = 10;

function BelowMinPanel({
  overview,
  className,
}: {
  overview: DashboardOverview;
  className?: string;
}) {
  const items = overview.below_min;
  const preview = items.slice(0, BELOW_MIN_PREVIEW);
  const overflow = items.length - preview.length;

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Min’dan tushgan pozitsiyalar</h2>
          <p className="text-xs text-muted-foreground">
            Avtomatik to‘ldirish tsikli ushbu pozitsiyalar bo‘yicha ishlaydi.
          </p>
        </div>
        <Link
          to="/stock"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Barchasini ko‘rish
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>
      <div className="flex-1">
        {items.length === 0 ? (
          <EmptyState message="Min’dan tushgan pozitsiyalar yo‘q." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  <TableHead>Bo‘g‘in</TableHead>
                  <TableHead className="text-right">Qoldiq / min / max</TableHead>
                  <TableHead>So‘rov</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row) => (
                  <BelowMinRow key={`${row.location_id}-${row.product_id}`} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      {overflow > 0 && (
        <footer className="border-t border-border/60 p-3 text-center text-xs text-muted-foreground">
          Yana {formatQty(overflow)} ta pozitsiya —{' '}
          <Link to="/stock" className="font-medium text-primary hover:underline">
            barchasini ko‘rish
          </Link>
        </footer>
      )}
    </Card>
  );
}

function BelowMinRow({
  row,
}: {
  row: DashboardOverview['below_min'][number];
}) {
  const unit = UNIT_LABELS[row.product_unit];
  return (
    <TableRow>
      <TableCell className="font-medium">{row.product_name}</TableCell>
      <TableCell className="text-muted-foreground">{row.location_name}</TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-semibold text-destructive">
          {formatQty(row.qty)} {unit}
        </span>
        <span className="text-muted-foreground">
          {' '}
          / {formatQty(row.min_level)} / {formatQty(row.max_level)}
        </span>
      </TableCell>
      <TableCell>
        {row.open_request_status !== null && row.open_request_id !== null ? (
          <Link
            to={`/replenishment/${row.open_request_id}`}
            className="inline-block"
          >
            <Badge
              variant={REPLENISHMENT_STATUS_VARIANT[row.open_request_status]}
            >
              {REPLENISHMENT_STATUS_LABELS[row.open_request_status]}
            </Badge>
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Open-requests chart panel
// ---------------------------------------------------------------------------

function OpenRequestsPanel({
  overview,
  className,
}: {
  overview: DashboardOverview;
  className?: string;
}) {
  const entries = Object.entries(overview.open_requests.by_status) as [
    ReplenishmentStatus,
    number,
  ][];
  const total = overview.open_requests.total;

  return (
    <Card className={cn('flex flex-col', className)}>
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

// ---------------------------------------------------------------------------
// Production plan panel
// ---------------------------------------------------------------------------

function ProductionPlanPanel({ overview }: { overview: DashboardOverview }) {
  const items = overview.production_plan;
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Bugungi ishlab chiqarish rejasi</h2>
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
                  <ClipboardList className="size-4 text-muted-foreground" aria-label="Manzil" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">
                    {row.deadline ?? '—'}
                  </TableCell>
                  <TableCell className="font-medium">{row.product_name}</TableCell>
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

// ---------------------------------------------------------------------------
// Recent movements feed
// ---------------------------------------------------------------------------

function RecentMovementsPanel({ overview }: { overview: DashboardOverview }) {
  const items = overview.recent_movements;
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Oxirgi harakatlar</h2>
          <p className="text-xs text-muted-foreground">
            So‘nggi {Math.min(items.length, 20)} ta ombor harakati.
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <EmptyState message="Harakatlar yo‘q." />
      ) : (
        <ol className="divide-y divide-border/60">
          {items.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{m.product_name}</span>
                <span className="text-xs text-muted-foreground">
                  {(m.from_location_name ?? '—')}
                  {' → '}
                  {(m.to_location_name ?? '—')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <span className="tabular-nums font-semibold">
                  {formatQty(m.qty)} {UNIT_LABELS[m.product_unit]}
                </span>
                <Badge variant="outline" className="font-normal">
                  {MOVEMENT_REASON_LABELS[m.reason]}
                </Badge>
                <span className="hidden text-xs text-muted-foreground sm:inline tabular-nums">
                  {formatDateTime(m.created_at)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
