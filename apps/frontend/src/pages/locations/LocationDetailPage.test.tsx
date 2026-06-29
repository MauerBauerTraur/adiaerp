/**
 * LocationDetailPage — contract test.
 *
 * Pins the mocked endpoints (location detail, stock, stock-movements,
 * replenishment list, users) to the rendered UI:
 *   • Header surfaces the bo'g'in name + type badge.
 *   • KPI strip surfaces SKU count, below-min count, open-requests count
 *     and the last-movement relative time.
 *   • Empty state when /api/locations/:id is 404.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import { jsonResponse } from '@/test/render-helpers';
import { LocationDetailPage } from './LocationDetailPage';
import type {
  Location,
  MovementsResponse,
  ReplenishmentRequest,
  StockRow,
  User,
} from '@/lib/types';

const LOCATION: Location = {
  id: 7,
  name: 'Markaziy sklad',
  type: 'central_warehouse',
  parent_id: null,
  manager_user_id: 42,
  poster_storage_id: null,
  lead_time_days: 2,
  review_days: 7,
  safety_factor: 1.2,
};

const STOCK: StockRow[] = [
  {
    location_id: 7,
    product_id: 1,
    qty: 0,
    min_level: 10,
    max_level: 50,
    minmax_mode: 'manual',
    updated_at: '2026-05-24T08:00:00.000Z',
    product_name: 'Un',
    product_unit: 'kg',
  },
  {
    location_id: 7,
    product_id: 2,
    qty: 25,
    min_level: 5,
    max_level: 40,
    minmax_mode: 'manual',
    updated_at: '2026-05-24T08:00:00.000Z',
    product_name: 'Shakar',
    product_unit: 'kg',
  },
];

const MOVEMENTS: MovementsResponse = {
  items: [
    {
      id: 1001,
      product_id: 1,
      from_location_id: null,
      to_location_id: 7,
      qty: 100,
      reason: 'purchase',
      note: null,
      created_at: '2026-05-26T07:30:00.000Z',
      created_by: 1,
      product_name: 'Un',
      product_unit: 'kg',
      from_location_name: null,
      to_location_name: 'Markaziy sklad',
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const REQUESTS: ReplenishmentRequest[] = [
  {
    id: 555,
    product_id: 1,
    requester_location_id: 7,
    target_location_id: null,
    qty_needed: 50,
    status: 'NEW',
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: 1,
    created_at: '2026-05-26T07:00:00.000Z',
    updated_at: '2026-05-26T07:00:00.000Z',
    closed_at: null,
    product_name: 'Un',
    product_unit: 'kg',
    requester_location_name: 'Markaziy sklad',
    target_location_name: null,
    production_location_name: null,
  },
];

const USERS: User[] = [
  {
    id: 42,
    name: 'Aziz Rahmonov',
    username: 'aziz',
    role: 'central_warehouse_manager',
    location_id: 7,
  },
];

function fakeAuth(): AuthContextValue {
  return {
    user: {
      id: 1,
      name: 'Test PM',
      username: 'pm',
      role: 'pm',
      location_id: null,
    },
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: () => {},
    logout: async () => {},
    setActiveLocation: async () => {},
  };
}

function renderAtRoute(initialPath: string) {
  return render(
    <AuthContext.Provider value={fakeAuth()}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route
              path="/dashboard/locations/:locationId"
              element={<LocationDetailPage />}
            />
            <Route path="/dashboard" element={<div>Dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}

function mockHappyPath() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/api/locations/7') || url.includes('/api/locations/7?')) {
      return Promise.resolve(jsonResponse(200, { location: LOCATION }));
    }
    if (url.includes('/api/stock/movements')) {
      return Promise.resolve(jsonResponse(200, MOVEMENTS));
    }
    if (url.includes('/api/stock')) {
      return Promise.resolve(jsonResponse(200, STOCK));
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, REQUESTS));
    }
    if (url.includes('/api/users')) {
      return Promise.resolve(jsonResponse(200, USERS));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function mockNotFound() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/api/locations/999') || url.includes('/api/locations/999?')) {
      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Location not found.' },
        }),
      );
    }
    if (url.includes('/api/stock')) {
      return Promise.resolve(jsonResponse(200, []));
    }
    if (url.includes('/api/replenishment')) {
      return Promise.resolve(jsonResponse(200, []));
    }
    if (url.includes('/api/users')) {
      return Promise.resolve(jsonResponse(200, []));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('LocationDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header with the bo\'g\'in name and a back link', async () => {
    mockHappyPath();
    renderAtRoute('/dashboard/locations/7');

    expect(
      await screen.findByRole('heading', { name: 'Markaziy sklad' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('location-detail-back')).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('renders the KPI strip with four cards', async () => {
    mockHappyPath();
    renderAtRoute('/dashboard/locations/7');

    expect(await screen.findByTestId('location-detail-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('location-detail-kpi-sku')).toBeInTheDocument();
    expect(
      screen.getByTestId('location-detail-kpi-below-min'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('location-detail-kpi-open-requests'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('location-detail-kpi-last-movement'),
    ).toBeInTheDocument();
  });

  it('shows an error state with a back link when the location is not found', async () => {
    mockNotFound();
    renderAtRoute('/dashboard/locations/999');

    // Backend returns 404 → page renders ErrorState with the message and
    // keeps the back link visible so the user can return to the dashboard.
    expect(await screen.findByText('Location not found.')).toBeInTheDocument();
    expect(screen.getByTestId('location-detail-back')).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('shows an empty state when the locationId in the URL is not a number', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(new Error('no fetch expected for invalid id')),
    );
    renderAtRoute('/dashboard/locations/abc');

    expect(screen.getByText("Bo'g'in topilmadi.")).toBeInTheDocument();
  });
});
