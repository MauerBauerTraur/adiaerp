/**
 * F4.4 — PosterStatusCard widget unit tests.
 *
 * Pins the rendering of the Poster sync envelope to the visible card:
 * status badge variant, relative-time formatting, error-count colouring
 * and the empty/`null` branch.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { PosterStatusCard } from './PosterStatusCard';
import type { DashboardPosterStatus } from '@/lib/types';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('PosterStatusCard', () => {
  it('renders the "no data" empty branch when status is null', () => {
    renderWithProviders(<PosterStatusCard status={null} />);
    expect(
      screen.getByText('Hozircha sinxronizatsiya ma’lumoti yo‘q.'),
    ).toBeInTheDocument();
  });

  it('formats last sync as a relative Uzbek string', () => {
    const status: DashboardPosterStatus = {
      last_sync_at: isoMinutesAgo(5),
      last_sync_status: 'ok',
      sync_errors_24h: 0,
      sales_today_count: 42,
      sales_today_sum: 1_250_000,
    };
    renderWithProviders(<PosterStatusCard status={status} />);
    expect(screen.getByTestId('poster-last-sync').textContent).toMatch(
      /daqiqa oldin/,
    );
    expect(screen.getByText('Muvaffaqiyatli')).toBeInTheDocument();
  });

  it('shows error count badge in destructive tone when errors exist', () => {
    const status: DashboardPosterStatus = {
      last_sync_at: isoMinutesAgo(120),
      last_sync_status: 'failed',
      sync_errors_24h: 7,
      sales_today_count: 0,
      sales_today_sum: 0,
    };
    renderWithProviders(<PosterStatusCard status={status} />);
    const errorEl = screen.getByTestId('poster-error-count');
    expect(errorEl.textContent).toMatch(/7/);
    expect(errorEl.className).toMatch(/text-destructive/);
    expect(screen.getByText(/Xatoliklarni ko‘rib chiqing/)).toBeInTheDocument();
    expect(screen.getByText('Xatolik')).toBeInTheDocument();
  });

  it('does not surface the error hint when sync_errors_24h is 0', () => {
    const status: DashboardPosterStatus = {
      last_sync_at: isoMinutesAgo(1),
      last_sync_status: 'partial',
      sync_errors_24h: 0,
      sales_today_count: 1,
      sales_today_sum: 99,
    };
    renderWithProviders(<PosterStatusCard status={status} />);
    expect(
      screen.queryByText(/Xatoliklarni ko‘rib chiqing/),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Qisman')).toBeInTheDocument();
  });
});
