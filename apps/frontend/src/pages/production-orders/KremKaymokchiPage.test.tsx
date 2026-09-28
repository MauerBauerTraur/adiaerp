/**
 * Krem kaymokchi — what the kaymokchi owes each otdel, and a real "Berdim".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type { ProductionOrder } from '@/lib/types';
import { KremKaymokchiPage } from './KremKaymokchiPage';

function po(over: Partial<ProductionOrder> & { id: number; product_name: string }): ProductionOrder {
  return {
    product_id: over.id * 10,
    qty: 1,
    location_id: 7,
    location_name: 'Оформления отдел',
    target_location_id: null,
    target_location_name: null,
    status: 'new',
    deadline: null,
    note: null,
    parent_production_order_id: null,
    created_at: '2026-09-28T09:00:00',
    ...over,
  } as unknown as ProductionOrder;
}

const ORDERS: ProductionOrder[] = [
  po({ id: 1, product_name: 'Г/П СНИКЕРС', qty: 4, product_unit: 'pcs' } as never),
  po({ id: 2, product_name: 'ПИРАМИДА', qty: 60, product_unit: 'pcs' } as never),
  po({ id: 11, product_name: 'крем каймак', qty: 3.5, status: 'done', parent_production_order_id: 1, product_unit: 'kg' } as never),
  po({ id: 12, product_name: 'крем каймак', qty: 4, status: 'new', parent_production_order_id: 2, product_unit: 'kg' } as never),
];

function stubApi(): { method: string; url: string; body: string | null }[] {
  const calls: { method: string; url: string; body: string | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: (init?.body as string | undefined) ?? null });
    if (/\/api\/production-orders\/\d+\/bom/.test(url)) return jsonResponse(200, { bom: [] });
    if (url.includes('/api/production-orders?')) return jsonResponse(200, ORDERS);
    return jsonResponse(200, {});
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KremKaymokchiPage', () => {
  it('shows how much cream each otdel needs, what for, and what is still owed', async () => {
    stubApi();
    renderWithProviders(<KremKaymokchiPage />);
    const owed = await screen.findByText('Оформления отделga berish kerak');
    const box = owed.parentElement!;
    expect(within(box).getByText('7.5')).toBeInTheDocument();
    expect(within(box).getByText(/qoldi 4 kg/)).toBeInTheDocument();

    expect(screen.getByText('→ Г/П СНИКЕРС (4 pcs) uchun')).toBeInTheDocument();
    expect(screen.getByText('→ ПИРАМИДА (60 pcs) uchun')).toBeInTheDocument();
    expect(screen.getByText('1/2 ta berildi')).toBeInTheDocument();
  });

  it('"Berdim" marks the cream as handed over', async () => {
    const calls = stubApi();
    renderWithProviders(<KremKaymokchiPage />);
    await screen.findByText('Оформления отделga berish kerak');
    await userEvent.click(screen.getByRole('button', { name: 'Berdim' }));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/api/production-orders/12');
    expect(patch?.body).toContain('"done"');
  });
});
