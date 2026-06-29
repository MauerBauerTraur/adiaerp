/**
 * F4.14 — RevenueBreakdown widget tests.
 *
 * The widget calls `GET /api/dashboard/revenue-breakdown?date=…` and
 * renders chips per payment method. When the endpoint 404s, it must
 * gracefully fall back to the `fallbackTotal` and surface an inline
 * "tayyor emas" hint rather than an error state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { RevenueBreakdown } from './RevenueBreakdown';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RevenueBreakdown', () => {
  it('renders the total and one chip per payment method', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        return Promise.resolve(
          jsonResponse(200, {
            total: 5_400_000,
            byMethod: {
              cash: 2_000_000,
              card: 1_500_000,
              payme: 1_200_000,
              click: 700_000,
            },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    renderWithProviders(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={0} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByTestId('revenue-chip-cash')).toBeInTheDocument();
    });
    expect(screen.getByTestId('revenue-chip-card')).toBeInTheDocument();
    expect(screen.getByTestId('revenue-chip-payme')).toBeInTheDocument();
    expect(screen.getByTestId('revenue-chip-click')).toBeInTheDocument();
    // Total uses local grouping — match by substring to avoid the
    // non-breaking-space character used by Intl.
    const total = screen.getByTestId('revenue-breakdown-total');
    expect(total.textContent ?? '').toMatch(/5/);
  });

  it('renders an extra "Boshqa" chip when byMethod.other > 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          total: 1_100_000,
          byMethod: {
            cash: 500_000,
            card: 300_000,
            payme: 100_000,
            click: 100_000,
            other: 100_000,
          },
        }),
      ),
    );
    renderWithProviders(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={0} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByTestId('revenue-chip-other')).toBeInTheDocument();
    });
  });

  it('resolves to a zero-state (not a perpetual spinner) on an empty/zero response', async () => {
    // Defect: "BUGUNGI TUSHUM" stuck on "...yuklanmoqda…" forever when the
    // day had no/zero revenue. A successful response — even one without a
    // `byMethod` block — must clear the loading note and render real chips.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        // Zero-revenue day: server returns a total but no per-method block.
        return Promise.resolve(jsonResponse(200, { total: 0 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    renderWithProviders(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={0} />,
      { role: 'pm' },
    );
    // The cash chip (zeroed) appears — proving we left the loading branch.
    await waitFor(() => {
      expect(screen.getByTestId('revenue-chip-cash')).toBeInTheDocument();
    });
    // The infinite-spinner note must be gone.
    expect(screen.queryByText(/yuklanmoqda/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('revenue-chip-card')).toBeInTheDocument();
  });

  it('renders "Bugungi tushum" by default and follows the selected period (EPIC 0.4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/dashboard/revenue-breakdown')) {
        return Promise.resolve(jsonResponse(200, { total: 0 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const { rerender } = renderWithProviders(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={0} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByText('Bugungi tushum')).toBeInTheDocument();
    });

    rerender(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={0} range="month" />,
    );
    expect(screen.getByText('Bu oylik tushum')).toBeInTheDocument();
    // The region's aria-label tracks the title too, for screen readers.
    expect(
      screen.getByRole('region', { name: /Bu oylik tushum brekdown/i }),
    ).toBeInTheDocument();
  });

  it('falls back to fallbackTotal + hint when the endpoint 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'no endpoint' },
        }),
      ),
    );
    renderWithProviders(
      <RevenueBreakdown isoDate="2026-05-28" fallbackTotal={3_300_000} />,
      { role: 'pm' },
    );
    await waitFor(() => {
      expect(screen.getByText(/tayyor emas/i)).toBeInTheDocument();
    });
    // Total still shown from fallback so the headline number doesn't
    // vanish when the breakdown is unavailable.
    const total = screen.getByTestId('revenue-breakdown-total');
    expect(total.textContent ?? '').toMatch(/3/);
  });
});
