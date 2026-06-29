import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductionDetailPanelView } from './ProductionDetailPanel';
import type { DashboardProductionDetail } from '@/lib/types';

const MOCK: DashboardProductionDetail = {
  kpis: {
    active_orders: 12,
    done_today: 5,
    overdue: 1,
    sex_count: 4,
  },
  active_orders: [
    {
      id: 1,
      product_id: 5,
      product_name: 'Tort A',
      qty: 50,
      location_id: 11,
      location_name: 'Sex 1',
      deadline: '2026-05-26T10:00:00.000Z',
      status: 'in_progress',
      is_overdue: false,
    },
  ],
  top_produced_today: [
    { product_id: 5, product_name: 'Tort A', qty: 25 },
  ],
  daily_io: [
    { date: '2026-05-19', input: 100, output: 90 },
    { date: '2026-05-20', input: 110, output: 100 },
  ],
  sex_load: [
    {
      location_id: 11,
      location_name: 'Sex 1',
      open_orders: 4,
      planned_qty: 8,
    },
    {
      location_id: 12,
      location_name: 'Sex 2',
      open_orders: 1,
      planned_qty: 4,
    },
  ],
};

describe('ProductionDetailPanel', () => {
  it('renders sub-KPI tiles', () => {
    render(<ProductionDetailPanelView data={MOCK} />);
    expect(screen.getAllByText('Faol zayafkalar').length).toBeGreaterThan(0);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Bugun bajarildi')).toBeInTheDocument();
  });

  it('shows the active order row and the sex tracker', () => {
    render(<ProductionDetailPanelView data={MOCK} />);
    expect(screen.getByText('Tort A')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-bar')).toBeInTheDocument();
    expect(screen.getAllByText('Sex 1').length).toBeGreaterThan(0);
    expect(screen.getByText('Sex 2')).toBeInTheDocument();
  });
});
