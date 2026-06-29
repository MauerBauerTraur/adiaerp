/**
 * Stage 6 — frontend RBAC matrix.
 *
 * The Stage 1/Stage 2 backend tightening (commits a21cc14...25a2527) made
 * PMs and ai_assistants read-and-recommend on every business write
 * endpoint, and scoped operators to their M:N location set
 * (ADR-0012). Stage 3/Stage 4 mirrored those rules in the UI via
 * `useCanAct()`.
 *
 * This matrix is the regression guard for that mirror: it renders the
 * real pages once per (role × screen) cell and asserts every write
 * button is either visible or hidden in exactly the same shape the
 * backend would 200 / 403. If a future page change drops a
 * `canActOn(...)` gate, this suite catches it before the user does.
 *
 * Why a single matrix file: a real-world end-to-end run would mount the
 * whole app and click through the sidebar. We approximate that here by
 * rendering each page in isolation under a per-cell `renderWithProviders`
 * call. The fan-out keeps the cost low (one fetch mock per cell, no
 * full router) while still covering the cross-cutting "PM never sees
 * this" claim across the entire chain.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import { ProductionOrdersPage } from '@/pages/production-orders/ProductionOrdersPage';
import { PurchaseOrdersPage } from '@/pages/purchase-orders/PurchaseOrdersPage';
import { ProductionPage } from '@/pages/chain/ProductionPage';
import { StockPage } from '@/pages/stock/StockPage';
import { DeliveryPage } from '@/pages/delivery/DeliveryPage';
import type {
  ChainLayerOverview,
  DeliveryTask,
  Location,
  ProductionOrder,
  PurchaseOrder,
  StockRow,
  User,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Shared fixtures — single source of truth so the matrix stays readable.
// Every page reuses these via mockFetch; per-cell rendering then varies
// only the auth context (role + locationId).
// ---------------------------------------------------------------------------

const PRODUCT = {
  id: 1,
  name: 'Un',
  type: 'raw' as const,
  unit: 'kg' as const,
  sku: null,
  poster_ingredient_id: null,
  poster_product_id: null,
  is_active: true,
};

const LOC_RAW: Location = {
  id: 10,
  name: 'Xom-ashyo ombori',
  type: 'raw_warehouse',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const LOC_PROD_TORT: Location = {
  id: 21,
  name: 'Tort sexi',
  type: 'production',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const LOC_PROD_PEROJ: Location = {
  id: 22,
  name: 'Perojniy sexi',
  type: 'production',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const LOC_CENTRAL: Location = {
  id: 30,
  name: 'Markaziy sklad',
  type: 'central_warehouse',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const LOC_STORE_1: Location = {
  id: 40,
  name: 'Do‘kon #1',
  type: 'store',
  parent_id: null,
  manager_user_id: null,
  poster_storage_id: null,
  lead_time_days: null,
  review_days: null,
  safety_factor: null,
};

const ALL_LOCS: Location[] = [
  LOC_RAW,
  LOC_PROD_TORT,
  LOC_PROD_PEROJ,
  LOC_CENTRAL,
  LOC_STORE_1,
];

// Production orders — one per sex so we can verify cross-sex isolation
// (Tort manager sees Tort's button but not Perojniy's).
const PO_TORT: ProductionOrder = {
  id: 1001,
  product_id: 1,
  qty: 30,
  status: 'in_progress',
  deadline: null,
  location_id: LOC_PROD_TORT.id,
  target_location_id: null,
  replenishment_id: null,
  note: null,
  product_name: 'Napoleon',
  location_name: LOC_PROD_TORT.name,
  target_location_name: null,
  created_by: 22,
  created_at: '2026-05-22T08:00:00Z',
  updated_at: '2026-05-22T08:00:00Z',
  done_at: null,
};

const PO_PEROJ: ProductionOrder = {
  ...PO_TORT,
  id: 1002,
  location_id: LOC_PROD_PEROJ.id,
  location_name: LOC_PROD_PEROJ.name,
  product_name: 'Pirojnoe',
};

// Purchase order owned by user id=1 (default fakeUser), targeting the
// raw warehouse. The PO matrix verifies the (a) supply_manager-creator
// can sign manager step, (b) raw_warehouse_manager scoped to LOC_RAW
// can sign keeper, and (c) PM sees no buttons.
const PURCHASE: PurchaseOrder = {
  id: 5001,
  product_id: 1,
  qty: 500,
  supplier_id: null,
  target_location_id: LOC_RAW.id,
  status: 'draft',
  replenishment_id: null,
  manager_approved_by: null,
  manager_approved_at: null,
  keeper_approved_by: null,
  keeper_approved_at: null,
  received_movement_id: null,
  note: null,
  created_by: 1, // matches default fakeUser id
  created_at: '2026-05-22T08:00:00Z',
  updated_at: '2026-05-22T08:00:00Z',
  product_name: PRODUCT.name,
  target_location_name: LOC_RAW.name,
  manager_approved_name: null,
  keeper_approved_name: null,
  supplier_name: null,
};

// Stock — one row per location so the StockPage table renders something
// for every role. Field shape mirrors StockRow.
const STOCK_ROWS: StockRow[] = [
  {
    location_id: LOC_CENTRAL.id,
    product_id: 1,
    qty: 250,
    min_level: 100,
    max_level: 500,
    minmax_mode: 'manual',
    updated_at: '2026-05-22T09:00:00Z',
    product_name: PRODUCT.name,
    product_unit: 'kg',
  },
];

// Delivery — one task crossing the central warehouse (target) and a
// store (requester). The matrix verifies both sides separately.
const DELIVERY: DeliveryTask = {
  id: 9001,
  replenishment_id: 9001,
  product_id: 1,
  product_name: PRODUCT.name,
  product_unit: 'kg',
  qty_needed: 20,
  status: 'NEW',
  requester_location_id: LOC_STORE_1.id,
  requester_location_name: LOC_STORE_1.name,
  target_location_id: LOC_CENTRAL.id,
  target_location_name: LOC_CENTRAL.name,
  assigned_user_id: null,
  assigned_user_name: null,
  created_at: '2026-05-24T08:00:00Z',
  updated_at: '2026-05-24T08:00:00Z',
};

// Production chain-layer overview — minimal so the page renders, with
// the two sub-cehs registered.
const PRODUCTION_OVERVIEW: ChainLayerOverview = {
  layer_type: 'production',
  locations: [
    {
      id: LOC_PROD_TORT.id,
      name: LOC_PROD_TORT.name,
      type: 'production',
      total_products: 0,
      below_min_count: 0,
      open_requests_count: 0,
    },
  ],
  totals: {
    total_locations: 2,
    total_products: 0,
    below_min_count: 0,
    open_requests_count: 0,
    active_production_orders: 1,
  },
  recent_movements: [],
};

const USERS: User[] = [
  {
    id: 22,
    name: 'Tort Operator',
    username: 'tort',
    role: 'production_manager',
    location_id: LOC_PROD_TORT.id,
  },
];

// ---------------------------------------------------------------------------
// Fetch mock — handles every endpoint the suite touches. Returns 200 + a
// shape that matches the page's expectations. A test only fails when a
// page renders a button it should not (or hides one it should not),
// never because the network mock missed an endpoint.
// ---------------------------------------------------------------------------

function installFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/products')) return Promise.resolve(jsonResponse(200, [PRODUCT]));
      if (url.includes('/api/locations')) return Promise.resolve(jsonResponse(200, ALL_LOCS));
      if (url.includes('/api/users')) return Promise.resolve(jsonResponse(200, USERS));
      if (url.includes('/api/dashboard/chain-layer/production')) {
        return Promise.resolve(jsonResponse(200, PRODUCTION_OVERVIEW));
      }
      if (url.includes('/api/production-orders?status=in_progress')) {
        return Promise.resolve(jsonResponse(200, [PO_TORT]));
      }
      if (url.includes('/api/production-orders?status=new')) {
        return Promise.resolve(jsonResponse(200, [PO_PEROJ]));
      }
      if (url.includes('/api/production-orders')) {
        return Promise.resolve(jsonResponse(200, [PO_TORT, PO_PEROJ]));
      }
      if (url.includes('/api/purchase-orders')) {
        return Promise.resolve(jsonResponse(200, [PURCHASE]));
      }
      if (url.includes('/api/stock')) {
        return Promise.resolve(jsonResponse(200, STOCK_ROWS));
      }
      if (url.includes('/api/delivery/tasks')) {
        return Promise.resolve(jsonResponse(200, [DELIVERY]));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Row 1: PM — Stage 1 read-and-recommend everywhere
// ---------------------------------------------------------------------------

describe('RBAC matrix — PM (read-and-recommend on every chain layer)', () => {
  it('ProductionOrdersPage: no transition / create buttons', async () => {
    installFetch();
    renderWithProviders(<ProductionOrdersPage />, { role: 'pm' });
    await screen.findByText('Napoleon');
    expect(screen.queryByRole('button', { name: /yangi zayafka/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yakunlash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Boshlash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
  });

  it('PurchaseOrdersPage: no create / approve / receive / reject buttons', async () => {
    installFetch();
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PurchaseOrdersPage />, {
      role: 'pm',
    });
    await screen.findByText('Un');
    expect(screen.queryByRole('button', { name: /yangi sotib olish/i })).toBeNull();
    // Expand the approval panel and assert no actions render inside it.
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    // The expanded panel renders "Hali tasdiqlanmagan" labels — wait
    // for them so we know the inner StepCards have mounted before
    // asserting their action buttons are absent.
    await waitFor(() =>
      expect(
        screen.getAllByText(/hali tasdiqlanmagan/i).length,
      ).toBeGreaterThan(0),
    );
    expect(container.querySelector('button[aria-label*="boshliq"]')).toBeNull();
    expect(container.querySelector('button[aria-label*="skladchi"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /rad etish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /qabul qilish/i })).toBeNull();
  });

  it('ProductionPage: no Yakunlash / Boshlash inline buttons', async () => {
    installFetch();
    renderWithProviders(<ProductionPage />, { role: 'pm' });
    await screen.findByText('Napoleon');
    expect(screen.queryByRole('button', { name: /yakunlash/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /boshlash/i })).toBeNull();
  });

  it('StockPage: no "Harakat qo‘shish" but keeps "Min/max qayta hisob"', async () => {
    // Stock movements are writes → PM 403. The min/max recalc is the
    // explicit configuration exemption (Stage 6 rbac-matrix backend
    // test), so it MUST stay visible for PM.
    installFetch();
    renderWithProviders(<StockPage />, { role: 'pm' });
    await screen.findByText('Un');
    expect(screen.queryByRole('button', { name: /harakat qo.shish/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /min\/max qayta hisob/i }),
    ).toBeInTheDocument();
  });

  it('DeliveryPage: no Biriktirish / Bajarish / Bekor buttons', async () => {
    installFetch();
    renderWithProviders(<DeliveryPage />, { role: 'pm' });
    await screen.findByText('Un');
    expect(screen.queryByRole('button', { name: /biriktirish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bajarish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 2: production_manager — scoped to their own sex (cross-sex isolation)
// ---------------------------------------------------------------------------

describe('RBAC matrix — production_manager (Tort sexi only)', () => {
  it('sees the Yakunlash button for its OWN active order', async () => {
    installFetch();
    renderWithProviders(<ProductionPage />, {
      role: 'production_manager',
      locationId: LOC_PROD_TORT.id,
      locationType: 'production',
    });
    await screen.findByText('Napoleon');
    expect(
      screen.getByRole('button', { name: /yakunlash/i }),
    ).toBeInTheDocument();
  });

  it('does NOT see the Boshlash button for the other sex (Perojniy)', async () => {
    // PO_PEROJ.location_id is 22; the Tort manager (loc 21) must not
    // be able to start it (backend would 403 with FOREIGN_LOCATION).
    installFetch();
    renderWithProviders(<ProductionPage />, {
      role: 'production_manager',
      locationId: LOC_PROD_TORT.id,
      locationType: 'production',
    });
    await screen.findByText('Pirojnoe');
    expect(screen.queryByRole('button', { name: /boshlash/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 3: supply_manager — creator-scoped manager step + global reject
// ---------------------------------------------------------------------------

describe('RBAC matrix — supply_manager', () => {
  it('sees Yangi sotib olish + manager-step approve as the creator', async () => {
    installFetch();
    const user = userEvent.setup();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'supply_manager',
      // userId defaults to 1 → matches PURCHASE.created_by
    });
    await screen.findByText('Un');
    expect(
      screen.getByRole('button', { name: /yangi sotib olish/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    // The manager-step approval renders, the keeper-step does not.
    expect(
      await screen.findByRole('button', { name: /tasdiqlash \(boshliq\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /tasdiqlash \(skladchi\)/i }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /rad etish/i }),
    ).toBeInTheDocument();
  });

  it('hides the manager-step approve when the PO was created by someone else', async () => {
    // userId=2 ≠ PURCHASE.created_by (1).
    installFetch();
    const user = userEvent.setup();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'supply_manager',
      userId: 2,
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    // Wait for the StepCard markers so we know the panel mounted.
    await waitFor(() =>
      expect(
        screen.getAllByText(/hali tasdiqlanmagan/i).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByRole('button', { name: /tasdiqlash \(boshliq\)/i }),
    ).toBeNull();
    // The global reject is still allowed (no per-PO scope on /reject).
    expect(
      screen.getByRole('button', { name: /rad etish/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Row 4: raw_warehouse_manager — keeper step + receive scoped to warehouse
// ---------------------------------------------------------------------------

describe('RBAC matrix — raw_warehouse_manager', () => {
  it('sees the keeper-step approve for a PO targeting its warehouse', async () => {
    installFetch();
    const user = userEvent.setup();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'raw_warehouse_manager',
      locationId: LOC_RAW.id,
      locationType: 'raw_warehouse',
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    expect(
      await screen.findByRole('button', { name: /tasdiqlash \(skladchi\)/i }),
    ).toBeInTheDocument();
    // Manager step belongs to supply, so this role must not see it.
    expect(
      screen.queryByRole('button', { name: /tasdiqlash \(boshliq\)/i }),
    ).toBeNull();
  });

  it('hides the keeper-step approve for a foreign warehouse', async () => {
    installFetch();
    const user = userEvent.setup();
    renderWithProviders(<PurchaseOrdersPage />, {
      role: 'raw_warehouse_manager',
      locationId: 99, // not LOC_RAW.id (10)
      locationType: 'raw_warehouse',
    });
    await screen.findByText('Un');
    await user.click(screen.getByRole('button', { name: 'Ko‘rish' }));
    await waitFor(() =>
      expect(
        screen.getAllByText(/hali tasdiqlanmagan/i).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByRole('button', { name: /tasdiqlash \(skladchi\)/i }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 5: store_manager — requester-side cancel only on the delivery queue
// ---------------------------------------------------------------------------

describe('RBAC matrix — store_manager', () => {
  it('sees Bekor (cancel) on a task whose requester is its own store', async () => {
    installFetch();
    renderWithProviders(<DeliveryPage />, {
      role: 'store_manager',
      locationId: LOC_STORE_1.id,
      locationType: 'store',
    });
    await screen.findByText('Un');
    expect(
      screen.getAllByRole('button', { name: 'Bekor' }).length,
    ).toBeGreaterThan(0);
  });

  it('still cannot see "Harakat qo‘shish" on StockPage (unchanged §6 rule)', async () => {
    installFetch();
    renderWithProviders(<StockPage />, {
      role: 'store_manager',
      locationId: LOC_STORE_1.id,
      locationType: 'store',
    });
    await screen.findByText('Un');
    expect(
      screen.queryByRole('button', { name: /harakat qo.shish/i }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 6: central_warehouse_manager — target-side advance on delivery
// ---------------------------------------------------------------------------

describe('RBAC matrix — central_warehouse_manager', () => {
  it('sees Bajarish on a task whose target is its warehouse but NOT Bekor', async () => {
    // Backend cancel rule: only requester-side may close the request.
    // The central warehouse here is the target → no cancel button.
    installFetch();
    renderWithProviders(<DeliveryPage />, {
      role: 'central_warehouse_manager',
      locationId: LOC_CENTRAL.id,
      locationType: 'central_warehouse',
    });
    await screen.findByText('Un');
    expect(
      screen.getAllByRole('button', { name: 'Bajarish' }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Bekor' })).toBeNull();
  });

  it('sees Harakat qo‘shish (movements) on its own warehouse', async () => {
    installFetch();
    renderWithProviders(<StockPage />, {
      role: 'central_warehouse_manager',
      locationId: LOC_CENTRAL.id,
      locationType: 'central_warehouse',
    });
    await screen.findByText('Un');
    expect(
      screen.getByRole('button', { name: /harakat qo.shish/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Row 7: ai_assistant — same read-only treatment as PM
// ---------------------------------------------------------------------------

describe('RBAC matrix — ai_assistant (read-and-recommend)', () => {
  it('cannot transition production orders', async () => {
    installFetch();
    renderWithProviders(<ProductionOrdersPage />, { role: 'ai_assistant' });
    await screen.findByText('Napoleon');
    expect(screen.queryByRole('button', { name: 'Yakunlash' })).toBeNull();
    expect(screen.queryByRole('button', { name: /yangi zayafka/i })).toBeNull();
  });

  it('cannot move stock', async () => {
    installFetch();
    renderWithProviders(<StockPage />, { role: 'ai_assistant' });
    await screen.findByText('Un');
    expect(
      screen.queryByRole('button', { name: /harakat qo.shish/i }),
    ).toBeNull();
  });
});
