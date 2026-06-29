/**
 * Sprint-2 contract test for purchase orders + the two-step approval.
 *
 * Verifies the bare `PurchaseOrder[]` list shape and that approve calls
 * are gated by role: `supply_manager` may sign the manager step only,
 * `raw_warehouse_manager` may sign the keeper step only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { PurchaseOrdersPage } from './PurchaseOrdersPage';
import type { PurchaseOrder } from '@/lib/types';

const PRODUCT = {
  id: 3,
  name: 'Un',
  type: 'raw' as const,
  unit: 'kg' as const,
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const RAW_LOC = {
  id: 4,
  name: 'Xom-ashyo ombori',
  type: 'raw_warehouse' as const,
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const ORDER: PurchaseOrder = {
  id: 88,
  product_id: 3,
  qty: 200,
  supplier_id: null,
  target_location_id: 4,
  status: 'draft',
  replenishment_id: null,
  manager_approved_by: null,
  manager_approved_at: null,
  keeper_approved_by: null,
  keeper_approved_at: null,
  received_movement_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T10:00:00.000Z',
  updated_at: '2026-05-22T10:00:00.000Z',
  product_name: 'Un',
  target_location_name: 'Xom-ashyo ombori',
  manager_approved_name: null,
  keeper_approved_name: null,
  supplier_name: null,
};

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, [PRODUCT]));
    }
    if (url.includes('/api/locations')) {
      return Promise.resolve(jsonResponse(200, [RAW_LOC]));
    }
    if (url.includes('/api/purchase-orders/88/approve') && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return Promise.resolve(
        jsonResponse(200, {
          purchase_order: {
            ...ORDER,
            ...(body.step === 'manager'
              ? {
                  manager_approved_by: 9,
                  manager_approved_at: '2026-05-22T11:00:00.000Z',
                }
              : {
                  keeper_approved_by: 10,
                  keeper_approved_at: '2026-05-22T11:00:00.000Z',
                }),
          },
        }),
      );
    }
    if (url.includes('/api/purchase-orders')) {
      return Promise.resolve(jsonResponse(200, [ORDER]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('PurchaseOrdersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders rows from a bare PurchaseOrder[]', async () => {
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, { role: 'pm' });
    expect(await screen.findByText('Un')).toBeInTheDocument();
    // Embedded `target_location_name` is rendered directly (no
    // client-side join on locations).
    expect(screen.getByText('Xom-ashyo ombori')).toBeInTheDocument();
    expect(screen.getAllByText('Loyiha').length).toBeGreaterThan(0);
  });

  it('lets a supply_manager sign the manager step but not the keeper step', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, { role: 'supply_manager' });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    // Manager step action is visible …
    expect(
      await screen.findByRole('button', { name: 'Tasdiqlash (boshliq)' }),
    ).toBeInTheDocument();
    // … but the keeper step action is hidden for this role.
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (skladchi)' }),
    ).toBeNull();
  });

  it('lets a raw_warehouse_manager sign the keeper step only', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'raw_warehouse_manager',
      locationId: 4, // ORDER.target_location_id — Stage 4 RBAC scoping
      locationType: 'raw_warehouse',
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    expect(
      await screen.findByRole('button', { name: 'Tasdiqlash (skladchi)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (boshliq)' }),
    ).toBeNull();
  });

  it('hides every approval button for PM (Stage 1 read-only)', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, { role: 'pm' });
    await screen.findByText('Un');
    // The list-level "Yangi sotib olish" button must be gone …
    expect(
      screen.queryByRole('button', { name: /yangi sotib olish/i }),
    ).toBeNull();
    // … and the per-row approval panel must render no actionable buttons.
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (boshliq)' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (skladchi)' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /rad etish/i })).toBeNull();
    expect(screen.getByText(/faqat o.qish/i)).toBeInTheDocument();
  });

  it('hides the keeper button for a raw_warehouse_manager on a foreign warehouse', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'raw_warehouse_manager',
      locationId: 99, // foreign — ORDER.target_location_id is 4
      locationType: 'raw_warehouse',
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (skladchi)' }),
    ).toBeNull();
  });

  it('hides the manager button for a supply_manager who is not the creator', async () => {
    // ORDER.created_by === 1; render as a DIFFERENT supply_manager
    // (id=2). The backend enforces created_by === user.id on the
    // manager step (purchaseOrders.ts L274), so the button must not
    // render for anyone else — even another supply_manager.
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'supply_manager',
      userId: 2,
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    expect(
      screen.queryByRole('button', { name: 'Tasdiqlash (boshliq)' }),
    ).toBeNull();
    // Reject is still allowed for any supply_manager (no per-PO scope).
    expect(
      screen.getByRole('button', { name: /rad etish/i }),
    ).toBeInTheDocument();
  });

  it('posts the keeper approval with step:"keeper"', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'raw_warehouse_manager',
      locationId: 4, // ORDER.target_location_id — Stage 4 RBAC scoping
      locationType: 'raw_warehouse',
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    await user.click(
      await screen.findByRole('button', { name: 'Tasdiqlash (skladchi)' }),
    );
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/purchase-orders/88/approve'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"step":"keeper"'),
        }),
      );
    });
  });
});
