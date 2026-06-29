/**
 * Regression — RecipeDialog must parse the wrapped response shape.
 *
 * `GET /api/products/:id/recipe` returns `{ product_id, recipe: [...] }`
 * (apps/backend/src/routes/products.ts, asserted by apps/backend/test/products.test.ts
 * with `res.body.recipe`). The dialog calls
 * `apiRequest<RecipeLine[]>(...)` and then `.map(...)`'s the result —
 * which throws on the wrapped object and renders the toast
 * "Retseptni yuklab bo‘lmadi."
 *
 * The Prove-It pattern: this test FAILS today and stays as the
 * regression guard once the dialog reads `result.recipe`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { RecipeDialog } from './RecipeDialog';
import { jsonResponse } from '@/test/render-helpers';
import type { Product } from '@/lib/types';

const FLOUR: Product = {
  id: 1,
  name: 'Un (oliy nav)',
  type: 'raw',
  unit: 'kg',
  sku: 'RAW-FLOUR',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
};

const CAKE: Product = {
  id: 5,
  name: 'Shokoladli tort',
  type: 'finished',
  unit: 'pcs',
  sku: 'FIN-CHOCO-CAKE',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
};

describe('RecipeDialog — wrapped recipe envelope', () => {
  beforeEach(() => {
    localStorage.setItem('adia.token', 'fake-jwt');
  });
  afterEach(() => {
    localStorage.removeItem('adia.token');
    vi.restoreAllMocks();
  });

  it('renders the BOM line from `{ product_id, recipe: [...] }` (spec §4.3)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        product_id: 5,
        recipe: [
          { id: 1, product_id: 5, component_product_id: 1, qty_per_unit: '0.5000' },
        ],
      }),
    );

    await act(async () => {
      render(
        <ToastProvider>
          <RecipeDialog
            open
            onOpenChange={() => {}}
            product={CAKE}
            allProducts={[FLOUR, CAKE]}
            canEdit={false}
          />
        </ToastProvider>,
      );
    });

    // The error toast must NOT show; the loaded line must.
    await waitFor(() => {
      expect(screen.queryByText(/Retseptni yuklab bo/i)).toBeNull();
    });
    // The flour component must appear (either in a row label or select).
    expect(screen.getByText(/Un \(oliy nav\)/)).toBeTruthy();
  });
});
