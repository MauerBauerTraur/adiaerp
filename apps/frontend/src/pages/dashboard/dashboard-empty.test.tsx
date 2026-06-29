/**
 * Empty-state regression — when the dashboard endpoint returns the
 * "nothing to show" payload (`emptyOverview()` on the backend), the
 * page must NOT render the below-min table, the chart, the plan, or
 * the feed. A single neutral empty message takes their place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { DashboardPage } from './DashboardPage';
import type { DashboardOverview } from '@/lib/types';

const EMPTY: DashboardOverview = {
  below_min: [],
  open_requests: { by_status: {}, total: 0, oldest_created_at: null },
  production_plan: [],
  recent_movements: [],
  kpis: {
    total_open_requests: 0,
    below_min_count: 0,
    active_production_orders: 0,
    pending_approvals: 0,
  },
};

describe('DashboardPage — empty payload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the neutral empty message and no detail panels', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/overview')) {
        return Promise.resolve(jsonResponse(200, EMPTY));
      }
      if (url.includes('/api/forecasts')) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
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

    renderWithProviders(<DashboardPage />, {
      role: 'store_manager',
      locationId: 11,
    });

    // The KPI strip is still rendered (every card reads from kpis{}),
    // so the labels are visible — but every value is 0.
    expect(
      await screen.findByText('Hozircha kuzatish uchun ma’lumot yo‘q.'),
    ).toBeInTheDocument();

    // None of the detail panels render in the empty branch. The
    // KPI strip still surfaces "Min’dan tushgan pozitsiyalar" as a
    // card label, so we check the panel headings that exist only when
    // the detail blocks render.
    expect(
      screen.queryByText('Ochiq so‘rovlar — status'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Bugungi ishlab chiqarish rejasi'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Oxirgi harakatlar')).not.toBeInTheDocument();
  });
});
