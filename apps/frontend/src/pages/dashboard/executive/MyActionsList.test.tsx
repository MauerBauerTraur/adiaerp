import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { MyActionsList } from './MyActionsList';
import type {
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';

const PO: PurchaseOrder = {
  id: 1,
  product_id: 5,
  product_name: 'Un',
  qty: 100,
  supplier_id: null,
  target_location_id: 7,
  target_location_name: 'Markaziy sklad',
  status: 'draft',
  replenishment_id: null,
  manager_approved_by: null,
  manager_approved_at: null,
  manager_approved_name: null,
  keeper_approved_by: null,
  keeper_approved_at: null,
  keeper_approved_name: null,
  supplier_name: null,
  received_movement_id: null,
  note: null,
  created_by: null,
  created_at: '2026-05-24T08:00:00.000Z',
  updated_at: '2026-05-24T08:00:00.000Z',
};

const REP: ReplenishmentRequest = {
  id: 2,
  product_id: 6,
  product_name: 'Shakar',
  product_unit: 'kg',
  requester_location_id: 9,
  requester_location_name: 'Do‘kon #1',
  target_location_id: null,
  target_location_name: null,
  qty_needed: 50,
  status: 'NEW',
  production_order_id: null,
  purchase_order_id: null,
  shipment_movement_id: null,
  note: null,
  created_by: null,
  created_at: '2026-05-24T08:30:00.000Z',
  updated_at: '2026-05-24T08:30:00.000Z',
  closed_at: null,
  production_location_name: null,
};

describe('MyActionsList', () => {
  it('renders the empty-neutral state with zero actions', () => {
    renderWithProviders(
      <MyActionsList purchaseOrders={[]} replenishments={[]} />,
    );
    expect(
      screen.getByText('Hozirda harakat talab qilinmaydi.'),
    ).toBeInTheDocument();
  });

  it('renders a purchase order draft row', () => {
    renderWithProviders(
      <MyActionsList purchaseOrders={[PO]} replenishments={[]} />,
    );
    expect(screen.getByText('Sotib olish: Un')).toBeInTheDocument();
  });

  it('renders a NEW replenishment row', () => {
    renderWithProviders(
      <MyActionsList purchaseOrders={[]} replenishments={[REP]} />,
    );
    expect(screen.getByText('Yangi so‘rov: Shakar')).toBeInTheDocument();
  });
});
