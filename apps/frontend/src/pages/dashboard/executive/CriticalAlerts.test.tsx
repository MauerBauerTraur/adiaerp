import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { CriticalAlerts } from './CriticalAlerts';
import type { DashboardAlert, DashboardBelowMinItem } from '@/lib/types';

const BELOW_MIN: DashboardBelowMinItem[] = [
  {
    location_id: 1,
    location_name: 'Markaziy sklad',
    product_id: 10,
    product_name: 'Shakar',
    product_unit: 'kg',
    qty: 0,
    min_level: 10,
    max_level: 50,
    open_request_id: 42,
    open_request_status: 'NEW',
  },
  {
    location_id: 2,
    location_name: 'Do‘kon #2',
    product_id: 11,
    product_name: 'Un',
    product_unit: 'kg',
    qty: 2,
    min_level: 10,
    max_level: 30,
    open_request_id: null,
    open_request_status: null,
  },
];

describe('CriticalAlerts', () => {
  it('renders the empty success state when no rows', () => {
    renderWithProviders(<CriticalAlerts belowMin={[]} alerts={[]} />);
    expect(screen.getByText('Hammasi me’yorda.')).toBeInTheDocument();
  });

  it('shows zero-stock items first, then deep-below-min items', () => {
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={[]} />,
    );
    const titles = screen
      .getAllByRole('link')
      .map((a) => a.textContent ?? '');
    expect(titles[0]).toMatch(/Shakar/);
    expect(titles[1]).toMatch(/Un/);
  });

  it('shows a counter badge with the total count', () => {
    const alerts: DashboardAlert[] = [
      {
        id: 1,
        type: 'poster_sync_failed',
        severity: 'danger',
        message: 'Poster sync failed',
        location_id: null,
        location_name: null,
        created_at: '2026-05-24T10:00:00.000Z',
      },
    ];
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={alerts} />,
    );
    // 2 below-min + 1 danger alert = 3
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
