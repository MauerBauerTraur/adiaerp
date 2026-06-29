/**
 * Sprint-2 contract test for production orders.
 *
 * Verifies that the list endpoint returns a bare `ProductionOrder[]`, that
 * the inline status transitions hit `PATCH /api/production-orders/:id`,
 * and that a 409 `INSUFFICIENT_STOCK` on the `done` flip surfaces as the
 * BOM-shortage Uzbek message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ProductionOrdersPage } from './ProductionOrdersPage';
import type { ProductionOrder } from '@/lib/types';

const PRODUCT = {
  id: 5,
  name: 'Tort tayyor',
  type: 'finished' as const,
  unit: 'pcs' as const,
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const PROD_LOC = {
  id: 9,
  name: 'Ishlab chiqarish',
  type: 'production' as const,
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const ORDER: ProductionOrder = {
  id: 77,
  product_id: 5,
  qty: 10,
  location_id: 9,
  target_location_id: null,
  deadline: null,
  status: 'in_progress',
  replenishment_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T10:00:00.000Z',
  updated_at: '2026-05-22T10:00:00.000Z',
  done_at: null,
  product_name: 'Tort tayyor',
  location_name: 'Ishlab chiqarish',
  target_location_name: null,
};

function mockFetch(opts: { doneFails?: boolean } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [PROD_LOC]));
    }
    if (url.includes('/api/production-orders/77') && method === 'PATCH') {
      if (opts.doneFails) {
        return Promise.resolve(
          jsonResponse(409, {
            error: { code: 'INSUFFICIENT_STOCK', message: 'short' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, { production_order: { ...ORDER, status: 'done' } }),
      );
    }
    if (url.includes('/api/production-orders')) {
      return Promise.resolve(jsonResponse(200, [ORDER]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ProductionOrdersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders rows from a bare ProductionOrder[]', async () => {
    mockFetch();
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    expect(await screen.findByText('Tort tayyor')).toBeInTheDocument();
    // Embedded `location_name` is rendered directly (no client-side join).
    expect(screen.getByText('Ishlab chiqarish')).toBeInTheDocument();
    // "Jarayonda" appears in both the status filter <option> and the row
    // badge — the count must be at least one.
    expect(screen.getAllByText('Jarayonda').length).toBeGreaterThan(0);
  });

  it('finishes a production order via PATCH /:id { status: "done" }', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<ProductionOrdersPage />, {
      role: 'production_manager',
      locationId: 9, // matches ORDER.location_id — Stage 4 RBAC
    });
    await screen.findByText('Tort tayyor');
    await user.click(screen.getByRole('button', { name: 'Yakunlash' }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/production-orders/77'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('hides every transition button for PM (Stage 1 read-only)', async () => {
    mockFetch();
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    expect(await screen.findByText('Tort tayyor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yakunlash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Boshlash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
    // PM also loses the "Yangi zayafka" button — canCreate=isOperator.
    expect(screen.queryByRole('button', { name: /yangi zayafka/i })).toBeNull();
    expect(screen.getByText(/faqat o.qish/i)).toBeInTheDocument();
  });

  it('hides transition buttons for an operator on a foreign location', async () => {
    mockFetch();
    renderWithProviders(<ProductionOrdersPage />, {
      role: 'production_manager',
      locationId: 99, // ORDER.location_id === 9, not 99
    });
    expect(await screen.findByText('Tort tayyor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yakunlash' })).toBeNull();
  });

  it('shows a BOM-shortage alert on 409 INSUFFICIENT_STOCK', async () => {
    const user = userEvent.setup();
    mockFetch({ doneFails: true });
    renderWithProviders(<ProductionOrdersPage />, {
      role: 'production_manager',
      locationId: 9, // matches ORDER.location_id — Stage 4 RBAC
    });
    await screen.findByText('Tort tayyor');
    await user.click(screen.getByRole('button', { name: 'Yakunlash' }));
    await waitFor(() => {
      expect(
        screen.getByText(/bom komponentlari yetarli emas/i),
      ).toBeInTheDocument();
    });
  });
});
