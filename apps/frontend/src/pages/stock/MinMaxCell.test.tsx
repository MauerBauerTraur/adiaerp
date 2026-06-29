/**
 * Faza-2 F2.1 — MinMaxCell mode toggle + dynamic lock tests.
 *
 * Pins the badge text/aria for both modes, asserts dynamic mode locks
 * the numeric editor, and verifies the toggle confirmation dialog
 * issues a `PATCH /api/stock/minmax-mode` with the inverse mode.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { MinMaxCell } from './MinMaxCell';
import type { StockRow } from '@/lib/types';

const MANUAL_ROW: StockRow = {
  location_id: 7,
  product_id: 11,
  qty: 8,
  min_level: 10,
  max_level: 30,
  minmax_mode: 'manual',
  updated_at: '2026-05-22T10:00:00.000Z',
  product_name: 'Un',
  product_unit: 'kg',
};

const DYNAMIC_ROW: StockRow = {
  ...MANUAL_ROW,
  minmax_mode: 'dynamic',
};

function mockPatch(): { lastUrl: () => string; lastBody: () => unknown } {
  let url = '';
  let body: unknown = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    url = typeof input === 'string' ? input : (input as Request).url;
    body = init?.body ? JSON.parse(init.body as string) : null;
    return Promise.resolve(jsonResponse(200, { ok: true }));
  });
  return { lastUrl: () => url, lastBody: () => body };
}

describe('MinMaxCell — mode badge + toggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a Manual badge for manual rows', () => {
    renderWithProviders(
      <MinMaxCell row={MANUAL_ROW} canEdit={true} onSaved={() => {}} />,
    );
    expect(screen.getByText('Manual')).toBeInTheDocument();
    // The numeric editor pencil is available in manual mode.
    expect(
      screen.getByRole('button', { name: 'Min/max ni tahrirlash' }),
    ).toBeInTheDocument();
  });

  it('renders a Dynamic badge and locks the numeric editor for dynamic rows', () => {
    renderWithProviders(
      <MinMaxCell row={DYNAMIC_ROW} canEdit={true} onSaved={() => {}} />,
    );
    expect(screen.getByText('Dynamic')).toBeInTheDocument();
    // The pencil is hidden — the lock helper text exposes the way out.
    expect(
      screen.queryByRole('button', { name: 'Min/max ni tahrirlash' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Manual ga o‘ting' }),
    ).toBeInTheDocument();
  });

  it('confirming the toggle dialog issues PATCH /api/stock/minmax-mode with the inverse mode', async () => {
    const user = userEvent.setup();
    const sniff = mockPatch();
    const onSaved = vi.fn();
    renderWithProviders(
      <MinMaxCell row={MANUAL_ROW} canEdit={true} onSaved={onSaved} />,
    );

    await user.click(
      screen.getByRole('button', {
        name: 'Rejimni dynamic ga almashtirish',
      }),
    );
    // Confirmation dialog appears.
    expect(
      await screen.findByText('Dynamic rejimga o‘tkazasizmi?'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Dynamic ga o‘tkazish' }),
    );

    await waitFor(() => {
      expect(sniff.lastUrl()).toContain('/api/stock/minmax-mode');
    });
    expect(sniff.lastBody()).toEqual({
      location_id: 7,
      product_id: 11,
      mode: 'dynamic',
    });
    expect(onSaved).toHaveBeenCalled();
  });
});
