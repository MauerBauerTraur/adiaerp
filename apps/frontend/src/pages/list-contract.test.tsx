/**
 * Contract regression tests for the list screens.
 *
 * Sprint-1 audit finding: the backend list endpoints return *bare arrays*
 * (`Product[]`, `Location[]`, `User[]`, `StockRow[]`) — except
 * `GET /api/stock/movements`, which returns a `{ items, total, limit,
 * offset }` envelope. These tests pin the real response shape to each
 * page so a contract drift fails CI loudly instead of silently rendering
 * an empty table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ProductsPage } from './products/ProductsPage';
import { LocationsPage } from './locations/LocationsPage';
import { EmployeesPage } from './employees/EmployeesPage';
import { StockPage } from './stock/StockPage';
import type {
  Location,
  Product,
  StockRow,
  User,
  MovementsResponse,
} from '@/lib/types';

// EPIC 1.4b — ProductsPage defaults its filter to "Tayyor mahsulot"
// (finished), so the contract fixture is a finished product to prove the
// bare-array response is consumed without first clearing the filter.
const PRODUCT: Product = {
  id: 1,
  name: 'Shokoladli tort',
  type: 'finished',
  unit: 'pcs',
  sku: 'FIN-01',
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const LOCATION: Location = {
  id: 7,
  name: 'Markaziy sklad',
  type: 'central_warehouse',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: 2,
  review_days: null,
  safety_factor: null,
};

const ACCOUNT: User = {
  id: 3,
  name: 'Aziz Karimov',
  username: 'aziz',
  role: 'store_manager',
  location_id: 7,
};

const STOCK_ROW: StockRow = {
  location_id: 7,
  product_id: 1,
  qty: 4,
  min_level: 10,
  max_level: 50,
  minmax_mode: 'manual',
  updated_at: '2026-05-22T10:00:00.000Z',
  product_name: 'Un',
  product_unit: 'kg',
};

const MOVEMENTS_ENVELOPE: MovementsResponse = {
  items: [
    {
      id: 99,
      product_id: 1,
      from_location_id: null,
      to_location_id: 7,
      qty: 25,
      reason: 'adjust',
      note: null,
      created_at: '2026-05-22T09:00:00.000Z',
      created_by: 3,
      product_name: 'Un',
      product_unit: 'kg',
      from_location_name: null,
      to_location_name: 'Markaziy sklad',
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

/**
 * Route a mocked `fetch` by URL path. Each entry is a bare array (the
 * real list contract) except `/movements`, which is the envelope.
 */
function mockFetchByPath(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/stock/movements')) {
      return Promise.resolve(jsonResponse(200, MOVEMENTS_ENVELOPE));
    }
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [LOCATION]));
    }
    if (url.includes('/api/users')) {
      return Promise.resolve(jsonResponse(200, [ACCOUNT]));
    }
    if (url.includes('/api/stock')) {
      return Promise.resolve(jsonResponse(200, [STOCK_ROW]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('list screen response contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ProductsPage renders rows from a bare Product[] response', async () => {
    mockFetchByPath();
    renderWithProviders(<ProductsPage />);
    expect(await screen.findByText('Shokoladli tort')).toBeInTheDocument();
  });

  it('LocationsPage renders rows from a bare Location[] response', async () => {
    mockFetchByPath();
    renderWithProviders(<LocationsPage />);
    // F4.10 — the default view is the card grid. The lead-time (2 kun)
    // is unique to the rendered card, proving the bare Location[]
    // response was consumed into a rendered location. The name and
    // type-label both happen to be "Markaziy sklad" in this fixture, so
    // we look for the (n>=1) card name match plus the unique lead-time.
    await screen.findByText('2 kun');
    expect(screen.getAllByText('Markaziy sklad').length).toBeGreaterThan(0);
  });

  it('EmployeesPage renders rows from a bare User[] response (merged users+employees)', async () => {
    mockFetchByPath();
    renderWithProviders(<EmployeesPage />);
    expect(await screen.findByText('Aziz Karimov')).toBeInTheDocument();
  });

  it('StockPage renders embedded product_name / product_unit from StockRow[]', async () => {
    mockFetchByPath();
    renderWithProviders(<StockPage />, { role: 'pm' });
    // product_name and product_unit are embedded — no client-side join.
    expect(await screen.findByText('Un')).toBeInTheDocument();
    expect(screen.getByText(/4 kg/)).toBeInTheDocument();
  });

  it('MovementHistory reads items[] from the {items,total,limit,offset} envelope', async () => {
    const user = userEvent.setup();
    mockFetchByPath();
    renderWithProviders(<StockPage />, { role: 'pm' });
    // Switch to the history tab.
    const historyTab = await screen.findByRole('tab', {
      name: 'Harakatlar tarixi',
    });
    await user.click(historyTab);
    await waitFor(() => {
      // Embedded to_location_name from the envelope item — the ledger
      // row reads "— → Markaziy sklad".
      expect(
        screen.getByRole('cell', { name: '— → Markaziy sklad' }),
      ).toBeInTheDocument();
    });
  });
});
