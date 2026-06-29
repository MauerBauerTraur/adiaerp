import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SupplyDetailPanelView } from './SupplyDetailPanel';
import type { DashboardSupplyDetail } from '@/lib/types';

const MOCK: DashboardSupplyDetail = {
  kpis: {
    current_stock_count: 80,
    open_requests: 4,
    shipped_today: 35,
    received_today: 22,
  },
  daily_flow: [
    { date: '2026-05-24', received: 10, shipped: 20 },
    { date: '2026-05-25', received: 22, shipped: 35 },
  ],
  top_destinations_today: [
    { location_id: 1, location_name: "Do'kon Markaz", qty: 120 },
  ],
  open_request_items: [
    {
      id: 101,
      product_id: 9,
      product_name: 'Sut',
      qty_needed: 30,
      target_location_id: 1,
      target_location_name: "Do'kon Markaz",
      status: 'NEW',
      created_at: '2026-05-25T09:00:00.000Z',
    },
  ],
};

describe('SupplyDetailPanel', () => {
  it('renders sub-KPI tiles and top destination row', () => {
    render(<SupplyDetailPanelView data={MOCK} />);
    expect(screen.getByText('Joriy SKU')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getAllByText("Do'kon Markaz").length).toBeGreaterThan(0);
  });

  it('shows the open request row', () => {
    render(<SupplyDetailPanelView data={MOCK} />);
    expect(screen.getByText('Sut')).toBeInTheDocument();
    expect(screen.getByText("→ Do'kon Markaz")).toBeInTheDocument();
  });
});
