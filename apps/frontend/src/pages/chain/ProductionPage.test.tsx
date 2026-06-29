import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { ProductionPage } from './ProductionPage';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type {
  ChainLayerOverview,
  Location,
  ProductionOrder,
  User,
} from '@/lib/types';

const OVERVIEW: ChainLayerOverview = {
  layer_type: 'production',
  locations: [
    {
      id: 10,
      name: 'Ishlab chiqarish',
      type: 'production',
      total_products: 0,
      below_min_count: 0,
      open_requests_count: 0,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 0,
    below_min_count: 0,
    open_requests_count: 0,
    active_production_orders: 0,
  },
  recent_movements: [],
};

const PRODUCTION_LOCATIONS: Location[] = [
  {
    id: 10,
    name: 'Ishlab chiqarish',
    type: 'production',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
  {
    id: 11,
    name: 'Tort sexi',
    type: 'production',
    parent_id: 10,
    manager_user_id: 22,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
  {
    id: 12,
    name: 'Perojniy sexi',
    type: 'production',
    parent_id: 10,
    manager_user_id: 23,
    poster_storage_id: null,
    lead_time_days: 1,
    review_days: 7,
    safety_factor: 1.2,
  },
];

const ACTIVE_ORDER_TORT: ProductionOrder = {
  id: 7001,
  product_id: 5,
  qty: 30,
  status: 'in_progress',
  deadline: null,
  location_id: 11, // Tort sexi
  target_location_id: null,
  replenishment_id: null,
  note: null,
  product_name: 'Napoleon',
  location_name: 'Tort sexi',
  target_location_name: null,
  created_by: 22,
  created_at: '2026-05-22T08:00:00.000Z',
  updated_at: '2026-05-22T08:00:00.000Z',
  done_at: null,
};

const PENDING_ORDER_PEROJNIY: ProductionOrder = {
  id: 7002,
  product_id: 6,
  qty: 20,
  status: 'new',
  deadline: null,
  location_id: 12, // Perojniy sexi
  target_location_id: null,
  replenishment_id: null,
  note: null,
  product_name: 'Pirojnoe',
  location_name: 'Perojniy sexi',
  target_location_name: null,
  created_by: 23,
  created_at: '2026-05-22T09:00:00.000Z',
  updated_at: '2026-05-22T09:00:00.000Z',
  done_at: null,
};

const ACTIVE_ORDERS: ProductionOrder[] = [ACTIVE_ORDER_TORT];
const PENDING_ORDERS: ProductionOrder[] = [PENDING_ORDER_PEROJNIY];

const PRODUCTION_USERS: User[] = [
  {
    id: 22,
    name: 'Hodim A',
    username: 'hodim.a',
    role: 'production_manager',
    location_id: 11,
  },
];

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/dashboard/chain-layer/production')) {
        return Promise.resolve(jsonResponse(200, OVERVIEW));
      }
      if (url.includes('/api/stock')) {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url.includes('/api/production-orders?status=in_progress')) {
        return Promise.resolve(jsonResponse(200, ACTIVE_ORDERS));
      }
      if (url.includes('/api/production-orders?status=new')) {
        return Promise.resolve(jsonResponse(200, PENDING_ORDERS));
      }
      if (url.includes('/api/locations?type=production')) {
        return Promise.resolve(jsonResponse(200, PRODUCTION_LOCATIONS));
      }
      if (url.includes('/api/users')) {
        return Promise.resolve(jsonResponse(200, PRODUCTION_USERS));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  );
}

describe('ProductionPage — sub-departments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders sub-cehs grouped under their root production location', async () => {
    mockFetch();
    renderWithProviders(<ProductionPage />);

    expect(await screen.findByTestId('sub-department-11')).toBeInTheDocument();
    expect(screen.getByTestId('sub-department-12')).toBeInTheDocument();
    // Tort sexi card shows the assigned user (via primary location).
    const tortCard = screen.getByTestId('sub-department-11');
    expect(tortCard).toHaveTextContent('Tort sexi');
    expect(tortCard).toHaveTextContent('Hodim A');
    const perojniyCard = screen.getByTestId('sub-department-12');
    expect(perojniyCard).toHaveTextContent('Hodim biriktirilmagan');
  });
});

describe('ProductionPage — RBAC gating (Stage 4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides every "Yakunlash" and "Boshlash" button for PM (read-only)', async () => {
    mockFetch();
    renderWithProviders(<ProductionPage />, { role: 'pm' });
    // Wait for the active orders row to render.
    expect(await screen.findByText('Napoleon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yakunlash/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /boshlash/i })).toBeNull();
  });

  it('shows "Yakunlash" for the Tort-sexi operator on their own order', async () => {
    mockFetch();
    renderWithProviders(<ProductionPage />, {
      role: 'production_manager',
      locationId: 11, // Tort sexi — matches ACTIVE_ORDER_TORT.location_id
    });
    // Active order row → button renders.
    expect(
      await screen.findByRole('button', { name: /yakunlash/i }),
    ).toBeInTheDocument();
    // Pending order belongs to Perojniy (loc 12) — the Tort-sexi operator
    // cannot start it (foreign location).
    expect(screen.queryByRole('button', { name: /boshlash/i })).toBeNull();
  });

  it('hides actions for an operator on a foreign location', async () => {
    mockFetch();
    renderWithProviders(<ProductionPage />, {
      role: 'production_manager',
      locationId: 99, // not any of 11 / 12
    });
    expect(await screen.findByText('Napoleon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yakunlash/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /boshlash/i })).toBeNull();
  });
});
