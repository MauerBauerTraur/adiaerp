/**
 * Faza-2 F2.1 — StockPage recalc trigger + per-row mode badge tests.
 *
 * Covers:
 *  - PM sees the manual recalc button; non-PM does not.
 *  - The `minmax_mode` value on every row renders as either the
 *    Manual or Dynamic badge.
 *  - Confirming the recalc dialog POSTs to `/api/admin/recalc-minmax`
 *    and surfaces the updated/skipped counts in a toast.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { StockPage } from './StockPage';
import type { Location, Product, StockRow } from '@/lib/types';

const PRODUCT: Product = {
  id: 11,
  name: 'Un',
  type: 'raw',
  unit: 'kg',
  sku: null,
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
  review_days: 2,
  safety_factor: 1.3,
};

const MANUAL_ROW: StockRow = {
  location_id: 7,
  product_id: 11,
  qty: 12,
  min_level: 10,
  max_level: 30,
  minmax_mode: 'manual',
  updated_at: '2026-05-22T10:00:00.000Z',
  product_name: 'Un',
  product_unit: 'kg',
};

const DYNAMIC_ROW: StockRow = {
  ...MANUAL_ROW,
  product_id: 12,
  qty: 25,
  product_name: 'Shakar',
  minmax_mode: 'dynamic',
};

function mockListsAndCaptureRecalc(): { lastBody: () => unknown } {
  let captured: unknown = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/api/admin/recalc-minmax') && method === 'POST') {
      captured = init?.body ? JSON.parse(init.body as string) : null;
      return Promise.resolve(
        jsonResponse(200, {
          updated_count: 3,
          skipped_count: 1,
          errors: [],
        }),
      );
    }
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [LOCATION]));
    }
    if (url.includes('/api/stock')) {
      return Promise.resolve(jsonResponse(200, [MANUAL_ROW, DYNAMIC_ROW]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { lastBody: () => captured };
}

describe('StockPage — F2.1 dynamic min/max', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a Manual and a Dynamic mode badge for the two rows', async () => {
    mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, { role: 'pm' });
    expect(await screen.findByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Shakar')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('Dynamic')).toBeInTheDocument();
  });

  it('hides "Harakat qo‘shish" for PM (Stage 1 read-only) but keeps recalc', async () => {
    // Stock movements are writes (commit d76e06a) — PM is 403 there.
    // The min/max recalc is the configuration exemption and must
    // remain available for PM.
    mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, { role: 'pm' });
    await screen.findByText('Un');
    expect(
      screen.queryByRole('button', { name: /harakat qo.shish/i }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Min\/max qayta hisob/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/faqat o.qish/i)).toBeInTheDocument();
  });

  it('shows "Harakat qo‘shish" for a scoped central_warehouse_manager', async () => {
    mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, {
      role: 'central_warehouse_manager',
      locationId: 7,
      locationType: 'central_warehouse',
    });
    await screen.findByText('Un');
    expect(
      screen.getByRole('button', { name: /harakat qo.shish/i }),
    ).toBeInTheDocument();
  });

  it('hides "Harakat qo‘shish" for store_manager (unchanged)', async () => {
    // store_manager has never been allowed to record movements (§6).
    mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, {
      role: 'store_manager',
      locationId: 7,
      locationType: 'store',
    });
    await screen.findByText('Un');
    expect(
      screen.queryByRole('button', { name: /harakat qo.shish/i }),
    ).toBeNull();
  });

  it('hides the manual recalc button for non-PM roles', async () => {
    mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, {
      role: 'central_warehouse_manager',
      locationId: 7,
    });
    await screen.findByText('Un');
    expect(
      screen.queryByRole('button', { name: /Min\/max qayta hisob/ }),
    ).toBeNull();
  });

  it('PM can trigger recalc and sees a toast with the updated/skipped counts', async () => {
    const user = userEvent.setup();
    const sniff = mockListsAndCaptureRecalc();
    renderWithProviders(<StockPage />, { role: 'pm' });
    await screen.findByText('Un');

    await user.click(
      screen.getByRole('button', { name: /Min\/max qayta hisob/ }),
    );
    // Confirm dialog.
    expect(
      await screen.findByText('Min/max ni qayta hisoblaymi?'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Qayta hisoblash' }));

    await waitFor(() => {
      expect(sniff.lastBody()).not.toBeNull();
    });
    // No location filter set → empty object.
    expect(sniff.lastBody()).toEqual({});
    // Toast surfaces the counts.
    await waitFor(() => {
      expect(
        screen.getByText(
          /3 qator yangilandi, 1 sotuv tarixi yetishmasligi tufayli o‘tib yuborildi/,
        ),
      ).toBeInTheDocument();
    });
  });
});
