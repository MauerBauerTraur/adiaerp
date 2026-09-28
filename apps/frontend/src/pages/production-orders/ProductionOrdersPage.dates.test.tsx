/**
 * Zayavkalar — the date bar: which day's orders are listed, and how many.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type { ProductionOrder } from '@/lib/types';
import { ProductionOrdersPage } from './ProductionOrdersPage';

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function order(id: number, name: string, createdAt: string): ProductionOrder {
  return {
    id,
    product_id: id * 10,
    product_name: name,
    qty: 10,
    location_id: 1,
    location_name: 'Оформления отдел',
    target_location_id: null,
    target_location_name: null,
    status: 'done',
    deadline: '2026-09-28',
    note: null,
    parent_production_order_id: null,
    created_at: createdAt,
  } as unknown as ProductionOrder;
}

function stubApi(orders: ProductionOrder[]): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/production-orders')) return jsonResponse(200, orders);
    return jsonResponse(200, []);
  });
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProductionOrdersPage — date bar', () => {
  it("opens on today's orders", async () => {
    const urls = stubApi([order(1, 'Г/П СНИКЕРС', new Date().toISOString())]);
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    await screen.findByText('Г/П СНИКЕРС');
    const today = localIso(new Date());
    expect(urls.some((u) => u.includes(`from_date=${today}`) && u.includes(`to_date=${today}`))).toBe(true);
  });

  it('"Hammasi" drops the date filter and groups the list by day with a count', async () => {
    const urls = stubApi([
      order(3, 'Г/П КАПРИЗ', '2026-09-28T09:00:00'),
      order(2, 'ПИРАМИДА', '2026-09-28T08:00:00'),
      order(1, 'Г/П НАПОЛЕОН', '2026-09-27T10:00:00'),
    ]);
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    await userEvent.click(await screen.findByRole('button', { name: 'Hammasi' }));
    await screen.findByText('Г/П НАПОЛЕОН');

    const last = urls.filter((u) => u.includes('/api/production-orders')).at(-1) ?? '';
    expect(last).not.toContain('from_date');
    expect(last).not.toContain('to_date');

    // Day headers carry the date and that day's count (the deadline column
    // shows dates too, so anchor on the header cell).
    expect(screen.getByText('2 ta zayafka').closest('td')).toHaveTextContent('28.09.2026');
    expect(screen.getByText('1 ta zayafka').closest('td')).toHaveTextContent('27.09.2026');
  });

  it('shows when each order was given', async () => {
    stubApi([order(1, 'Г/П СНИКЕРС', '2026-09-28T14:35:00')]);
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    await userEvent.click(await screen.findByRole('button', { name: 'Hammasi' }));
    expect(await screen.findByText('28.09.2026 14:35')).toBeInTheDocument();
  });
});
