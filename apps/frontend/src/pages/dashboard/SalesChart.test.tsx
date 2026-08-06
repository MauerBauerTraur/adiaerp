/**
 * SalesChart widget tests.
 *
 * The component now fetches /api/sales and /api/locations?type=store.
 * We mock `fetch` to control what it returns.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { SalesChart } from './SalesChart';

const EMPTY_SALES = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_LOCATIONS: unknown[] = [];

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url);
    if (url.includes('/api/locations')) return jsonResponse(200, EMPTY_LOCATIONS);
    if (url.includes('/api/sales')) return jsonResponse(200, EMPTY_SALES);
    return jsonResponse(404, {});
  });
});

describe('SalesChart', () => {
  it('renders the empty branch when no data is returned', async () => {
    renderWithProviders(<SalesChart />);
    expect(await screen.findByText("Sotuv ma'lumotlari yo'q.")).toBeInTheDocument();
  });

  it('renders sales rows when data is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(typeof input === 'string' ? input : (input as Request).url);
      if (url.includes('/api/locations')) return jsonResponse(200, EMPTY_LOCATIONS);
      if (url.includes('/api/sales')) {
        return jsonResponse(200, {
          items: [{
            id: 1, store_id: 10, store_name: "Do'kon A",
            product_id: 5, product_name: 'Tort', product_unit: 'pcs',
            qty: 2, price: 50000, cost_price: null,
            sold_at: '2026-07-13T10:00:00Z', poster_transaction_id: 99,
          }],
          total: 1, limit: 50, offset: 0,
        });
      }
      return jsonResponse(404, {});
    });

    renderWithProviders(<SalesChart />);
    expect(await screen.findByText('Tort')).toBeInTheDocument();
    expect(await screen.findByText("Do'kon A")).toBeInTheDocument();
  });

  it('shows range toggle buttons', () => {
    renderWithProviders(<SalesChart />);
    expect(screen.getByRole('button', { name: 'Bugun' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bu hafta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bu oy' })).toBeInTheDocument();
  });
});
