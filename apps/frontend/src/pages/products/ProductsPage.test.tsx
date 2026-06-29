/**
 * EPIC 1 — ProductsPage feature tests.
 *
 *   1.1 custom filter popover (type + unit) drives the visible set;
 *   1.2 translit search (Latin query → Cyrillic product name);
 *   1.3 smart category — Г/П prefix surfaces as a "Tayyor mahsulot" item;
 *   1.4b default filter = finished (raw products hidden until cleared).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { ProductsPage } from './ProductsPage';
import type { Product } from '@/lib/types';

function product(overrides: Partial<Product>): Product {
  return {
    id: 1,
    name: 'X',
    type: 'finished',
    unit: 'pcs',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
    ...overrides,
  };
}

const FLOUR = product({ id: 1, name: 'Un (oliy nav)', type: 'raw', unit: 'kg' });
const CHOCO_CAKE = product({
  id: 2,
  name: 'Шоколадный торт',
  type: 'finished',
  unit: 'pcs',
});
const READY_ECLAIR = product({
  id: 3,
  name: 'Г/П Эклер',
  type: 'semi',
  unit: 'pcs',
});

function mockProducts(items: Product[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/products')) {
      return Promise.resolve(jsonResponse(200, items));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe('ProductsPage — EPIC 1', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to finished products and hides raw (EPIC 1.4b)', async () => {
    mockProducts([FLOUR, CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    expect(await screen.findByText('Шоколадный торт')).toBeInTheDocument();
    expect(screen.queryByText('Un (oliy nav)')).not.toBeInTheDocument();
  });

  it('treats a Г/П-prefixed product as finished (EPIC 1.3)', async () => {
    mockProducts([READY_ECLAIR]);
    renderWithProviders(<ProductsPage />);

    // Despite stored type=semi, the Г/П prefix surfaces it under the default
    // finished filter.
    expect(await screen.findByText('Г/П Эклер')).toBeInTheDocument();
  });

  it('finds a Cyrillic product name via a Latin query (EPIC 1.2)', async () => {
    const user = userEvent.setup();
    mockProducts([CHOCO_CAKE, product({ id: 9, name: 'Наполеон' })]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');
    await user.type(
      screen.getByLabelText('Mahsulot qidirish'),
      'shokolad',
    );

    await waitFor(() => {
      expect(screen.getByText('Шоколадный торт')).toBeInTheDocument();
      expect(screen.queryByText('Наполеон')).not.toBeInTheDocument();
    });
  });

  it('filter popover can reveal raw products (EPIC 1.1)', async () => {
    const user = userEvent.setup();
    mockProducts([FLOUR, CHOCO_CAKE]);
    renderWithProviders(<ProductsPage />);

    await screen.findByText('Шоколадный торт');

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    // Clear the default finished selection, pick raw, apply.
    await user.click(
      screen.getByRole('button', { name: 'Hammasini tozalash' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Xom-ashyo' }));
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    await waitFor(() => {
      expect(screen.getByText('Un (oliy nav)')).toBeInTheDocument();
      expect(screen.queryByText('Шоколадный торт')).not.toBeInTheDocument();
    });
  });

  it('shows a result count (EPIC 1.4)', async () => {
    mockProducts([CHOCO_CAKE, READY_ECLAIR]);
    renderWithProviders(<ProductsPage />);
    expect(await screen.findByText('2 ta mahsulot')).toBeInTheDocument();
  });
});
