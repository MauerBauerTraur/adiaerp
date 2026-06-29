/**
 * F4.11 Bug-MIN-01 — the "Maqsad bo'g'in" dropdown in the production
 * order form must enumerate every valid output destination (central
 * warehouse + supply departments), not just the locations the parent
 * page's `/api/locations` call happened to return.
 *
 * Before the fix the dialog re-used the parent's `locations` prop,
 * which for a scoped manager is filtered down to their own row — so a
 * production manager opening the form saw their own production
 * location as the only target option, and PMs saw it mixed with raw
 * warehouses, stores and themselves. The new behaviour fetches
 * `GET /api/locations?type=central_warehouse` and
 * `GET /api/locations?type=supply` directly inside the dialog and
 * merges the two.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ProductionOrderFormDialog } from './ProductionOrderFormDialog';
import type { Location, Product } from '@/lib/types';

const PRODUCT: Product = {
  id: 5,
  name: 'Tort tayyor',
  type: 'finished',
  unit: 'pcs',
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const PROD_LOC: Location = {
  id: 9,
  name: 'Ishlab chiqarish',
  type: 'production',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const CENTRAL_WAREHOUSE: Location = {
  ...PROD_LOC,
  id: 21,
  name: 'Markaziy sklad',
  type: 'central_warehouse',
};

const SUPPLY_A: Location = {
  ...PROD_LOC,
  id: 31,
  name: "Ta'minot — sut",
  type: 'supply',
};

const SUPPLY_B: Location = {
  ...PROD_LOC,
  id: 32,
  name: "Ta'minot — un",
  type: 'supply',
};

/** Spies on /api/locations?type= and returns the right slice per query. */
function mockLocationsByType() {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    seen.push(url);
    if (url.includes('/api/locations?type=central_warehouse')) {
      return Promise.resolve(jsonResponse(200, [CENTRAL_WAREHOUSE]));
    }
    if (url.includes('/api/locations?type=supply')) {
      return Promise.resolve(jsonResponse(200, [SUPPLY_A, SUPPLY_B]));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return seen;
}

describe('ProductionOrderFormDialog — target dropdown (Bug-MIN-01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every central_warehouse and supply location as a target option', async () => {
    mockLocationsByType();
    // The parent (a production_manager) only has its own production
    // location available in `locations` — historically that meant the
    // target dropdown had nothing useful in it. The dialog must now
    // fetch the right options itself.
    renderWithProviders(
      <ProductionOrderFormDialog
        open
        onOpenChange={() => {}}
        products={[PRODUCT]}
        locations={[PROD_LOC]}
        onSaved={() => {}}
      />,
      { role: 'production_manager', locationId: 9 },
    );

    const target = (await screen.findByLabelText(
      /Maqsad bo‘g‘in/i,
    )) as HTMLSelectElement;

    await waitFor(() => {
      // Two supply options + one central warehouse + the placeholder.
      expect(target.options.length).toBeGreaterThanOrEqual(4);
    });

    // The actual option labels — order-independent.
    expect(within(target).getByText('Markaziy sklad')).toBeInTheDocument();
    expect(within(target).getByText("Ta'minot — sut")).toBeInTheDocument();
    expect(within(target).getByText("Ta'minot — un")).toBeInTheDocument();
  });

  it('does NOT include production-only locations in the target dropdown', async () => {
    mockLocationsByType();
    renderWithProviders(
      <ProductionOrderFormDialog
        open
        onOpenChange={() => {}}
        products={[PRODUCT]}
        // Parent passes a production location — it must show up in the
        // "Ishlab chiqarish bo'g'ini" select, but NOT in the target
        // dropdown (output never flows back to the production line).
        locations={[PROD_LOC]}
        onSaved={() => {}}
      />,
      { role: 'pm' },
    );

    const target = (await screen.findByLabelText(
      /Maqsad bo‘g‘in/i,
    )) as HTMLSelectElement;

    await waitFor(() => {
      expect(within(target).queryByText('Markaziy sklad')).toBeInTheDocument();
    });

    // The production location must NOT leak into the target options.
    expect(within(target).queryByText('Ishlab chiqarish')).toBeNull();
  });

  it('skips the target fetches while the dialog is closed', () => {
    const seen = mockLocationsByType();
    renderWithProviders(
      <ProductionOrderFormDialog
        open={false}
        onOpenChange={() => {}}
        products={[PRODUCT]}
        locations={[PROD_LOC]}
        onSaved={() => {}}
      />,
      { role: 'pm' },
    );
    // useApiQuery is gated on the open flag — no network calls.
    expect(seen).toEqual([]);
  });
});
