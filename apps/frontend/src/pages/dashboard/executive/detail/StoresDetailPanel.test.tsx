import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoresDetailPanelView } from './StoresDetailPanel';
import type { DashboardStoresDetail } from '@/lib/types';

const MOCK: DashboardStoresDetail = {
  kpis: {
    store_count: 6,
    sales_today_sum: 2_400_000,
    sales_today_count: 124,
    avg_receipt_today: 19_354,
  },
  store_breakdown: [
    {
      location_id: 1,
      location_name: "Do'kon 1",
      sales_sum: 800_000,
      sales_count: 40,
      below_min_count: 1,
      open_replenishments: 0,
    },
    {
      location_id: 2,
      location_name: "Do'kon 2",
      sales_sum: 600_000,
      sales_count: 30,
      below_min_count: 0,
      open_replenishments: 2,
    },
  ],
  top_products_today: [
    {
      product_id: 5,
      product_name: 'Tort A',
      unit: 'pcs',
      qty: 28,
      revenue: 840_000,
    },
  ],
  hourly_heatmap: [],
  daily_sales: [
    { date: '2026-05-24', qty: 100, revenue: 2_100_000 },
    { date: '2026-05-25', qty: 124, revenue: 2_400_000 },
  ],
};

describe('StoresDetailPanel', () => {
  it('renders sub-KPI tiles', () => {
    render(<StoresDetailPanelView data={MOCK} />);
    expect(screen.getByText('Bugungi savdo')).toBeInTheDocument();
    expect(screen.getByText('Cheklar')).toBeInTheDocument();
    expect(screen.getByText('124')).toBeInTheDocument();
  });

  it('shows the per-store grid and top products list', () => {
    render(<StoresDetailPanelView data={MOCK} />);
    expect(screen.getByText("Do'kon 1")).toBeInTheDocument();
    expect(screen.getByText("Do'kon 2")).toBeInTheDocument();
    expect(screen.getByText('Tort A')).toBeInTheDocument();
  });
});
