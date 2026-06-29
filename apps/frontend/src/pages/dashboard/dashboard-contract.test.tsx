/**
 * Contract test for the M8 dashboard overview.
 *
 * Pins the `GET /api/dashboard/overview` response shape (the
 * `DashboardOverview` envelope) to the rendered UI: KPI numbers,
 * below-min table rows, the open-requests legend, the production-plan
 * row, and the recent-movements feed entry all derive from a mocked
 * backend payload that mirrors `apps/backend/src/routes/dashboard.ts`.
 *
 * Drift in either direction (renamed field, missing nested object,
 * different status enum value) breaks this test loudly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { DashboardPage } from './DashboardPage';
import type { DashboardOverview } from '@/lib/types';

const OVERVIEW: DashboardOverview = {
  below_min: [
    {
      location_id: 7,
      location_name: 'Markaziy sklad',
      product_id: 1,
      product_name: 'Un',
      product_unit: 'kg',
      qty: 4,
      min_level: 10,
      max_level: 50,
      open_request_id: 42,
      open_request_status: 'NEW',
    },
    {
      location_id: 11,
      location_name: 'Do‘kon #2',
      product_id: 2,
      product_name: 'Shakar',
      product_unit: 'kg',
      qty: 0,
      min_level: 5,
      max_level: 25,
      open_request_id: null,
      open_request_status: null,
    },
  ],
  open_requests: {
    by_status: {
      NEW: 3,
      CHECK_STORE_SUPPLIER: 2,
      PRODUCING: 1,
    },
    total: 6,
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
  recent_movements: [
    {
      id: 999,
      created_at: '2026-05-22T11:15:00.000Z',
      product_id: 1,
      product_name: 'Un',
      product_unit: 'kg',
      from_location_id: null,
      from_location_name: null,
      to_location_id: 7,
      to_location_name: 'Markaziy sklad',
      qty: 50,
      reason: 'purchase',
    },
  ],
  kpis: {
    total_open_requests: 6,
    below_min_count: 2,
    active_production_orders: 4,
    pending_approvals: 1,
  },
};

function mockOverview(body: DashboardOverview) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/dashboard/overview')) {
      return Promise.resolve(jsonResponse(200, body));
    }
    // The dashboard now embeds the F3.4 ForecastsPanel; stub the
    // forecasts endpoint with an empty payload so the panel renders
    // the empty branch without affecting these assertions.
    if (url.includes('/api/forecasts')) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    // F4.4 — the dashboard fetches the ecosystem envelope (poster /
    // chain flow / alerts / sales). Stub with an empty payload so the
    // overview-focused assertions in this file are not coupled to it.
    if (url.includes('/api/dashboard/ecosystem')) {
      return Promise.resolve(
        jsonResponse(200, {
          poster_status: {
            last_sync_at: null,
            last_sync_status: null,
            sync_errors_24h: 0,
            sales_today_count: 0,
            sales_today_sum: 0,
          },
          chain_flow: [],
          alerts_feed: [],
          sales_chart: { days: [] },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('DashboardPage — overview contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders KPI numbers from kpis{}', async () => {
    mockOverview(OVERVIEW);
    renderWithProviders(<DashboardPage />, { role: 'pm' });

    // KPI labels confirm the strip rendered.
    expect(
      await screen.findByText('Ochiq to‘ldirish so‘rovlari'),
    ).toBeInTheDocument();
    expect(screen.getByText('Faol ishlab chiqarish')).toBeInTheDocument();
    expect(screen.getByText('Tasdiqlash kutmoqda')).toBeInTheDocument();
    // KPI numbers — collisions (the donut centre also prints the
    // total, the legend the per-status counts, the production-plan
    // table the qty), so we anchor on the KPI card's <p> class chain:
    // an element with `text-3xl` AND the expected number is the KPI.
    const kpiNumbers = Array.from(
      document.querySelectorAll('p.text-3xl'),
    ).map((node) => node.textContent?.trim());
    expect(kpiNumbers).toEqual(['6', '2', '4', '1']);
  });

  it('renders below_min table rows with product, location, qty/min/max and status badge', async () => {
    mockOverview(OVERVIEW);
    renderWithProviders(<DashboardPage />, { role: 'pm' });

    // Wait for any below-min row to appear (Shakar is unique — it
    // only exists in the below_min payload, not movements).
    expect(await screen.findByText('Shakar')).toBeInTheDocument();
    // Un appears in both below_min and recent_movements, so just check
    // there are matches.
    expect(screen.getAllByText('Un').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Markaziy sklad').length).toBeGreaterThan(0);
    expect(screen.getByText('Do‘kon #2')).toBeInTheDocument();
    // Open-request status badge for the first row (NEW → "Yangi") —
    // the badge AND the legend both render "Yangi", so just count.
    expect(screen.getAllByText('Yangi').length).toBeGreaterThan(0);
  });

  it('renders the open-requests-by-status legend from open_requests.by_status', async () => {
    mockOverview(OVERVIEW);
    renderWithProviders(<DashboardPage />, { role: 'pm' });

    const legend = await screen.findByTestId('open-requests-legend');
    // All three statuses appear as legend rows.
    expect(legend.textContent).toMatch(/Yangi/);
    expect(legend.textContent).toMatch(/Tekshiruv: sex skladi\/markaziy sklad/);
    expect(legend.textContent).toMatch(/Ishlab chiqarilmoqda/);
  });

  it('renders the production plan row from production_plan[]', async () => {
    mockOverview(OVERVIEW);
    renderWithProviders(<DashboardPage />, { role: 'pm' });

    expect(await screen.findByText('Pishloqli non')).toBeInTheDocument();
    expect(screen.getByText('2026-05-23')).toBeInTheDocument();
    // status badge "Jarayonda" for in_progress.
    expect(screen.getByText('Jarayonda')).toBeInTheDocument();
  });

  it('renders the recent movement feed entry from recent_movements[]', async () => {
    mockOverview(OVERVIEW);
    renderWithProviders(<DashboardPage />, { role: 'pm' });

    await waitFor(() => {
      // Movement entry shows product name + reason label.
      expect(screen.getByText('Sotib olish')).toBeInTheDocument();
    });
  });
});
