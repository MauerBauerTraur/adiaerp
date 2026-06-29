/**
 * F4.4 — SalesChart widget tests.
 *
 * Verifies the 30-day sales chart renders the chart container when data
 * is present, falls back to an empty state when the points array is
 * empty, and computes the header total via the supplied series.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { SalesChart } from './SalesChart';
import type { DashboardSalesPoint } from '@/lib/types';

function buildPoints(qtys: number[]): DashboardSalesPoint[] {
  const base = new Date(2026, 4, 1);
  return qtys.map((qty, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    return { date: iso, qty };
  });
}

describe('SalesChart', () => {
  it('renders the empty branch when no points are provided', () => {
    renderWithProviders(<SalesChart points={[]} />);
    expect(screen.getByText('Sotuv ma’lumotlari yo‘q.')).toBeInTheDocument();
    expect(screen.queryByTestId('sales-chart')).not.toBeInTheDocument();
  });

  it('renders the chart container when points are present', () => {
    const points = buildPoints([10, 20, 30, 40]);
    renderWithProviders(<SalesChart points={points} />);
    expect(screen.getByTestId('sales-chart')).toBeInTheDocument();
  });

  it('shows the aggregate total in the header', () => {
    const points = buildPoints([5, 10, 15]); // total = 30
    renderWithProviders(<SalesChart points={points} />);
    // The "Jami" label sits above the total in the header.
    expect(screen.getByText('Jami')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });
});
