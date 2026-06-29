/**
 * Forecast widget — F3.4 dashboard panel (phase-3.md §2.4).
 *
 * Pins the `GET /api/forecasts` envelope to the rendered top-stockout
 * list. Verifies:
 *  - rows for stockouts inside the 7-day window appear, sorted by date;
 *  - rows whose stockout date is outside the window do NOT appear;
 *  - the "Eski ma'lumot" badge surfaces when any row is stale;
 *  - sparkline data containers render alongside each row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ForecastsPanel } from './ForecastsPanel';
import type { ForecastItem, ForecastsResponse } from '@/lib/types';

// Tests compute fixture stockout dates relative to the *real* today
// (local midnight). This keeps the panel's own `new Date()` in sync
// with our fixtures without mocking the Date global — a fragile pattern
// in jsdom — at the cost of being a pure "in N days" smoke test rather
// than a calendar-pinned one.
function todayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysFromBase(days: number): string {
  const base = todayLocal();
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildDaily(start: number = 0): ForecastItem['daily_predictions'] {
  return Array.from({ length: 14 }, (_unused, i) => ({
    date: daysFromBase(start + i),
    yhat: 10 + i * 0.5,
    yhat_lower: 8,
    yhat_upper: 12 + i * 0.5,
  }));
}

const NEAR: ForecastItem = {
  location_id: 7,
  location_name: 'Markaziy sklad',
  product_id: 1,
  product_name: 'Un',
  product_unit: 'kg',
  daily_predictions: buildDaily(),
  expected_stockout_date: daysFromBase(3),
  generated_at: '2026-05-23T04:30:00.000Z',
  stale: false,
};

const URGENT: ForecastItem = {
  ...NEAR,
  location_id: 11,
  product_id: 2,
  product_name: 'Shakar',
  location_name: 'Do‘kon #2',
  expected_stockout_date: daysFromBase(1),
  stale: true,
};

const FAR: ForecastItem = {
  ...NEAR,
  location_id: 9,
  product_id: 3,
  product_name: 'Tuxum',
  location_name: 'Do‘kon #1',
  expected_stockout_date: daysFromBase(20),
  stale: false,
};

const NULL_STOCKOUT: ForecastItem = {
  ...NEAR,
  location_id: 9,
  product_id: 4,
  product_name: 'Suv',
  location_name: 'Do‘kon #1',
  expected_stockout_date: null,
  stale: false,
};

function mockForecasts(response: ForecastsResponse) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/forecasts')) {
      return Promise.resolve(jsonResponse(200, response));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ForecastsPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders imminent stockouts sorted by date and skips far-future / null rows', async () => {
    mockForecasts({ items: [NEAR, URGENT, FAR, NULL_STOCKOUT] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    const list = await screen.findByTestId('forecasts-imminent');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBe(2);
    // URGENT (1 day) comes before NEAR (3 days).
    expect(rows[0]?.textContent ?? '').toMatch(/Shakar/);
    expect(rows[1]?.textContent ?? '').toMatch(/Un/);
    // FAR (20 days) and NULL_STOCKOUT do not render.
    expect(screen.queryByText('Tuxum')).not.toBeInTheDocument();
    expect(screen.queryByText('Suv')).not.toBeInTheDocument();
  });

  it('renders countdown labels (Bugun / X kun qoldi)', async () => {
    mockForecasts({ items: [URGENT, NEAR] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    await screen.findByTestId('forecasts-imminent');
    expect(screen.getByText('1 kun qoldi')).toBeInTheDocument();
    expect(screen.getByText('3 kun qoldi')).toBeInTheDocument();
  });

  it('surfaces the "Eski ma\'lumot" badge when any forecast is stale', async () => {
    mockForecasts({ items: [URGENT] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    expect(await screen.findByText('Eski ma’lumot')).toBeInTheDocument();
  });

  it('hides the stale badge when no row is stale', async () => {
    mockForecasts({ items: [NEAR] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    await screen.findByTestId('forecasts-imminent');
    expect(screen.queryByText('Eski ma’lumot')).not.toBeInTheDocument();
  });

  it('renders a sparkline container per imminent row', async () => {
    mockForecasts({ items: [URGENT, NEAR] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    await screen.findByTestId('forecasts-imminent');
    await waitFor(() => {
      expect(screen.getAllByTestId('forecast-sparkline').length).toBe(2);
    });
  });

  it('renders the empty branch when no imminent stockouts exist', async () => {
    mockForecasts({ items: [FAR, NULL_STOCKOUT] });
    renderWithProviders(<ForecastsPanel />, { role: 'pm' });

    expect(
      await screen.findByText('Yaqin 7 kun ichida tugaydigan mahsulot yo‘q.'),
    ).toBeInTheDocument();
  });
});
