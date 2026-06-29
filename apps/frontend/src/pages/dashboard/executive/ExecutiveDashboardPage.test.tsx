/**
 * Contract test for the executive dashboard (insight-first redesign).
 *
 * Pins the mocked endpoints (overview, ecosystem, purchase orders,
 * replenishment, production detail, stores detail) to the rendered UI:
 *   • HeroStrip surfaces 4 compact KPI cards (revenue / receipts /
 *     active requests / critical positions).
 *   • ChainHealthRow renders one status card per supply-chain stage
 *     (replaces the retired React-Flow canvas).
 *   • CriticalAlerts ranks zero-stock items first.
 *   • MyActionsList surfaces draft purchase orders.
 *   • ProductionPlanSummary digests today's plan above the fold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ExecutiveDashboardPage } from './ExecutiveDashboardPage';
import type {
  DashboardEcosystem,
  DashboardOverview,
  DashboardProductionDetail,
  DashboardStoresDetail,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';

const OVERVIEW: DashboardOverview = {
  below_min: [
    {
      location_id: 7,
      location_name: 'Markaziy sklad',
      product_id: 1,
      product_name: 'Un',
      product_unit: 'kg',
      qty: 0,
      min_level: 10,
      max_level: 50,
      open_request_id: 42,
      open_request_status: 'NEW',
    },
  ],
  open_requests: {
    by_status: { NEW: 2, PRODUCING: 1 },
    total: 3,
    oldest_created_at: '2026-05-20T08:30:00.000Z',
  },
  production_plan: [
    {
      id: 501,
      product_id: 9,
      product_name: 'Pishloqli non',
      qty: 120,
      status: 'in_progress',
      location_id: 5,
      location_name: 'Sex 1',
      target_location_id: 7,
      target_location_name: 'Markaziy sklad',
      deadline: '2026-05-23',
    },
  ],
  recent_movements: [],
  kpis: {
    total_open_requests: 3,
    below_min_count: 1,
    active_production_orders: 12,
    pending_approvals: 4,
  },
};

const ECOSYSTEM: DashboardEcosystem = {
  poster_status: {
    last_sync_at: '2026-05-24T08:00:00.000Z',
    last_sync_status: 'ok',
    sync_errors_24h: 0,
    sales_today_count: 87,
    sales_today_sum: 2_400_000,
  },
  chain_flow: [
    {
      location_id: 1,
      location_name: 'Xom-ashyo',
      location_type: 'raw_warehouse',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 12,
    },
    {
      location_id: 2,
      location_name: 'Sex 1',
      location_type: 'production',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 6,
    },
    {
      location_id: 3,
      location_name: 'Ta’minot',
      location_type: 'supply',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 5,
    },
    {
      location_id: 4,
      location_name: 'Markaziy sklad',
      location_type: 'central_warehouse',
      below_min_count: 0,
      open_requests_count: 0,
      total_products: 25,
    },
    {
      location_id: 5,
      location_name: 'Do‘kon #1',
      location_type: 'store',
      below_min_count: 1,
      open_requests_count: 0,
      total_products: 18,
    },
  ],
  chain_summary: [
    {
      type: 'raw_warehouse',
      location_count: 1,
      total_products: 12,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'raw',
        received_today: 0,
        issued_today: 0,
        pending_purchase_orders: 0,
        total_qty_by_unit: [],
      },
    },
    {
      type: 'production',
      location_count: 4,
      total_products: 6,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'production',
        active_orders: 0,
        done_today: 0,
        overdue_orders: 0,
        sex_count: 4,
        input_today: 0,
        output_today: 0,
      },
    },
    {
      type: 'supply',
      location_count: 1,
      total_products: 5,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'supply',
        shipped_today: 0,
        received_today: 0,
        open_requests: 0,
        top_destination_count: 0,
      },
    },
    {
      type: 'central_warehouse',
      location_count: 26,
      total_products: 25,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'central',
        last_sync_at: '2026-05-24T08:00:00.000Z',
        last_sync_status: 'ok',
        sync_errors_24h: 0,
      },
    },
    {
      type: 'store',
      location_count: 6,
      total_products: 18,
      below_min_count: 1,
      status: 'warn',
      pulse: {
        kind: 'store',
        sales_today_sum: 2_400_000,
        receipts_today: 87,
        avg_receipt_today: 27_586,
        open_replenishments: 0,
        transit_count: 0,
        top_product_name: 'Non',
        qty_today: 0,
      },
    },
  ],
  alerts_feed: [],
  sales_chart: {
    days: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 11).padStart(2, '0')}`,
      qty: 100 + i * 5,
    })),
  },
};

const PRODUCTION_DETAIL: DashboardProductionDetail = {
  kpis: { active_orders: 0, done_today: 0, overdue: 0, sex_count: 4 },
  active_orders: [],
  top_produced_today: [],
  daily_io: [],
  sex_load: [],
};

const STORES_DETAIL: DashboardStoresDetail = {
  kpis: {
    store_count: 6,
    sales_today_sum: 2_400_000,
    sales_today_count: 87,
    avg_receipt_today: 27_586,
  },
  store_breakdown: [],
  top_products_today: [],
  hourly_heatmap: [],
  daily_sales: [],
};

const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: 88,
    product_id: 5,
    product_name: 'Un',
    qty: 100,
    supplier_id: null,
    target_location_id: 7,
    target_location_name: 'Markaziy sklad',
    status: 'draft',
    replenishment_id: null,
    manager_approved_by: null,
    manager_approved_at: null,
    manager_approved_name: null,
    keeper_approved_by: null,
    keeper_approved_at: null,
    keeper_approved_name: null,
    supplier_name: null,
    received_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-05-24T08:00:00.000Z',
    updated_at: '2026-05-24T08:00:00.000Z',
  },
];

const REPLENISHMENTS: ReplenishmentRequest[] = [];

function mockAll() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/dashboard/overview')) {
      return Promise.resolve(jsonResponse(200, OVERVIEW));
    }
    if (url.includes('/api/dashboard/ecosystem')) {
      return Promise.resolve(jsonResponse(200, ECOSYSTEM));
    }
    if (url.includes('/api/dashboard/production')) {
      return Promise.resolve(jsonResponse(200, PRODUCTION_DETAIL));
    }
    if (url.includes('/api/dashboard/stores')) {
      return Promise.resolve(jsonResponse(200, STORES_DETAIL));
    }
    if (url.includes('/api/purchase-orders')) {
      return Promise.resolve(jsonResponse(200, PURCHASE_ORDERS));
    }
    if (/\/api\/replenishment\/\d+/.test(url)) {
      // Detail fetch — only triggered when a request is selected on the
      // Detalli canvas. None of the suite's tests select a request, so
      // returning an empty envelope is sufficient.
      return Promise.resolve(
        jsonResponse(200, {
          request: REPLENISHMENTS[0] ?? null,
          transitions: [],
        }),
      );
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, REPLENISHMENTS));
    }
    if (url.includes('/api/forecasts')) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    if (url.includes('/api/dashboard/suppliers')) {
      return Promise.resolve(jsonResponse(200, { suppliers: [] }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ExecutiveDashboardPage — Variant B', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the hero strip with four KPI cards', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('hero-strip')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-revenue')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-receipts')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-requests')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-critical')).toBeInTheDocument();
  });

  it("renders today's revenue in the hero strip as a full number", async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    const value = await screen.findByTestId('hero-strip-revenue-value');
    expect(value.textContent?.replace(/\s+/g, '')).toBe('2400000');
  });

  it('renders the chain-health row with one card per supply-chain stage', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('chain-health-row')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-production')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('chain-node-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-store')).toBeInTheDocument();
  });

  it('opens the per-stage detail drawer when a chain card is clicked', async () => {
    mockAll();
    const user = userEvent.setup();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    const storeCard = await screen.findByTestId('chain-node-store');
    await user.click(storeCard);
    expect(
      await screen.findByTestId('chain-detail-header-store'),
    ).toBeInTheDocument();
  });

  it('renders the production-plan summary above the fold', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(
      await screen.findByTestId('prod-summary-counts'),
    ).toBeInTheDocument();
    // "Pishloqli non" also appears in the below-the-fold full table, so
    // scope the lookup to the above-the-fold summary card.
    expect(screen.getAllByText('Pishloqli non').length).toBeGreaterThan(0);
  });

  it('does not render the retired ecosystem canvas', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    await screen.findByTestId('chain-health-row');
    expect(screen.queryByTestId('canvas-flow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ecosystem-canvas')).not.toBeInTheDocument();
  });

  it('lists the critical zero-stock item at the top of CriticalAlerts', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('critical-alerts')).toBeInTheDocument();
    expect(screen.getAllByText('Un').length).toBeGreaterThan(0);
  });

  it('surfaces the draft purchase order in MyActionsList', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    expect(await screen.findByTestId('my-actions-list')).toBeInTheDocument();
    expect(screen.getByText('Sotib olish: Un')).toBeInTheDocument();
  });

  it('does not render the legacy hero-block / chain-pipeline widgets', async () => {
    mockAll();
    renderWithProviders(<ExecutiveDashboardPage />, { role: 'pm' });

    await screen.findByTestId('hero-strip');
    expect(screen.queryByTestId('hero-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chain-pipeline')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('production-output-chart'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-feed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('top-products-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('store-ranking')).not.toBeInTheDocument();
  });
});
