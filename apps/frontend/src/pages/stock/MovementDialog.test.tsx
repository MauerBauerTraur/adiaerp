/**
 * Component test for MovementDialog.
 *
 * Sprint-1 audit findings pinned here:
 *  - a `<select>` value is always a string; `product_id` /
 *    `from_location_id` / `to_location_id` must be sent to the backend
 *    as `number` (otherwise movement creation fails with 422);
 *  - a one-sided in/out movement must map to `reason: 'adjust'` (not
 *    `purchase`); a two-sided move maps to `reason: 'transfer'`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { MovementDialog } from './MovementDialog';
import type { Location, Product } from '@/lib/types';

const PRODUCTS: Product[] = [
  {
    id: 11,
    name: 'Un',
    type: 'raw',
    unit: 'kg',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
  },
];

const LOCATIONS: Location[] = [
  {
    id: 21,
    name: 'Xom-ashyo ombori',
    type: 'raw_warehouse',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 22,
    name: 'Markaziy sklad',
    type: 'central_warehouse',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

/** Capture the POST body sent to `/api/stock/movement`. */
function mockMovementPost(): { lastBody: () => unknown } {
  let captured: unknown = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    captured = init?.body ? JSON.parse(init.body as string) : null;
    return Promise.resolve(jsonResponse(201, { id: 500 }));
  });
  return { lastBody: () => captured };
}

describe('MovementDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends numeric product_id / to_location_id and reason "adjust" for a kirim', async () => {
    const user = userEvent.setup();
    const post = mockMovementPost();

    renderWithProviders(
      <MovementDialog
        open
        onOpenChange={() => {}}
        products={PRODUCTS}
        locations={LOCATIONS}
        scopeLocationId="21"
        onSaved={() => {}}
      />,
    );

    // Default kind is "in" (kirim). Pick product + qty.
    await user.selectOptions(screen.getByLabelText('Mahsulot'), '11');
    await user.type(screen.getByLabelText('Miqdor'), '15');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => expect(post.lastBody()).not.toBeNull());
    const body = post.lastBody() as Record<string, unknown>;

    // Numbers, not strings — a string id triggers a 422 on the backend.
    expect(body.product_id).toBe(11);
    expect(typeof body.product_id).toBe('number');
    expect(body.to_location_id).toBe(21);
    expect(typeof body.to_location_id).toBe('number');
    expect(body.from_location_id).toBeNull();
    // A one-sided movement is an inventory adjust, never a purchase.
    expect(body.reason).toBe('adjust');
    expect(body.qty).toBe(15);
  });

  it('sends numeric from/to ids and reason "transfer" for a transfer', async () => {
    const user = userEvent.setup();
    const post = mockMovementPost();

    renderWithProviders(
      <MovementDialog
        open
        onOpenChange={() => {}}
        products={PRODUCTS}
        locations={LOCATIONS}
        scopeLocationId="21"
        onSaved={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Harakat turi'), 'transfer');
    await user.selectOptions(screen.getByLabelText('Mahsulot'), '11');
    await user.selectOptions(screen.getByLabelText('Manba bo‘g‘in'), '21');
    await user.selectOptions(screen.getByLabelText('Qabul qiluvchi'), '22');
    await user.type(screen.getByLabelText('Miqdor'), '5');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => expect(post.lastBody()).not.toBeNull());
    const body = post.lastBody() as Record<string, unknown>;

    expect(body.from_location_id).toBe(21);
    expect(body.to_location_id).toBe(22);
    expect(typeof body.from_location_id).toBe('number');
    expect(typeof body.to_location_id).toBe('number');
    expect(body.reason).toBe('transfer');
  });
});
