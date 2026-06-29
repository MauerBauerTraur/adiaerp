import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CentralDetailPanelView } from './CentralDetailPanel';
import type { DashboardCentralDetail } from '@/lib/types';

const MOCK: DashboardCentralDetail = {
  kpis: {
    block_count: 26,
    total_sku: 540,
    below_min_count: 2,
    last_sync_at: '2026-05-25T08:00:00.000Z',
    last_sync_status: 'ok',
    sync_errors_24h: 1,
  },
  blocks: [
    {
      location_id: 1,
      location_name: 'Blok A',
      product_count: 40,
      below_min_count: 0,
      total_qty: 1200,
    },
    {
      location_id: 2,
      location_name: 'Blok B',
      product_count: 25,
      below_min_count: 1,
      total_qty: 800,
    },
  ],
  recent_sync_log: [
    {
      id: 1,
      entity: 'sales',
      status: 'ok',
      started_at: '2026-05-25T08:00:00.000Z',
      finished_at: '2026-05-25T08:00:25.000Z',
      records_in: 421,
      records_applied: 421,
      error_detail: null,
    },
    {
      id: 2,
      entity: 'stock',
      status: 'failed',
      started_at: '2026-05-25T07:00:00.000Z',
      finished_at: null,
      records_in: 0,
      records_applied: 0,
      error_detail: 'timeout',
    },
  ],
  daily_sync_runs: [
    { date: '2026-05-24', ok: 24, partial: 0, failed: 0 },
    { date: '2026-05-25', ok: 23, partial: 0, failed: 1 },
  ],
};

describe('CentralDetailPanel', () => {
  it('renders sub-KPI tiles and the block bar list', () => {
    render(<CentralDetailPanelView data={MOCK} />);
    expect(screen.getByText('Bloklar')).toBeInTheDocument();
    expect(screen.getByText('26')).toBeInTheDocument();
    expect(screen.getByTestId('block-bar-list')).toBeInTheDocument();
    expect(screen.getByText('Blok A')).toBeInTheDocument();
  });

  it('renders the sync log rows', () => {
    render(<CentralDetailPanelView data={MOCK} />);
    expect(screen.getByText('sales')).toBeInTheDocument();
    expect(screen.getByText('stock')).toBeInTheDocument();
  });
});
