/**
 * Dashboard v3 — Variant B "Calm Canvas" — HeroStrip contract test.
 *
 * The hero strip exposes four KPI cards in a fixed order:
 *   1. Bugungi tushum     — Poster `sales_today_sum`, compact currency
 *   2. Sotuvlar soni      — Poster `sales_today_count`
 *   3. Faol so'rovlar     — active production + open requests + pending approvals
 *   4. Kritik pozitsiya   — `kpis.below_min_count` (danger tone)
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeroStrip } from './HeroStrip';
import type { DashboardEcosystem, DashboardOverview } from '@/lib/types';

const OVERVIEW: DashboardOverview = {
  below_min: [],
  open_requests: { by_status: {}, total: 3, oldest_created_at: null },
  production_plan: [],
  recent_movements: [],
  kpis: {
    total_open_requests: 3,
    below_min_count: 2,
    active_production_orders: 5,
    pending_approvals: 4,
  },
};

const ECOSYSTEM: DashboardEcosystem = {
  poster_status: {
    last_sync_at: '2026-05-25T08:00:00.000Z',
    last_sync_status: 'ok',
    sync_errors_24h: 0,
    sales_today_count: 87,
    sales_today_sum: 2_400_000,
  },
  chain_flow: [],
  chain_summary: [],
  alerts_feed: [],
  sales_chart: { days: [] },
};

describe('HeroStrip', () => {
  it('renders four KPI cards in fixed order', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);

    expect(screen.getByTestId('hero-strip-revenue')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-receipts')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-requests')).toBeInTheDocument();
    expect(screen.getByTestId('hero-strip-critical')).toBeInTheDocument();
  });

  it("renders today's revenue as a full grouped number (not compact)", () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    const value = screen.getByTestId('hero-strip-revenue-value');
    // uz-UZ groups with non-breaking space; collapse whitespace so the
    // assertion stays robust to the locale's exact grouping glyph.
    expect(value.textContent?.replace(/\s+/g, '')).toBe('2400000');
  });

  it('shows the receipt count as a plain integer', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    expect(screen.getByTestId('hero-strip-receipts-value').textContent).toBe(
      '87',
    );
  });

  it('sums active production orders, open requests and pending approvals', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    // 5 + 3 + 4 = 12
    expect(screen.getByTestId('hero-strip-requests-value').textContent).toBe(
      '12',
    );
  });

  it("uses the danger tone when below_min_count > 0", () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    const card = screen.getByTestId('hero-strip-critical');
    expect(card.getAttribute('data-tone')).toBe('danger');
    expect(screen.getByTestId('hero-strip-critical-value').textContent).toBe(
      '2',
    );
  });

  it('uses the warning tone when there are active requests', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    expect(screen.getByTestId('hero-strip-requests').getAttribute('data-tone')).toBe(
      'warning',
    );
  });

  it('falls back to zeros when the ecosystem snapshot is null', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={null} />);
    expect(screen.getByTestId('hero-strip-revenue-value').textContent).toBe(
      '0',
    );
    expect(screen.getByTestId('hero-strip-receipts-value').textContent).toBe(
      '0',
    );
  });

  it('renders the "Bugun" copy by default and when range=today', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    expect(screen.getByText('Bugungi tushum')).toBeInTheDocument();
    expect(screen.getByText('Bugungi sotuvlar')).toBeInTheDocument();
  });

  it('switches revenue/receipts titles when range=week', () => {
    render(
      <HeroStrip
        overview={OVERVIEW}
        ecosystem={ECOSYSTEM}
        range={{ range: 'week' }}
      />,
    );
    expect(screen.getByText('Bu haftalik tushum')).toBeInTheDocument();
    expect(screen.getByText('Bu haftalik sotuvlar')).toBeInTheDocument();
  });

  it('switches revenue/receipts titles when range=month', () => {
    render(
      <HeroStrip
        overview={OVERVIEW}
        ecosystem={ECOSYSTEM}
        range={{ range: 'month' }}
      />,
    );
    expect(screen.getByText('Bu oylik tushum')).toBeInTheDocument();
    expect(screen.getByText('Bu oylik sotuvlar')).toBeInTheDocument();
  });

  it('uses the generic "Davr" copy when range=custom', () => {
    render(
      <HeroStrip
        overview={OVERVIEW}
        ecosystem={ECOSYSTEM}
        range={{ range: 'custom', from: '2026-05-01', to: '2026-05-10' }}
      />,
    );
    expect(screen.getByText('Davr tushumi')).toBeInTheDocument();
    expect(screen.getByText('Davr sotuvlari')).toBeInTheDocument();
  });

  it('renders KPI cards as static regions when onNavigate is absent', () => {
    render(<HeroStrip overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    const card = screen.getByTestId('hero-strip-revenue');
    // No router/handler → plain region, never an interactive button.
    expect(card.tagName).toBe('DIV');
    expect(card.getAttribute('role')).toBe('region');
  });

  it('renders KPI cards as buttons and navigates on click (EPIC 7.1)', () => {
    const onNavigate = vi.fn();
    render(
      <HeroStrip
        overview={OVERVIEW}
        ecosystem={ECOSYSTEM}
        onNavigate={onNavigate}
      />,
    );

    const revenue = screen.getByTestId('hero-strip-revenue');
    expect(revenue.tagName).toBe('BUTTON');
    fireEvent.click(revenue);
    expect(onNavigate).toHaveBeenCalledWith('/dashboard/operations');

    fireEvent.click(screen.getByTestId('hero-strip-requests'));
    expect(onNavigate).toHaveBeenCalledWith('/sorovnomalar');

    fireEvent.click(screen.getByTestId('hero-strip-critical'));
    expect(onNavigate).toHaveBeenCalledWith('/stock');
  });

  it('uses the default tone when no critical positions exist', () => {
    const safe: DashboardOverview = {
      ...OVERVIEW,
      kpis: {
        total_open_requests: 0,
        below_min_count: 0,
        active_production_orders: 0,
        pending_approvals: 0,
      },
    };
    render(<HeroStrip overview={safe} ecosystem={ECOSYSTEM} />);
    expect(
      screen.getByTestId('hero-strip-critical').getAttribute('data-tone'),
    ).toBe('default');
    expect(
      screen.getByTestId('hero-strip-requests').getAttribute('data-tone'),
    ).toBe('default');
  });
});
