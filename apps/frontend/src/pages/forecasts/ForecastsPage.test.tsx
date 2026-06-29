/**
 * F3.4 ForecastsPage — pins the `GET /api/forecasts` envelope and the
 * `?location` / `?product type` client-side filters (phase-3.md §2.4).
 *
 * Covered:
 *  - all rows render by default;
 *  - location filter narrows the table;
 *  - product-type filter joins with `/api/products` and narrows the
 *    table;
 *  - stale badge surfaces; expected-stockout date is shown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ForecastsPage } from './ForecastsPage';
import type {
  ForecastItem,
  ForecastsResponse,
  Location,
  Product,
} from '@/lib/types';

const DAILY: ForecastItem['daily_predictions'] = Array.from(
  { length: 14 },
  (_unused, i) => ({
    date: `2026-05-${String(24 + i).padStart(2, '0')}`,
    yhat: 5 + i,
    yhat_lower: 3,
    yhat_upper: 8 + i,
  }),
);

const ITEMS: ForecastItem[] = [
  {
    location_id: 7,
    location_name: 'Markaziy sklad',
    product_id: 1,
    product_name: 'Un',
    product_unit: 'kg',
    daily_predictions: DAILY,
    expected_stockout_date: '2026-05-30',
    generated_at: '2026-05-23T04:30:00.000Z',
    stale: false,
  },
  {
    location_id: 11,
    location_name: 'Do‘kon #2',
    product_id: 2,
    product_name: 'Shakar',
    product_unit: 'kg',
    daily_predictions: DAILY,
    expected_stockout_date: '2026-05-26',
    generated_at: '2026-05-21T04:30:00.000Z',
    stale: true,
  },
  {
    location_id: 11,
    location_name: 'Do‘kon #2',
    product_id: 3,
    product_name: 'Tuxum',
    product_unit: 'pcs',
    daily_predictions: DAILY,
    expected_stockout_date: null,
    generated_at: '2026-05-23T04:30:00.000Z',
    stale: false,
  },
];

const LOCATIONS: Location[] = [
  {
    id: 7,
    name: 'Markaziy sklad',
    type: 'central_warehouse',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 11,
    name: 'Do‘kon #2',
    type: 'store',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

const PRODUCTS: Product[] = [
  {
    id: 1,
    name: 'Un',
    type: 'raw',
    unit: 'kg',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
  },
  {
    id: 2,
    name: 'Shakar',
    type: 'raw',
    unit: 'kg',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
  },
  {
    id: 3,
    name: 'Tuxum',
    type: 'finished',
    unit: 'pcs',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
  },
];

function mockEndpoints(items: ForecastItem[] = ITEMS) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/forecasts')) {
      const body: ForecastsResponse = { items };
      return Promise.resolve(jsonResponse(200, body));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, LOCATIONS));
    }
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, PRODUCTS));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ForecastsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every forecast row by default', async () => {
    mockEndpoints();
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    expect(await screen.findByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Shakar')).toBeInTheDocument();
    expect(screen.getByText('Tuxum')).toBeInTheDocument();
    expect(screen.getAllByTestId('forecast-row').length).toBe(3);
  });

  it('renders the expected stockout date and stale badge', async () => {
    mockEndpoints();
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    expect(await screen.findByText('2026-05-30')).toBeInTheDocument();
    expect(screen.getByText('2026-05-26')).toBeInTheDocument();
    // Stale badge surfaces on the row that's older than 24h.
    expect(screen.getByText('Eski')).toBeInTheDocument();
  });

  it('filters by location', async () => {
    mockEndpoints();
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    // Wait for the locations dropdown to populate.
    await waitFor(() => {
      const select = screen.getByLabelText('Bo‘g‘in') as HTMLSelectElement;
      expect(select.querySelectorAll('option').length).toBeGreaterThan(1);
    });

    const locationSelect = screen.getByLabelText(
      'Bo‘g‘in',
    ) as HTMLSelectElement;
    fireEvent.change(locationSelect, { target: { value: '11' } });

    await waitFor(() => {
      expect(screen.queryByText('Un')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Shakar')).toBeInTheDocument();
    expect(screen.getByText('Tuxum')).toBeInTheDocument();
  });

  it('filters by product type (joined against /api/products)', async () => {
    mockEndpoints();
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    await screen.findByText('Tuxum');

    const typeSelect = screen.getByLabelText(
      'Mahsulot turi',
    ) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'finished' } });

    await waitFor(() => {
      expect(screen.queryByText('Un')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Shakar')).not.toBeInTheDocument();
    expect(screen.getByText('Tuxum')).toBeInTheDocument();
  });

  it('renders the empty branch when no rows are returned', async () => {
    mockEndpoints([]);
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    expect(
      await screen.findByText('Bashorat ma’lumotlari topilmadi.'),
    ).toBeInTheDocument();
  });

  it('opens the detail dialog when a row is clicked', async () => {
    mockEndpoints();
    renderWithProviders(<ForecastsPage />, { role: 'pm' });

    const rows = await screen.findAllByTestId('forecast-row');
    const row = rows[0];
    if (row === undefined) throw new Error('no forecast row rendered');
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByTestId('forecast-detail-chart')).toBeInTheDocument();
    });
    // Header text reflects the row's product.
    expect(screen.getAllByText('Un').length).toBeGreaterThan(0);
  });
});
