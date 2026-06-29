import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import type {
  ChainSummaryNode,
  DashboardEcosystem,
  DashboardOverview,
  LocationType,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { useHeaderSlot } from '@/components/layout/HeaderSlot';
import { DashboardHeaderSlot } from './DashboardHeaderSlot';
import { HeroStrip } from './HeroStrip';
import { ChainHealthRow } from './ChainHealthRow';
import { CriticalAlerts } from './CriticalAlerts';
import { MyActionsList } from './MyActionsList';
import { ProductionPlanSummary } from './ProductionPlanSummary';
import { DashboardSecondaryRow } from './DashboardSecondaryRow';
import { ChainDetailSheet } from './ChainDetailSheet';
import { RevenueBreakdown } from './RevenueBreakdown';
import { PosterStatusCard } from '../PosterStatusCard';

// Stable empty fallback so a missing `ecosystem.data` doesn't churn the
// ChainHealthRow memo by allocating a fresh `[]` on every render.
const EMPTY_CHAIN_SUMMARY: ChainSummaryNode[] = [];

/**
 * Executive dashboard — insight-first redesign (2026-05).
 *
 * The previous version centred a React-Flow node graph of the whole
 * ecosystem; it degraded badly as locations multiplied (crossing edges,
 * overlap, nothing scannable). It is gone. The first view is now built
 * around answers, not topology:
 *
 *   1. HeaderSlot         — greeting + date-range filter (layout-owned)
 *   2. HeroStrip          — 4 clickable KPI cards (revenue / receipts /
 *                           active requests / critical positions)
 *   3. ChainHealthRow     — five scannable stage cards (replaces the
 *                           canvas; scales as locations grow), click →
 *                           per-stage detail drawer
 *   4. Action row         — CriticalAlerts + MyActionsList (the approval
 *                           queue) + today's production digest
 *   5. RevenueBreakdown   — today's revenue split
 *   6. SecondaryRowGuard  — 30-day sales chart, forecasts, full plan /
 *                           open-requests tables (below the fold)
 *
 * Auto-refresh: 30 s while the tab is visible. The page is the only
 * place that knows the polling cadence — every child reads the snapshot.
 */
export function ExecutiveDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [range, setRange] = useState<DateRangeValue>({ range: 'today' });
  const [selectedChain, setSelectedChain] = useState<LocationType | null>(null);
  const rangeQuery = dateRangeToQuery(range);

  const overview = useApiQuery<DashboardOverview>(
    `/api/dashboard/overview?${rangeQuery}`,
  );
  const ecosystem = useApiQuery<DashboardEcosystem>(
    `/api/dashboard/ecosystem?${rangeQuery}`,
  );
  const purchaseOrders = useApiQuery<PurchaseOrder[]>(
    '/api/purchase-orders?status=draft',
  );
  // NEW replenishment requests are part of the boshliq's queue too; the
  // backend RBAC-scopes the list to what they can act on.
  const replenishments = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=NEW',
  );

  const overviewRefetch = overview.refetch;
  const ecosystemRefetch = ecosystem.refetch;
  const purchaseOrdersRefetch = purchaseOrders.refetch;
  const replenishmentsRefetch = replenishments.refetch;
  useEffect(() => {
    const REFRESH_MS = 30_000;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (!document.hidden) {
          overviewRefetch();
          ecosystemRefetch();
          purchaseOrdersRefetch();
          replenishmentsRefetch();
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
  }, [
    overviewRefetch,
    ecosystemRefetch,
    purchaseOrdersRefetch,
    replenishmentsRefetch,
  ]);

  const userName = user?.name ?? 'Foydalanuvchi';
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  useHeaderSlot(
    <DashboardHeaderSlot
      userName={userName}
      isoDate={today}
      range={range}
      onRangeChange={setRange}
    />,
  );

  const handleChainSelect = useCallback((next: LocationType | null) => {
    setSelectedChain(next);
  }, []);

  // Stabilise the chain_summary reference across 30s refetches: each
  // refetch re-parses JSON and produces a new array even when the payload
  // is byte-identical. Without content equality the ChainHealthRow memo
  // invalidates on every tick. Keep the previous snapshot when its JSON
  // serialisation matches.
  const chainSummary = ecosystem.data?.chain_summary ?? EMPTY_CHAIN_SUMMARY;
  const chainSummaryStableRef = useRef<ChainSummaryNode[]>(chainSummary);
  const chainSummaryStable = useMemo(() => {
    const prev = chainSummaryStableRef.current;
    if (
      prev !== chainSummary &&
      JSON.stringify(prev) === JSON.stringify(chainSummary)
    ) {
      return prev;
    }
    chainSummaryStableRef.current = chainSummary;
    return chainSummary;
  }, [chainSummary]);

  // Initial-load skeleton — overview is the keystone request.
  if (overview.isLoading && overview.data === null) {
    return <LoadingState />;
  }

  if (overview.error && overview.data === null) {
    return <ErrorState message={overview.error} onRetry={overview.refetch} />;
  }

  if (overview.data === null) {
    return null;
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <HeroStrip
        overview={overview.data}
        ecosystem={ecosystem.data}
        range={range}
        onNavigate={navigate}
      />

      <ChainHealthRow
        chainSummary={chainSummaryStable}
        selectedChain={selectedChain}
        onSelectChain={handleChainSelect}
      />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-12">
        <CriticalAlerts
          belowMin={overview.data.below_min}
          alerts={ecosystem.data?.alerts_feed ?? []}
          criticalCount={overview.data.kpis.below_min_count}
          className="xl:col-span-5"
        />
        <MyActionsList
          purchaseOrders={purchaseOrders.data ?? []}
          replenishments={replenishments.data ?? []}
          className="xl:col-span-4"
        />
        <ProductionPlanSummary
          items={overview.data.production_plan}
          className="xl:col-span-3"
        />
      </div>

      <RevenueBreakdown
        isoDate={today}
        fallbackTotal={ecosystem.data?.poster_status?.sales_today_sum ?? 0}
        range={range.range}
      />

      <PosterStatusCard
        status={ecosystem.data?.poster_status ?? null}
        onSynced={ecosystemRefetch}
      />

      <SecondaryRowGuard overview={overview.data} ecosystem={ecosystem.data} />

      <ChainDetailSheet
        type={selectedChain}
        range={range}
        onClose={() => setSelectedChain(null)}
      />
    </div>
  );
}

function SecondaryRowGuard({
  overview,
  ecosystem,
}: {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
}) {
  const isEmpty =
    overview.kpis.total_open_requests === 0 &&
    overview.kpis.below_min_count === 0 &&
    overview.kpis.active_production_orders === 0 &&
    overview.kpis.pending_approvals === 0 &&
    overview.production_plan.length === 0;

  if (isEmpty) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Hozircha kuzatish uchun ma’lumot yo’q.
      </Card>
    );
  }
  return <DashboardSecondaryRow overview={overview} ecosystem={ecosystem} />;
}
