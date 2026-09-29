/**
 * Ishlab chiqarish hisoboti — problems first, then totals, products, otdels,
 * warehouses and supplies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ProductionDailyReportPage, type ProductionDailyReport } from './ProductionDailyReportPage';

const REPORT: ProductionDailyReport = {
  from: '2026-09-28',
  to: '2026-09-28',
  generated_at: '2026-09-28T20:00:00Z',
  summary: {
    orders: 3, otdels: 1, ordered_qty: 26, produced_qty: 16, done_orders: 2,
    cost_total: 928000, sales_total: 1580000, profit_total: 652000, margin_pct: 41.3,
    supplies_total: 480000, supplies_count: 1,
  },
  products: [
    { product_id: 1, product_name: 'Г/П СНИКЕРС', unit: 'pcs', location_id: 7, location_name: 'Оформления отдел', ordered_qty: 4, produced_qty: 4, pending_orders: 0, unit_cost: 4000, sell_price: 185000, cost_total: 16000, sales_total: 740000, profit_total: 724000, loss: false },
    { product_id: 2, product_name: 'Г/П МЕДОВИК', unit: 'pcs', location_id: 7, location_name: 'Оформления отдел', ordered_qty: 12, produced_qty: 12, pending_orders: 0, unit_cost: 76000, sell_price: 70000, cost_total: 912000, sales_total: 840000, profit_total: -72000, loss: true },
    { product_id: 3, product_name: 'Г/П КАПРИЗ', unit: 'pcs', location_id: 7, location_name: 'Оформления отдел', ordered_qty: 10, produced_qty: 0, pending_orders: 1, unit_cost: 8000, sell_price: 180000, cost_total: 0, sales_total: 0, profit_total: 0, loss: false },
  ],
  otdels: [
    { location_id: 7, location_name: 'Оформления отдел', orders: 3, produced_qty: 16, raw_given_value: 16000, cost_total: 928000, sales_total: 1580000, profit_total: 652000 },
  ],
  stock: {
    groups: [
      { key: 'central', label: 'Markaziy sklad (tayyor mahsulot)', value: 20000 },
      { key: 'raw', label: 'Xomashyo ombori', value: 180000 },
      { key: 'zagotovka', label: 'Zagotovka ombori', value: 0 },
    ],
    low: [{ product_name: 'тухум', unit: 'pcs', qty: 120, min_level: 500, location_name: 'Основной склад' }],
  },
  supplies: [{ supplier_name: 'Абдукаххор сут', storage_name: 'Основной склад', date: '2026-09-28 11:10:30', sum: 480000 }],
  problems: {
    losses: [{ product_name: 'Г/П МЕДОВИК', location_name: 'Оформления отдел', loss: -72000 }],
    unfinished: [{ order_id: 3812, product_name: 'Г/П КАПРИЗ', location_name: 'Оформления отдел', qty: 10, status: 'new' }],
  },
  warnings: [],
};

function stubApi(body: unknown = REPORT): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    return jsonResponse(200, body);
  });
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProductionDailyReportPage', () => {
  it("opens on today's report", async () => {
    const urls = stubApi();
    renderWithProviders(<ProductionDailyReportPage />);
    await screen.findByText('Mahsulotlar bo\'yicha');
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(urls.some((u) => u.includes(`/api/reports/production-daily?from=${today}&to=${today}`))).toBe(true);
  });

  it('puts problems first: losses, unfinished orders, low raw materials', async () => {
    stubApi();
    renderWithProviders(<ProductionDailyReportPage />);
    const problems = await screen.findByRole('region', { name: "E'tibor talab qiladi" });
    expect(within(problems).getByText('Zararda')).toBeInTheDocument();
    expect(within(problems).getByText(/#3812 Г\/П КАПРИЗ/)).toBeInTheDocument();
    expect(within(problems).getByText(/тухум/)).toBeInTheDocument();
  });

  it('shows products with loss and in-progress tags, and otdels with raw issued', async () => {
    stubApi();
    renderWithProviders(<ProductionDailyReportPage />);
    await screen.findByText("Mahsulotlar bo'yicha");
    expect(screen.getByText('zarar')).toBeInTheDocument();
    expect(screen.getByText('jarayonda')).toBeInTheDocument();
    expect(screen.getAllByText('16 000').length).toBeGreaterThan(0);
    expect(screen.getByText('Абдукаххор сут')).toBeInTheDocument();
  });

  it('shows Poster warnings and a missing-supplies state', async () => {
    stubApi({ ...REPORT, supplies: null, summary: { ...REPORT.summary, supplies_total: null, supplies_count: null }, warnings: ["Poster'dan postavkalarni olib bo'lmadi — kirim ko'rsatilmadi."] });
    renderWithProviders(<ProductionDailyReportPage />);
    expect(await screen.findByText(/postavkalarni olib bo'lmadi/)).toBeInTheDocument();
    expect(screen.getByText("Poster'dan olinmadi.")).toBeInTheDocument();
  });
});
