/**
 * "Ustalar bo'yicha chop etish" on Xomashyo berish (ADR-0019 Phase A):
 * the per-department button prints one slip per usta + the otdel matrix,
 * built from the daily-dispatch data the page already loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type { DailyDispatchResponse, ProductionDispatch } from '@/lib/types';
import { WarehouseDispatchPage } from './WarehouseDispatchPage';

const OTDEL = 7;

type ApiOrder = DailyDispatchResponse['orders'][number];

function order(over: Partial<ApiOrder> & Pick<ApiOrder, 'id' | 'product_name'>): ApiOrder {
  return {
    product_id: over.id * 10,
    qty: 1,
    unit: 'kg',
    location_id: OTDEL,
    location_name: 'Оформления отдел',
    product_type: 'semi',
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
    ...over,
  };
}

function raw(id: number, orderId: number, product_name: string, qty_needed: number, product_unit = 'kg'): ProductionDispatch {
  return {
    id,
    production_order_id: orderId,
    product_id: 900 + id,
    product_name,
    product_unit,
    qty_needed,
    status: 'pending',
    from_location_id: 1,
    from_location_name: 'Xom-ashyo ombori',
    from_location_type: 'raw_warehouse',
    product_type: 'raw',
    to_location_id: OTDEL,
    to_location_name: 'Оформления отдел',
    movement_id: null,
    created_at: '2026-09-28T06:00:00Z',
    dispatched_at: null,
    dispatched_by: null,
    received_at: null,
    received_by: null,
  };
}

const DATA: DailyDispatchResponse = {
  date: '2026-09-28',
  orders: [
    order({ id: 101, product_name: 'Г/П МЕДОВИК', qty: 10, unit: 'pcs', product_type: 'gp' }),
    order({ id: 102, product_name: 'з/г медовик', qty: 10, unit: 'pcs', parent_production_order_id: 101 }),
    order({ id: 103, product_name: 'бисквит медовый', qty: 2.5, parent_production_order_id: 102 }),
  ],
  dispatch: [],
  dispatch_items: [
    raw(1, 103, 'мука', 1.2),
    raw(2, 102, 'сахар', 0.5),
    raw(3, 101, 'шоколад', 0.3),
  ],
};

describe('WarehouseDispatchPage — usta split print', () => {
  beforeEach(() => {
    localStorage.setItem('adia.token', 'fake-jwt');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/production-orders/daily-dispatch')) return jsonResponse(200, DATA);
      return jsonResponse(500, { error: { code: 'TEST', message: `Unmocked ${url}` } });
    });
  });
  afterEach(() => {
    localStorage.removeItem('adia.token');
    vi.restoreAllMocks();
  });

  it('shows the button for a department group and prints one slip per usta + the matrix', async () => {
    const written: string[] = [];
    const fakeWindow = { document: { write: (h: string) => written.push(h), close: () => {} } };
    const open = vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
    const user = userEvent.setup();

    renderWithProviders(<WarehouseDispatchPage productTypeFilter="raw" />, { role: 'raw_warehouse_manager', locationId: 1, locationType: 'raw_warehouse' });

    const button = await screen.findByRole('button', { name: "Ustalar bo'yicha chop etish" });
    await user.click(button);

    expect(open).toHaveBeenCalledTimes(1);
    const html = written.join('');
    expect(html).toContain('Оформления отдел — ustalar bo');
    for (const usta of ['Biskvitchi', 'Zagotovkachi', 'Ukrasheniye']) {
      expect(html).toContain(`<span class="usta">${usta}</span>`);
    }
    expect(html).toContain('Oladi — Biskvitchidan');
    expect(html).toContain('Topshiradi → Склад');
    expect(html).toContain('Ustalar matritsasi');
  });
});
