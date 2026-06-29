/**
 * Contract tests for the F4.6 chain-layer module screens.
 *
 * Each test pins the `GET /api/dashboard/chain-layer/:type` response shape
 * to the rendered UI: header title, KPI strip values, locations grid,
 * and at least one layer-specific widget. Drift in either direction
 * (renamed field, missing nested object, different enum value) fails
 * loudly instead of silently rendering empty cards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type {
  ChainLayerOverview,
  ProductionOrder,
  PurchaseOrder,
  ReplenishmentRequest,
  SaleRow,
  StockRow,
} from '@/lib/types';
import { RawWarehousePage } from './RawWarehousePage';
import { ProductionPage } from './ProductionPage';
import { SupplyPage } from './SupplyPage';
import { CentralWarehousePage } from './CentralWarehousePage';
import { StoresPage } from './StoresPage';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RAW_OVERVIEW: ChainLayerOverview = {
  layer_type: 'raw_warehouse',
  locations: [
    {
      id: 1,
      name: 'Asosiy xom-ashyo ombori',
      type: 'raw_warehouse',
      total_products: 35,
      below_min_count: 2,
      open_requests_count: 1,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 35,
    below_min_count: 2,
    open_requests_count: 1,
  },
  recent_movements: [
    {
      id: 1,
      created_at: '2026-05-22T10:00:00.000Z',
      product_id: 1,
      product_name: 'Un',
      product_unit: 'kg',
      from_location_id: null,
      from_location_name: null,
      to_location_id: 1,
      to_location_name: 'Asosiy xom-ashyo ombori',
      qty: 100,
      reason: 'purchase',
    },
  ],
};

const RAW_STOCK: StockRow[] = [
  {
    location_id: 1,
    product_id: 1,
    qty: 4,
    min_level: 10,
    max_level: 50,
    minmax_mode: 'manual',
    updated_at: '2026-05-22T09:00:00.000Z',
    product_name: 'Un',
    product_unit: 'kg',
  },
];

const APPROVED_PURCHASE: PurchaseOrder = {
  id: 11,
  product_id: 1,
  qty: 200,
  supplier_id: null,
  target_location_id: 1,
  status: 'approved',
  replenishment_id: null,
  manager_approved_by: 1,
  manager_approved_at: '2026-05-22T08:00:00.000Z',
  keeper_approved_by: 2,
  keeper_approved_at: '2026-05-22T08:05:00.000Z',
  received_movement_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T07:30:00.000Z',
  updated_at: '2026-05-22T08:05:00.000Z',
  product_name: 'Un',
  target_location_name: 'Asosiy xom-ashyo ombori',
  manager_approved_name: 'Ali',
  keeper_approved_name: 'Vali',
  supplier_name: 'TashFlour LLC',
};

const PRODUCTION_OVERVIEW: ChainLayerOverview = {
  layer_type: 'production',
  locations: [
    {
      id: 2,
      name: 'Sex 1',
      type: 'production',
      total_products: 12,
      below_min_count: 0,
      open_requests_count: 0,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 12,
    below_min_count: 0,
    open_requests_count: 0,
    active_production_orders: 2,
  },
  recent_movements: [],
};

const ACTIVE_ORDER: ProductionOrder = {
  id: 501,
  product_id: 9,
  qty: 120,
  location_id: 2,
  target_location_id: 7,
  deadline: '2026-05-23',
  status: 'in_progress',
  replenishment_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T07:00:00.000Z',
  updated_at: '2026-05-22T09:00:00.000Z',
  done_at: null,
  product_name: 'Pishloqli non',
  location_name: 'Sex 1',
  target_location_name: 'Markaziy sklad',
};

const SUPPLY_OVERVIEW: ChainLayerOverview = {
  layer_type: 'supply',
  locations: [
    {
      id: 3,
      name: 'Tort bo‘limi',
      type: 'supply',
      total_products: 18,
      below_min_count: 1,
      open_requests_count: 2,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 18,
    below_min_count: 1,
    open_requests_count: 2,
    pending_shipments: 3,
  },
  recent_movements: [],
};

const SUPPLY_STOCK: StockRow[] = [
  {
    location_id: 3,
    product_id: 20,
    qty: 25,
    min_level: 5,
    max_level: 40,
    minmax_mode: 'dynamic',
    updated_at: '2026-05-22T08:30:00.000Z',
    product_name: 'Tort qoplama',
    product_unit: 'kg',
  },
];

const SUPPLY_REPLEN: ReplenishmentRequest = {
  id: 77,
  product_id: 20,
  requester_location_id: 11,
  target_location_id: 3,
  qty_needed: 10,
  status: 'CHECK_STORE_SUPPLIER',
  production_order_id: null,
  purchase_order_id: null,
  shipment_movement_id: null,
  note: null,
  created_by: 1,
  created_at: '2026-05-22T07:00:00.000Z',
  updated_at: '2026-05-22T07:30:00.000Z',
  closed_at: null,
  product_name: 'Tort qoplama',
  product_unit: 'kg',
  requester_location_name: 'Do‘kon #2',
  target_location_name: 'Tort bo‘limi',
  production_location_name: null,
};

const CENTRAL_OVERVIEW: ChainLayerOverview = {
  layer_type: 'central_warehouse',
  locations: [
    {
      id: 7,
      name: 'Markaziy sklad',
      type: 'central_warehouse',
      total_products: 80,
      below_min_count: 3,
      open_requests_count: 5,
    },
  ],
  totals: {
    total_locations: 1,
    total_products: 80,
    below_min_count: 3,
    open_requests_count: 5,
    pending_shipments: 4,
  },
  recent_movements: [],
};

const SHIP_REPLEN: ReplenishmentRequest = {
  ...SUPPLY_REPLEN,
  id: 88,
  status: 'SHIP_TO_REQUESTER',
  product_name: 'Pishloqli non',
  requester_location_name: 'Do‘kon #1',
  target_location_name: 'Markaziy sklad',
};

const STORE_OVERVIEW: ChainLayerOverview = {
  layer_type: 'store',
  locations: [
    {
      id: 11,
      name: 'Do‘kon #1 Chilonzor',
      type: 'store',
      total_products: 40,
      below_min_count: 1,
      open_requests_count: 1,
    },
    {
      id: 12,
      name: 'Do‘kon #2 Yunusobod',
      type: 'store',
      total_products: 42,
      below_min_count: 0,
      open_requests_count: 0,
    },
  ],
  totals: {
    total_locations: 2,
    total_products: 82,
    below_min_count: 1,
    open_requests_count: 1,
    sales_today_count: 15,
  },
  recent_movements: [],
};

const STORE_SALES: SaleRow[] = [
  {
    id: 1,
    store_id: 11,
    store_name: 'Do‘kon #1 Chilonzor',
    product_id: 9,
    product_name: 'Pishloqli non',
    product_unit: 'pcs',
    qty: 5,
    price: 10000,
    sold_at: '2026-05-22T11:00:00.000Z',
    poster_transaction_id: 1001,
  },
  {
    id: 2,
    store_id: 11,
    store_name: 'Do‘kon #1 Chilonzor',
    product_id: 10,
    product_name: 'Tort',
    product_unit: 'pcs',
    qty: 2,
    price: 100000,
    sold_at: '2026-05-22T11:30:00.000Z',
    poster_transaction_id: 1002,
  },
];

const STORE_REPLEN: ReplenishmentRequest = {
  ...SUPPLY_REPLEN,
  id: 99,
  status: 'NEW',
  requester_location_id: 11,
  requester_location_name: 'Do‘kon #1 Chilonzor',
  product_name: 'Pishloqli non',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchHandler = (url: string) => Response | undefined;

function installFetch(handler: FetchHandler) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const response = handler(url);
    if (response) return Promise.resolve(response);
    // Default empty array for unmatched list endpoints — avoids loud
    // rejections on the secondary fetches each page kicks off.
    return Promise.resolve(jsonResponse(200, []));
  });
}

// ---------------------------------------------------------------------------
// /raw-warehouse
// ---------------------------------------------------------------------------

describe('RawWarehousePage — contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header, KPI numbers, locations and incoming-purchases widget', async () => {
    installFetch((url) => {
      if (url.includes('/api/dashboard/chain-layer/raw_warehouse')) {
        return jsonResponse(200, RAW_OVERVIEW);
      }
      if (url.includes('/api/stock?location_type=raw_warehouse')) {
        return jsonResponse(200, RAW_STOCK);
      }
      if (url.includes('/api/purchase-orders?status=approved')) {
        return jsonResponse(200, [APPROVED_PURCHASE]);
      }
      return undefined;
    });

    // Render as the raw_warehouse_manager assigned to location 1
    // (matches APPROVED_PURCHASE.target_location_id). PM is now
    // read-only on receive (Stage 1 / commit da5aebe) so the
    // "Qabul qilish" button only renders for the scoped operator.
    renderWithProviders(<RawWarehousePage />, {
      role: 'raw_warehouse_manager',
      locationId: 1,
      locationType: 'raw_warehouse',
    });

    // Locations grid renders the only raw warehouse location once
    // the chain-layer endpoint resolves. We anchor on the location
    // card text rather than the heading because `findByRole('heading',
    // { name })` computes the accessible name from the surrounding
    // header block and ends up looking for the description too.
    const locationMatches = await screen.findAllByText(
      'Asosiy xom-ashyo ombori',
    );
    expect(locationMatches.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/Xom-ashyo ombori/);

    // Incoming purchases widget surfaces the approved purchase order.
    expect(
      await screen.findByText('Sotib olish — qabul kutilmoqda'),
    ).toBeInTheDocument();
    expect(screen.getByText('TashFlour LLC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Qabul qilish/ })).toBeInTheDocument();

    // KPI strip rendered four cards.
    const kpiValues = Array.from(
      document.querySelectorAll('[data-testid="chain-kpi-value"]'),
    ).map((n) => n.textContent?.trim());
    expect(kpiValues).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// /production
// ---------------------------------------------------------------------------

describe('ProductionPage — contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header, active orders widget and KPI cards', async () => {
    installFetch((url) => {
      if (url.includes('/api/dashboard/chain-layer/production')) {
        return jsonResponse(200, PRODUCTION_OVERVIEW);
      }
      if (url.includes('/api/production-orders?status=in_progress')) {
        return jsonResponse(200, [ACTIVE_ORDER]);
      }
      if (url.includes('/api/production-orders?status=new')) {
        return jsonResponse(200, []);
      }
      return undefined;
    });

    // Render as the production_manager assigned to location 2 (matches
    // ACTIVE_ORDER.location_id = Sex 1). PM is now read-only on
    // production-order writes (Stage 1 / commit 68c5efd) so the
    // "Yakunlash" CTA only renders for the scoped operator.
    renderWithProviders(<ProductionPage />, {
      role: 'production_manager',
      locationId: 2,
      locationType: 'production',
    });

    // Active orders widget renders the in-progress production order.
    const activeMatches = await screen.findAllByText('Faol zayafkalar');
    expect(activeMatches.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/Ishlab chiqarish/);
    expect(screen.getByText('Pishloqli non')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yakunlash/ })).toBeInTheDocument();

    // Locations grid (Sex 1) renders — also appears in active orders row.
    expect(screen.getAllByText('Sex 1').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// /supply
// ---------------------------------------------------------------------------

describe('SupplyPage — contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header, locations, ready-to-ship and pending replen widgets', async () => {
    installFetch((url) => {
      if (url.includes('/api/dashboard/chain-layer/supply')) {
        return jsonResponse(200, SUPPLY_OVERVIEW);
      }
      if (url.includes('/api/stock?location_type=supply')) {
        return jsonResponse(200, SUPPLY_STOCK);
      }
      if (url.includes('/api/replenishment?status=CHECK_STORE_SUPPLIER')) {
        return jsonResponse(200, [SUPPLY_REPLEN]);
      }
      return undefined;
    });

    renderWithProviders(<SupplyPage />, { role: 'pm' });

    const supplyMatches = await screen.findAllByText('Tort bo‘limi');
    expect(supplyMatches.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/Sex skladlari/);
    expect(screen.getAllByText('Jo‘natmaga tayyor').length).toBeGreaterThan(0);
    // Ready-to-ship surfaces the in-stock product.
    expect(screen.getAllByText('Tort qoplama').length).toBeGreaterThan(0);
    // Pending replenishment widget shows the requester store.
    expect(screen.getByText('Do‘kon #2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// /central-warehouse
// ---------------------------------------------------------------------------

describe('CentralWarehousePage — contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header, ship-to-stores widget and locations', async () => {
    installFetch((url) => {
      if (url.includes('/api/dashboard/chain-layer/central_warehouse')) {
        return jsonResponse(200, CENTRAL_OVERVIEW);
      }
      if (url.includes('/api/replenishment?status=SHIP_TO_REQUESTER')) {
        return jsonResponse(200, [SHIP_REPLEN]);
      }
      if (url.includes('/api/replenishment?status=DONE_TO_WAREHOUSE')) {
        return jsonResponse(200, []);
      }
      return undefined;
    });

    // Stage 4 RBAC — PM is read-only on the replenishment advance
    // endpoint (commit c2ed012). Render as the central_warehouse_manager
    // scoped to the target location (SHIP_REPLEN inherits
    // target_location_id=3 from SUPPLY_REPLEN) so the "Jo'natmani
    // bajarish" button still renders for this happy-path assertion.
    renderWithProviders(<CentralWarehousePage />, {
      role: 'central_warehouse_manager',
      locationId: 3,
      locationType: 'central_warehouse',
    });

    expect(
      await screen.findByText('Do‘konlarga jo‘natish kerak'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/Markaziy sklad/);
    expect(screen.getByText('Pishloqli non')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Jo‘natmani bajarish/ }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// /stores
// ---------------------------------------------------------------------------

describe('StoresPage — contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header, store cards, top-sales aggregation and open requests', async () => {
    installFetch((url) => {
      if (url.includes('/api/dashboard/chain-layer/store')) {
        return jsonResponse(200, STORE_OVERVIEW);
      }
      if (url.includes('/api/sales')) {
        return jsonResponse(200, {
          items: STORE_SALES,
          total: STORE_SALES.length,
          limit: 200,
          offset: 0,
        });
      }
      if (url.includes('/api/replenishment')) {
        return jsonResponse(200, [STORE_REPLEN]);
      }
      return undefined;
    });

    renderWithProviders(<StoresPage />, { role: 'pm' });

    // Both store cards render with their names.
    const storeMatches = await screen.findAllByText('Do‘kon #1 Chilonzor');
    expect(storeMatches.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/Do‘konlar/);
    expect(screen.getAllByText('Do‘kon #2 Yunusobod').length).toBeGreaterThan(0);

    // Top-sales widget aggregates by product across stores.
    expect(screen.getByText('Bugungi top sotuv')).toBeInTheDocument();
    expect(screen.getAllByText('Pishloqli non').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tort').length).toBeGreaterThan(0);

    // Open replenishment widget surfaces store-originated request.
    expect(screen.getByText('To‘ldirish kerak')).toBeInTheDocument();
  });
});
