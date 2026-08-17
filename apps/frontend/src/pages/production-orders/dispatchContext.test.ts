/**
 * Unit tests for `buildDestinationContext` — the pure "what does this
 * become" grouping helper extracted from `WarehouseDispatchPage.tsx`'s
 * print functions (ADR-0016 zagatovka → ukrasheniye chain walk).
 */
import { describe, it, expect } from 'vitest';
import { buildDestinationContext, type OrderInfo } from './dispatchContext';
import type { ProductionDispatch } from '@/lib/types';

function order(overrides: Partial<OrderInfo> & { id: number }): OrderInfo {
  return {
    product_id: overrides.id * 10,
    product_name: `Product ${overrides.id}`,
    qty: 1,
    unit: 'kg',
    location_id: null,
    location_name: null,
    product_type: 'raw',
    production_cost: null,
    target_location_name: null,
    parent_production_order_id: null,
    parent_product_name: null,
    parent_unit: null,
    parent_qty: null,
    parent_production_cost: null,
    grandparent_production_order_id: null,
    grandparent_product_name: null,
    grandparent_unit: null,
    grandparent_qty: null,
    grandparent_production_cost: null,
    ...overrides,
  };
}

function dispatchItem(overrides: Partial<ProductionDispatch> & { id: number; production_order_id: number }): ProductionDispatch {
  return {
    product_id: 1,
    product_name: 'Un',
    product_unit: 'kg',
    qty_needed: 5,
    status: 'pending',
    from_location_id: null,
    to_location_id: null,
    movement_id: null,
    created_at: '2026-08-06T00:00:00.000Z',
    dispatched_at: null,
    dispatched_by: null,
    received_at: null,
    received_by: null,
    ...overrides,
  };
}

describe('buildDestinationContext', () => {
  it('returns empty groups when no items reference known orders', () => {
    const result = buildDestinationContext([], new Map());
    expect(result).toEqual({ zagotovkas: [], finishedGoods: [] });
  });

  it('groups a directly-dispatched finished order without any zagotovka chain', () => {
    const orderById = new Map<number, OrderInfo>([
      [1, order({ id: 1, product_type: 'finished', product_name: 'Napoleon', qty: 10, unit: 'pcs' })],
    ]);
    const items = [dispatchItem({ id: 100, production_order_id: 1 })];

    const result = buildDestinationContext(items, orderById);

    expect(result.zagotovkas).toEqual([]);
    expect(result.finishedGoods).toEqual([
      { product_id: 10, product_name: 'Napoleon', qty: 10, unit: 'pcs', production_cost: null },
    ]);
  });

  it('walks a zagotovka sub-order up to its root finished product', () => {
    const orderById = new Map<number, OrderInfo>([
      [1, order({ id: 1, product_type: 'finished', product_name: 'Napoleon', qty: 10, unit: 'pcs', production_cost: 25000 })],
      [2, order({ id: 2, product_type: 'semi', product_name: 'Napoleon zagotovka', qty: 8, unit: 'kg', parent_production_order_id: 1 })],
    ]);
    const items = [dispatchItem({ id: 101, production_order_id: 2 })];

    const result = buildDestinationContext(items, orderById);

    expect(result.zagotovkas).toEqual([
      { product_name: 'Napoleon zagotovka', qty: 8, unit: 'kg' },
    ]);
    expect(result.finishedGoods).toEqual([
      { product_id: 10, product_name: 'Napoleon', qty: 10, unit: 'pcs', production_cost: 25000 },
    ]);
  });

  it('merges duplicate zagotovka and finished-good names across multiple items', () => {
    const orderById = new Map<number, OrderInfo>([
      [1, order({ id: 1, product_type: 'finished', product_name: 'Medovik', qty: 5, unit: 'pcs' })],
      [2, order({ id: 2, product_type: 'semi', product_name: 'Medovik zagotovka', qty: 3, unit: 'kg', parent_production_order_id: 1 })],
      [3, order({ id: 3, product_type: 'semi', product_name: 'Medovik zagotovka', qty: 2, unit: 'kg', parent_production_order_id: 1 })],
    ]);
    const items = [
      dispatchItem({ id: 102, production_order_id: 2 }),
      dispatchItem({ id: 103, production_order_id: 3 }),
    ];

    const result = buildDestinationContext(items, orderById);

    expect(result.zagotovkas).toEqual([
      { product_name: 'Medovik zagotovka', qty: 5, unit: 'kg' },
    ]);
    expect(result.finishedGoods).toEqual([
      { product_id: 10, product_name: 'Medovik', qty: 5, unit: 'pcs', production_cost: null },
    ]);
  });

  it('falls back to grandparent fields when the root order two levels up is missing', () => {
    // getRootGP walks starting at the *parent's* id (order 3), so the
    // grandparent_* flattened columns that describe "3's parent" must live
    // on order 3's row — not on the originally-referenced semi order (2).
    const orderById = new Map<number, OrderInfo>([
      [
        2,
        order({
          id: 2,
          product_type: 'semi',
          product_name: 'Somsa hamiri',
          qty: 4,
          unit: 'kg',
          parent_production_order_id: 3,
        }),
      ],
      [
        3,
        order({
          id: 3,
          parent_production_order_id: 999, // not present in the map
          grandparent_production_order_id: 999,
          grandparent_product_name: 'Somsa',
          grandparent_unit: 'pcs',
          grandparent_qty: 40,
          grandparent_production_cost: 5000,
        }),
      ],
    ]);
    const items = [dispatchItem({ id: 104, production_order_id: 2 })];

    const result = buildDestinationContext(items, orderById);

    expect(result.finishedGoods).toEqual([
      { product_id: null, product_name: 'Somsa', qty: 40, unit: 'pcs', production_cost: 5000 },
    ]);
  });

  it('includes finished/gp orders at the same location via the locationName fallback', () => {
    const orderById = new Map<number, OrderInfo>([
      [1, order({ id: 1, product_type: 'semi', product_name: 'Tort zagotovka', qty: 6, unit: 'kg', location_name: 'Tort sexi' })],
      [2, order({ id: 2, product_type: 'gp', product_name: 'Shokoladli tort', qty: 3, unit: 'pcs', location_name: 'Tort sexi' })],
    ]);
    // Only the zagotovka order (id 1) is directly referenced by the dispatch item.
    const items = [dispatchItem({ id: 105, production_order_id: 1 })];

    const result = buildDestinationContext(items, orderById, { locationName: 'Tort sexi' });

    expect(result.finishedGoods).toEqual([
      { product_id: 20, product_name: 'Shokoladli tort', qty: 3, unit: 'pcs', production_cost: null },
    ]);
  });

  it('ignores the locationName fallback when no locationName option is given', () => {
    const orderById = new Map<number, OrderInfo>([
      [1, order({ id: 1, product_type: 'semi', product_name: 'Tort zagotovka', qty: 6, unit: 'kg', location_name: 'Tort sexi' })],
      [2, order({ id: 2, product_type: 'gp', product_name: 'Shokoladli tort', qty: 3, unit: 'pcs', location_name: 'Tort sexi' })],
    ]);
    const items = [dispatchItem({ id: 106, production_order_id: 1 })];

    const result = buildDestinationContext(items, orderById);

    expect(result.finishedGoods).toEqual([]);
  });
});
