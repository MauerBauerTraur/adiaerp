/**
 * EPIC 8 — contract tests for the kassa / chek & nakladnoy screens.
 *
 * The backend endpoints these pages target are not implemented yet
 * (gaps P8/P10/P11), so each page is built to an EXPECTED shape. These
 * tests pin that shape against fixtures and verify the two behaviours the
 * owner called out:
 *   - 8.3: an over-sold ("noto'g'ri urilgan") receipt is flagged;
 *   - 8.4: the nakladnoy renders per-stage sections plus an ITOGO total;
 *   - graceful 404 → "tayyorlanmoqda" empty state (endpoint not wired).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ReceiptsPage } from './ReceiptsPage';
import { CashShiftsPage } from './CashShiftsPage';
import { SafeExpensesPage } from './SafeExpensesPage';
import { NakladnoyPage } from './NakladnoyPage';
import { NakladnoyView } from './NakladnoyView';
import type {
  CashShiftsResponse,
  Nakladnoy,
  NakladnoyListResponse,
  ReceiptsStockResponse,
  SafeExpensesResponse,
} from '@/lib/types';

const NAKLADNOY: Nakladnoy = {
  id: 7,
  product_id: 100,
  product_name: 'Napoleon',
  order_qty: 10,
  store_id: 3,
  store_name: 'Kukcha',
  created_at: '2026-05-29T08:00:00.000Z',
  sections: [
    {
      stage: 'dough',
      lines: [
        { product_id: 1, product_name: 'Un', unit: 'kg', qty: 5 },
        { product_id: 2, product_name: 'Shakar', unit: 'kg', qty: 2 },
      ],
    },
    {
      stage: 'cream',
      lines: [
        { product_id: 1, product_name: 'Un', unit: 'kg', qty: 1 },
        { product_id: 2, product_name: 'Shakar', unit: 'kg', qty: 3 },
      ],
    },
  ],
  totals: [
    { product_id: 1, product_name: 'Un', unit: 'kg', qty: 6 },
    { product_id: 2, product_name: 'Shakar', unit: 'kg', qty: 5 },
  ],
};

const RECEIPTS: ReceiptsStockResponse = {
  total: 2,
  limit: 50,
  offset: 0,
  items: [
    {
      poster_transaction_id: 5001,
      store_id: 3,
      store_name: 'Kukcha',
      sold_at: '2026-05-29T09:00:00.000Z',
      total_qty: 5,
      total_revenue: 250000,
      line_count: 1,
      has_force_majeure: false,
      lines: [
        {
          product_id: 100,
          product_name: 'Napoleon',
          product_unit: 'pcs',
          opening_qty: 10,
          sold_qty: 5,
          remaining_qty: 5,
        },
      ],
    },
    {
      poster_transaction_id: 5002,
      store_id: 3,
      store_name: 'Kukcha',
      sold_at: '2026-05-29T10:00:00.000Z',
      total_qty: 11,
      total_revenue: 550000,
      line_count: 1,
      has_force_majeure: true,
      lines: [
        {
          product_id: 100,
          product_name: 'Napoleon',
          product_unit: 'pcs',
          opening_qty: 10,
          sold_qty: 11,
          remaining_qty: -1,
        },
      ],
    },
  ],
};

const SHIFTS: CashShiftsResponse = {
  items: [
    {
      id: 1,
      store_id: 3,
      store_name: 'Kukcha',
      status: 'closed',
      opened_at: '2026-05-29T07:00:00.000Z',
      closed_at: '2026-05-29T21:00:00.000Z',
      cashier_name: 'Aziza',
      total_sales: 8000000,
      card_amount: 2000000,
      cash_amount: 6000000,
      expense_amount: 5000000,
      collected_amount: 0,
      closing_balance: 1000000,
      balance_discrepancy: 0,
    },
  ],
};

const EXPENSES: SafeExpensesResponse = {
  items: [
    {
      id: 1,
      spent_at: '2026-05-29T12:00:00.000Z',
      amount: 1500000,
      category: 'Ijara',
      note: 'May oyi',
      recorded_by_name: 'PM User',
    },
  ],
};

function mockGet(path: string, body: unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes(path)) return Promise.resolve(jsonResponse(status, body));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function mock404() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'Resurs topilmadi.' },
      }),
    ),
  );
}

describe('EPIC 8 — kassa / nakladnoy screens', () => {
  afterEach(() => vi.restoreAllMocks());

  it('NakladnoyView renders per-stage sections + ITOGO total (8.4)', () => {
    renderWithProviders(<NakladnoyView nakladnoy={NAKLADNOY} />, { role: 'pm' });
    expect(screen.getByText('Hamir uchun')).toBeInTheDocument();
    expect(screen.getByText('Krem uchun')).toBeInTheDocument();
    expect(screen.getByText('Itogo (umumiy)')).toBeInTheDocument();
    // Un appears in both sections + the ITOGO roll-up.
    expect(screen.getAllByText('Un').length).toBeGreaterThanOrEqual(3);
    // ITOGO total for Un = 6 kg.
    expect(screen.getByText(/6 kg/)).toBeInTheDocument();
  });

  it('ReceiptsPage flags an over-sold receipt as fors-major (8.3)', async () => {
    mockGet('/api/sales/receipts/stock', RECEIPTS);
    renderWithProviders(<ReceiptsPage />, { role: 'pm' });
    expect(await screen.findByText('Chek #5001')).toBeInTheDocument();
    expect(screen.getByText('Chek #5002')).toBeInTheDocument();
    // The fors-major summary button reports exactly one bad receipt.
    expect(
      screen.getByText(/1 ta noto.*urilgan chek/),
    ).toBeInTheDocument();
    expect(screen.getByText('Fors-major')).toBeInTheDocument();
  });

  it('ReceiptsPage degrades to a "tayyorlanmoqda" empty state on 404', async () => {
    mock404();
    renderWithProviders(<ReceiptsPage />, { role: 'pm' });
    expect(
      await screen.findByText(/tayyorlanmoqda/i),
    ).toBeInTheDocument();
  });

  it('CashShiftsPage renders a closed shift balance (8.5)', async () => {
    mockGet('/api/cash-shifts', SHIFTS);
    renderWithProviders(<CashShiftsPage />, { role: 'pm' });
    expect(await screen.findByText('Itogo savdo')).toBeInTheDocument();
    expect(screen.getByText(/Smena #1/)).toBeInTheDocument();
    expect(screen.getByText('Inkassatsiya')).toBeInTheDocument();
  });

  it('SafeExpensesPage lists expenses with a total (8.7)', async () => {
    mockGet('/api/safe-expenses', EXPENSES);
    renderWithProviders(<SafeExpensesPage />, { role: 'pm' });
    expect(await screen.findByText('Ijara')).toBeInTheDocument();
    expect(screen.getByText(/Jami:/)).toBeInTheDocument();
  });

  it('NakladnoyPage shows a collapsed nakladnoy row that expands (8.4)', async () => {
    const body: NakladnoyListResponse = { items: [NAKLADNOY] };
    mockGet('/api/nakladnoy', body);
    renderWithProviders(<NakladnoyPage />, { role: 'pm' });
    expect(
      await screen.findByText('10 × Napoleon'),
    ).toBeInTheDocument();
  });
});
