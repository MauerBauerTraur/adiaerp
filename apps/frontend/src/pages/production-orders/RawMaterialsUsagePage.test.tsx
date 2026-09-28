/**
 * Xomashyo iste'moli — what was given to production on the chosen days.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { RawMaterialsUsagePage, type UsageRow } from './RawMaterialsUsagePage';

const ROWS: UsageRow[] = [
  { product_id: 1, product_name: 'тухум', unit: 'pcs', source: 'ombordan', total_qty: 357, order_count: 5, total_cost: 481950 },
  { product_id: 2, product_name: 'ун', unit: 'kg', source: 'ombordan', total_qty: 13.115, order_count: 5, total_cost: null },
  { product_id: 3, product_name: 'крем каймак', unit: 'kg', source: 'sexdan', total_qty: 4, order_count: 2, total_cost: null },
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stubApi(): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    return jsonResponse(200, ROWS);
  });
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RawMaterialsUsagePage', () => {
  it("opens on today's date", async () => {
    const urls = stubApi();
    renderWithProviders(<RawMaterialsUsagePage />);
    await screen.findByText('тухум');
    const today = todayIso();
    expect(urls.some((u) => u.includes(`from=${today}&to=${today}`))).toBe(true);
  });

  it('shows warehouse-issued raw materials first and semi hand-overs on their own tab', async () => {
    stubApi();
    renderWithProviders(<RawMaterialsUsagePage />);
    await screen.findByText('тухум');
    expect(screen.getByText('ун')).toBeInTheDocument();
    expect(screen.queryByText('крем каймак')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Sexlardan kelgan yarim tayyor' }));
    expect(screen.getByText('крем каймак')).toBeInTheDocument();
    expect(screen.queryByText('тухум')).not.toBeInTheDocument();
  });

  it('refuses a range whose start is after its end', async () => {
    stubApi();
    renderWithProviders(<RawMaterialsUsagePage />);
    await screen.findByText('тухум');
    const fromInput = screen.getByLabelText('Dan');
    await userEvent.clear(fromInput);
    await userEvent.type(fromInput, '2099-01-02');
    const toInput = screen.getByLabelText('Gacha');
    await userEvent.clear(toInput);
    await userEvent.type(toInput, '2099-01-01');
    expect(screen.getByRole('button', { name: "Ko'rsatish" })).toBeDisabled();
    expect(screen.getByText(/sanasidan keyin bo'lmasligi kerak/)).toBeInTheDocument();
  });
});
