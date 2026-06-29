import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawDetailPanelView } from './RawDetailPanel';
import type { DashboardRawDetail } from '@/lib/types';

const MOCK: DashboardRawDetail = {
  kpis: {
    raw_product_types: 42,
    total_stock_by_unit: [
      { unit: 'kg', qty: 1280 },
      { unit: 'l', qty: 320 },
    ],
    below_min_count: 3,
    open_purchase_orders: 2,
  },
  daily_movements: [
    { date: '2026-05-19', received: 100, issued: 80 },
    { date: '2026-05-20', received: 120, issued: 95 },
    { date: '2026-05-21', received: 90, issued: 110 },
    { date: '2026-05-22', received: 140, issued: 100 },
    { date: '2026-05-23', received: 110, issued: 95 },
    { date: '2026-05-24', received: 130, issued: 105 },
    { date: '2026-05-25', received: 150, issued: 120 },
  ],
  below_min_items: [
    {
      product_id: 1,
      product_name: 'Un',
      unit: 'kg',
      qty: 12,
      min_level: 50,
      max_level: 200,
      location_id: 7,
      location_name: 'Asosiy ombor',
    },
  ],
  pending_purchase_orders: [
    {
      id: 9,
      product_id: 1,
      product_name: 'Un',
      qty: 200,
      supplier_id: 1,
      created_at: '2026-05-25T08:00:00.000Z',
    },
  ],
};

describe('RawDetailPanel', () => {
  it('renders sub-KPI tiles and key labels', () => {
    render(<RawDetailPanelView data={MOCK} />);
    expect(screen.getByText('Xom-ashyo turlari')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText("Min'dan past")).toBeInTheDocument();
    expect(screen.getByText('Ochiq PO')).toBeInTheDocument();
  });

  it('shows the below-min product row and pending PO row', () => {
    render(<RawDetailPanelView data={MOCK} />);
    expect(screen.getAllByText('Un').length).toBeGreaterThan(0);
    expect(screen.getByText('Asosiy ombor')).toBeInTheDocument();
  });
});
