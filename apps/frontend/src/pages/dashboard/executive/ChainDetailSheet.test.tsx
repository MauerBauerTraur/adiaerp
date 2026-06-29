import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChainDetailSheet } from './ChainDetailSheet';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string) => unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = handler(url);
    return Promise.resolve(jsonResponse(200, body ?? {}));
  });
}

const EMPTY_RAW = {
  kpis: {
    raw_product_types: 0,
    total_stock_by_unit: [],
    below_min_count: 0,
    open_purchase_orders: 0,
  },
  daily_movements: [],
  below_min_items: [],
  pending_purchase_orders: [],
};

describe('ChainDetailSheet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not visible when type is null', () => {
    render(
      <ChainDetailSheet
        type={null}
        range={{ range: 'today' }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/batafsil/i)).not.toBeInTheDocument();
  });

  it('opens and renders the Raw header + accent when type=raw_warehouse', async () => {
    stubFetch(() => EMPTY_RAW);
    render(
      <ChainDetailSheet
        type="raw_warehouse"
        range={{ range: 'today' }}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(/Xom-ashyo ombori — batafsil/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('chain-detail-accent-raw_warehouse'),
    ).toBeInTheDocument();
  });

  it('renders the Production header when type=production', async () => {
    stubFetch(() => ({
      kpis: { active_orders: 0, done_today: 0, overdue: 0, sex_count: 0 },
      active_orders: [],
      top_produced_today: [],
      daily_io: [],
      sex_load: [],
    }));
    render(
      <ChainDetailSheet
        type="production"
        range={{ range: 'today' }}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(/Ishlab chiqarish — batafsil/i),
    ).toBeInTheDocument();
  });

  it('calls onClose when ESC is pressed', async () => {
    stubFetch(() => EMPTY_RAW);
    const onClose = vi.fn();
    render(
      <ChainDetailSheet
        type="raw_warehouse"
        range={{ range: 'today' }}
        onClose={onClose}
      />,
    );
    await screen.findByText(/Xom-ashyo ombori — batafsil/i);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the close button is activated', async () => {
    stubFetch(() => EMPTY_RAW);
    const onClose = vi.fn();
    render(
      <ChainDetailSheet
        type="raw_warehouse"
        range={{ range: 'today' }}
        onClose={onClose}
      />,
    );
    const closeBtn = await screen.findByRole('button', { name: 'Yopish' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
