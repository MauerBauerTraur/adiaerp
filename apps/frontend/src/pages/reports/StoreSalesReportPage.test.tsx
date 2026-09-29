/**
 * Do'konlar sotuvi — each store's Poster sales, with slices folded into cakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { navSectionsForRole } from '@/lib/navigation';
import {
  StoreSalesReportPage,
  groupCakes,
  type StoreSalesItem,
  type StoreSalesReport,
} from './StoreSalesReportPage';

const item = (over: Partial<StoreSalesItem>): StoreSalesItem => ({
  product_name: 'НАПОЛЕОН',
  modifier: null,
  poster_product_id: 440,
  modification_id: null,
  qty: 1,
  unit: 'pcs',
  revenue: 0,
  profit: 0,
  whole_factor: null,
  ...over,
});

const REPORT: StoreSalesReport = {
  from: '2026-09-28',
  to: '2026-09-28',
  generated_at: '2026-09-28T20:00:00Z',
  stores: [
    {
      spot_id: 1, name: 'Кукча', revenue: 19984430, profit: 15084240, checks: 171, avg_check: 116868,
      items: [item({ product_name: 'ТОРТ ЗАКАЗНОЙ', poster_product_id: 1, qty: 8, unit: 'kg', revenue: 1200000 })],
    },
    {
      spot_id: 2, name: 'Рабочий', revenue: 4029870, profit: 3517105, checks: 26, avg_check: 154995,
      items: [
        item({ modifier: 'КУСОК', modification_id: 1731, qty: 19, revenue: 456000, profit: 456000, whole_factor: 0.0625 }),
        item({ modifier: 'ПОЛОВИНА', modification_id: 1732, qty: 1, revenue: 192000, profit: 192000, whole_factor: 0.5 }),
        item({ product_name: 'КОРОБКИ', poster_product_id: 2244, modifier: 'Рулет 6-шт', modification_id: 2422, qty: 6, revenue: 15000, profit: 15000 }),
      ],
    },
    { spot_id: 7, name: 'Доставка', revenue: 0, profit: 0, checks: 0, avg_check: 0, items: [] },
  ],
};

function stubApi(): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    return jsonResponse(200, REPORT);
  });
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('groupCakes', () => {
  it('folds a cake\'s slices and halves into whole cakes and skips other modifiers', () => {
    const rows = groupCakes(REPORT.stores[1]!.items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_name: 'НАПОЛЕОН', sizes: { КУСОК: 19, ПОЛОВИНА: 1 }, revenue: 648000, partial: false });
    expect(rows[0]!.whole).toBeCloseTo(19 * 0.0625 + 0.5);
  });

  it('marks a cake whose slice weight is unknown', () => {
    const rows = groupCakes([item({ modifier: 'КУСОК', qty: 3, whole_factor: null })]);
    expect(rows[0]).toMatchObject({ whole: 0, partial: true });
  });
});

describe('StoreSalesReportPage', () => {
  it("opens on today's sales and shows the busiest store first", async () => {
    const urls = stubApi();
    renderWithProviders(<StoreSalesReportPage />);
    expect(await screen.findByText(/Кукча — 19/)).toBeInTheDocument();
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(urls.some((u) => u.includes(`/api/reports/store-sales?from=${today}&to=${today}`))).toBe(true);
    expect(screen.getByText('ТОРТ ЗАКАЗНОЙ')).toBeInTheDocument();
  });

  it('switches store and shows Poster rows with their modifiers', async () => {
    stubApi();
    renderWithProviders(<StoreSalesReportPage />);
    await screen.findByText(/Кукча — 19/);
    await userEvent.click(screen.getByRole('button', { name: /Рабочий/ }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('КУСОК')).toBeInTheDocument();
    expect(within(table).getByText('Рулет 6-шт')).toBeInTheDocument();
    expect(within(table).getByText('19 dona')).toBeInTheDocument();
  });

  it('shows cakes converted to whole cakes', async () => {
    stubApi();
    renderWithProviders(<StoreSalesReportPage />);
    await screen.findByText(/Кукча — 19/);
    await userEvent.click(screen.getByRole('button', { name: /Рабочий/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Tortlar butunga' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Половина 1 · Кусок 19')).toBeInTheDocument();
    expect(within(table).queryByText('КОРОБКИ')).not.toBeInTheDocument();
  });

  it('says so when a store sold nothing', async () => {
    stubApi();
    renderWithProviders(<StoreSalesReportPage />);
    await screen.findByText(/Кукча — 19/);
    await userEvent.click(screen.getByRole('button', { name: /Доставка/ }));
    expect(screen.getByText(/bu do'konda sotuv bo'lmagan/)).toBeInTheDocument();
  });
});

describe('Hisobotlar navigation', () => {
  it('is visible to PM and hidden from store managers', () => {
    expect(navSectionsForRole('pm').some((s) => s.key === 'reports')).toBe(true);
    expect(navSectionsForRole('store_manager').some((s) => s.key === 'reports')).toBe(false);
  });
});
