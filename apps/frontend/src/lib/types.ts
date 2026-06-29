/**
 * Shared domain types for the ADIA ERP web client.
 * Mirrors the API contract in docs/specs/phase-1-mvp.md §4 and §6
 * and the DB schema in docs/architecture/db-schema-phase-1.sql.
 */

/**
 * RBAC roles — phase-1-mvp.md §6 matrix columns.
 *
 * `ai_assistant` mirrors the backend `user_role` enum (auth/roles.ts) so
 * the client type stays drift-free. It is NOT user-facing in Faza-1 — the
 * sidebar, role-routes, and forms never offer it as an option — but a
 * `User` returned by the API may legitimately carry it.
 */
export type Role =
  | 'super_admin'
  | 'pm'
  | 'raw_warehouse_manager'
  | 'production_manager'
  | 'supply_manager'
  | 'central_warehouse_manager'
  | 'store_manager'
  | 'ai_assistant';

/**
 * Location classification — db-schema location_type enum.
 *
 * `sex_storage` is the post-rename name for what used to be the
 * "ta'minot" layer (Tort skladi / Perojniy skladi / Yarim Fabrika skladi).
 * The legacy `supply` value is kept in the union so the frontend stays
 * backward-compatible while the backend ENUM migration is in flight —
 * any UI surface that needs to label or branch on the layer treats the
 * two values as synonyms (sex storage is the canonical name).
 */
export type LocationType =
  | 'raw_warehouse'
  | 'production'
  | 'supply'
  | 'sex_storage'
  | 'central_warehouse'
  | 'store';

/** Product classification — db-schema product_type enum. */
export type ProductType = 'raw' | 'semi' | 'finished';

/** Unit of measure — db-schema unit_type enum. */
export type Unit = 'kg' | 'l' | 'pcs';

/** stock_movement reason — db-schema movement_reason enum. */
export type MovementReason =
  | 'sale'
  | 'production_input'
  | 'production_output'
  | 'transfer'
  | 'purchase'
  | 'adjust';

/**
 * Identifier type for all primary/foreign keys. The backend serialises
 * `BIGSERIAL`/`BIGINT` columns as JSON numbers, so the client mirrors
 * that — every `id`, `location_id`, `product_id`, `parent_id`, etc. is a
 * `number`. Equality checks and `<Select>` values must account for the
 * string↔number boundary at the DOM edge (a `<select>` value is always a
 * string — see `MovementDialog`).
 */
export interface User {
  id: number;
  name: string;
  /**
   * Sole login handle (2-32 chars, `[a-z0-9._-]`). Email was dropped from
   * the identity model entirely (migration 0027): `username` is now the
   * only unique, human-friendly credential. Login is `{ login, password }`
   * where `login` is matched case-insensitively against this field.
   */
  username: string;
  role: Role;
  /**
   * Primary location id (mirrored from `user_locations.is_primary=TRUE`).
   * `null` for chain-wide roles (`pm`, `ai_assistant`).
   */
  location_id: number | null;
  /**
   * Optional — used only when constructing `POST /api/users` payloads
   * for the M:N flow (F4.1). The list endpoint does NOT echo this field.
   */
  location_ids?: number[];
  /** Optional Telegram numeric id, when provisioned by the PM. */
  telegram_id?: number | null;
}

/**
 * F4.1 / ADR-0012 — one row of `GET /api/users/:id/locations`. Uses the
 * junction-table key `location_id` and exposes `assigned_at`. Distinct
 * from `MeLocation`, the lighter shape embedded in `/api/auth/me`.
 */
export interface UserLocation {
  location_id: number;
  name: string;
  type: LocationType;
  is_primary: boolean;
  assigned_at: string;
}

/**
 * F4.1 / ADR-0012 — one row inside `MeResponse.locations`. Uses `id`
 * (matching the `locations` table) and omits `assigned_at`; `/api/auth/me`
 * is hot and the LocationSwitcher does not need the timestamp.
 */
export interface MeLocation {
  id: number;
  name: string;
  type: LocationType;
  is_primary: boolean;
}

/** `GET /api/auth/me` envelope (F4.1). */
export interface MeResponse {
  user: User;
  locations: MeLocation[];
  /** `null` for PMs who have not selected one yet (chain-wide view). */
  active_location_id: number | null;
}

export interface Location {
  id: number;
  name: string;
  type: LocationType;
  stage_role?: 'final' | 'zagatovka' | null;
  parent_id: number | null;
  manager_user_id: number | null;
  poster_storage_id: number | null;
  lead_time_days: number | null;
  review_days: number | null;
  safety_factor: number | null;
}

/**
 * EPIC 2.1 — explicit M:N supply-chain flow type. Mirrors the
 * `location_flows.flow_type` CHECK constraint (migration 0026):
 *
 *   - `production_output` — sex → its sex storage (or shared Yarim Fabrika)
 *   - `bom_input`         — Yarim Fabrika skladi → sex (semi-finished re-use)
 *   - `forward`           — sex_storage → markaziy / markaziy → store
 *   - `reverse`           — claw-back / returns (markaziy → upstream)
 *
 * Identical value set to {@link DashboardChainEdgeType}; kept as a separate
 * alias so the admin CRUD surface and the read-only dashboard edge can evolve
 * independently if the constraint ever diverges.
 */
export type FlowType = 'production_output' | 'bom_input' | 'forward' | 'reverse';

/**
 * EPIC 2.1 — one row of the `location_flows` junction table, as returned by
 * the admin connection-management endpoint.
 *
 * TODO(backend, Wave-5): the `GET/POST/DELETE /api/locations/flows` CRUD
 * endpoints do not exist yet — only the dashboard ecosystem aggregate reads
 * `location_flows` (D-0026). The admin UI targets the contract below; once
 * backend-engineer ships it, no frontend change is required.
 */
export interface LocationFlow {
  id: number;
  from_location_id: number;
  to_location_id: number;
  flow_type: FlowType;
  note: string | null;
}

export interface Product {
  id: number;
  name: string;
  type: ProductType;
  unit: Unit;
  sku: string | null;
  poster_ingredient_id: number | null;
  poster_product_id: number | null;
  is_active: boolean;
  cost_price?: number | null;
  sell_price?: number | null;
  /** Batch output in kg for semi-finished products (from Poster prepack `out`). Default 1. */
  batch_yield?: number | null;
  total_qty?: number;
  /** Which production sex is responsible for making this product. */
  production_location_id?: number | null;
  /** Default warehouse where this product is stored after production or purchase. */
  storage_location_id?: number | null;
  /** Minimum stock threshold — alerts when stock drops below this. */
  min_qty?: number | null;
  /** Maximum stock threshold — alerts when stock exceeds this. */
  max_qty?: number | null;
  /** When true, Poster sync will not overwrite this product's recipe. */
  recipe_locked?: boolean;
}

/** One row from the stock-alerts endpoint. */
export interface StockAlert {
  id: number;
  name: string;
  type: ProductType;
  unit: Unit;
  min_qty: number | null;
  max_qty: number | null;
  storage_location_id: number | null;
  storage_location_name: string | null;
  current_qty: number;
  alert: 'below_min' | 'above_max';
}

/** One recipe line where this product is used as a component. */
export interface UsedInEntry extends Product {
  qty_per_unit: number;
  stage: RecipeStage | null;
}

/**
 * BOM stage — EPIC 1.5. Splits a finished-product recipe into the dough /
 * cream / decoration phases the bakers think in. The backend adds
 * `recipes.stage` in Wave-3; until it ships, the column may be absent on
 * the wire — every UI surface treats a missing/`null`/unknown stage as
 * `other` and degrades gracefully (a single "Boshqa" section).
 */
export type RecipeStage = 'dough' | 'cream' | 'decoration' | 'other';

/** A single BOM line — phase-1-mvp.md §4.3, extended in EPIC 1.5. */
export interface RecipeLine {
  id?: number;
  component_product_id: number;
  qty_per_unit: number;
  /** Gross weight before cooking/waste loss (Poster: Брутто). 0 = not set. */
  brutto?: number;
  component_name?: string;
  component_unit?: string;
  component_cost_price?: number | null;
  /** Product type of the component — 'raw' | 'semi' | 'finished'. */
  component_type?: string;
  stage?: RecipeStage | null;
}

/** Stock row for a (location, product) pair — phase-1-mvp.md §4.4. */
export interface StockRow {
  location_id: number;
  product_id: number;
  qty: number;
  min_level: number;
  max_level: number;
  /** db-schema: minmax_mode CHECK (minmax_mode IN ('manual','dynamic')). */
  minmax_mode: 'manual' | 'dynamic';
  updated_at: string;
  /** Embedded by the backend for display — `GET /api/stock` always sends these. */
  product_name: string;
  product_unit: Unit;
  location_name?: string;
}

/** Stock ledger entry — phase-1-mvp.md §4.4. */
export interface StockMovement {
  id: number;
  product_id: number;
  from_location_id: number | null;
  to_location_id: number | null;
  qty: number;
  reason: MovementReason;
  note: string | null;
  created_at: string;
  created_by: number | null;
  /** Embedded by the backend for display — always present on list responses. */
  product_name: string;
  product_unit: Unit;
  from_location_name: string | null;
  to_location_name: string | null;
}

/** Standard API error envelope — phase-1-mvp.md §4.10. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * `POST /api/auth/login` request body. `login` is the username (2-32 chars,
 * `[a-z0-9._-]`), matched case-insensitively against `users.username`.
 * Email was removed from the identity model (migration 0027) — username is
 * the sole login handle.
 */
export interface LoginRequest {
  login: string;
  password: string;
}

/**
 * `POST /api/auth/login` response — Sprint 3 added the refresh-token flow.
 * `token` is a backward-compat alias for `access_token` (kept by the
 * backend); the client prefers the explicit `access_token` field.
 */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  /** Backward-compat alias for `access_token`. */
  token?: string;
  user: User;
}

/** `POST /api/auth/refresh` response — rotated token pair. */
export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  user: User;
}

/**
 * Paginated envelope returned by `GET /api/stock/movements`.
 * The only list endpoint that wraps its rows — every other list endpoint
 * returns a bare array.
 */
export interface MovementsResponse {
  items: StockMovement[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Sprint 2 — replenishment, production orders, purchase orders.
// Mirrors `apps/backend/src/services/{replenishment,productionOrder,purchaseOrder}.ts`.
// ---------------------------------------------------------------------------

/** Replenishment state machine — phase-1-mvp.md §3 (10 holat). */
export type ReplenishmentStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER'
  | 'CHECK_PRODUCTION_INPUT'
  | 'CREATE_PURCHASE_ORDER'
  | 'CREATE_PRODUCTION_ORDER'
  | 'PRODUCING'
  | 'DONE_TO_WAREHOUSE'
  | 'CLOSED'
  | 'CANCELLED';

/** Terminal replenishment statuses — no further transitions allowed. */
export const TERMINAL_REPLENISHMENT_STATUSES: readonly ReplenishmentStatus[] = [
  'CLOSED',
  'CANCELLED',
];

/**
 * A single replenishment_requests row.
 * `qty_needed` is a JS `number`: the backend pool (`apps/backend/src/db/pool.ts`)
 * registers a NUMERIC (OID 1700) type parser that calls `parseFloat`, so every
 * NUMERIC column arrives on the wire and at this client as a plain number.
 * Faza-1 columns are NUMERIC(14,4) / NUMERIC(14,2) — well within JS exact
 * integer/float range.
 */
export interface ReplenishmentRequest {
  id: number;
  product_id: number;
  requester_location_id: number;
  target_location_id: number | null;
  qty_needed: number;
  status: ReplenishmentStatus;
  production_order_id: number | null;
  purchase_order_id: number | null;
  shipment_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /**
   * Embedded by the backend for display — `GET /api/replenishment` and
   * `GET /api/replenishment/:id` always send these (JOIN products /
   * locations). `target_location_name` is nullable because the column
   * itself is optional.
   */
  product_name: string;
  product_unit: Unit;
  requester_location_name: string;
  target_location_name: string | null;
  /**
   * Sex (production location) name embedded by the backend when this
   * request has a linked `production_order_id`. `null` when no production
   * order is linked yet (e.g. NEW / CHECK_STORE_SUPPLIER). Drives the
   * sex-specific label on PRODUCING / CHECK_PRODUCTION_INPUT /
   * CREATE_PRODUCTION_ORDER ("Tort sexi ishlab chiqarmoqda").
   */
  production_location_name: string | null;
}

/** A single replenishment_transitions audit row. */
export interface ReplenishmentTransition {
  id: number;
  from_status: ReplenishmentStatus | null;
  to_status: ReplenishmentStatus;
  reason: string | null;
  actor_user_id: number | null;
  created_at: string;
  /**
   * Embedded by the backend — JOIN users so the UI can render "kim"
   * without an extra `/api/users` fetch. `null` for system / cron rows.
   */
  actor_name: string | null;
}

/** `GET /api/replenishment/:id` envelope — request + transitions tarixi. */
export interface ReplenishmentDetail {
  request: ReplenishmentRequest;
  transitions: ReplenishmentTransition[];
}

/** `POST /api/replenishment/:id/advance` envelope. */
export interface ReplenishmentAdvanceResponse {
  advanced: boolean;
  status: ReplenishmentStatus;
  reason: string;
  request: ReplenishmentRequest;
}

/** Production order status — production_orders.status enum. */
export type ProductionOrderStatus = 'new' | 'in_progress' | 'done' | 'cancelled';

/**
 * A single production_orders row.
 * `qty` is a JS `number` — see the NUMERIC parser note on
 * `ReplenishmentRequest.qty_needed`.
 * `deadline` is an ISO date (YYYY-MM-DD) or null.
 */
export interface ProductionOrder {
  id: number;
  product_id: number;
  qty: number;
  location_id: number;
  target_location_id: number | null;
  deadline: string | null;
  status: ProductionOrderStatus;
  replenishment_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  /**
   * Embedded by the backend for display — `GET /api/production-orders`
   * always sends these. `target_location_name` is nullable because the
   * column itself is optional.
   */
  product_name: string;
  location_name: string;
  target_location_name: string | null;
  /** ADR-0016: 'final' (main order) | 'zagatovka' (auto sub-order for semi). */
  stage_role?: string;
  parent_production_order_id?: number | null;
}

/** One node in the recursive BOM tree returned by GET /api/production-orders/:id/bom. */
export interface BomNode {
  component_product_id: number;
  component_name: string;
  component_type: 'raw' | 'semi' | 'finished';
  component_unit: string;
  cost_price: number | null;
  qty: number;
  brutto: number | null;
  stage: string | null;
  children: BomNode[];
}

/** One raw-material line in the dispatch summary. */
export interface DispatchLine {
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
}

/** One row from `production_dispatches` — tracked warehouse dispatch item. */
export interface ProductionDispatch {
  id: number;
  production_order_id: number;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty_needed: number;
  status: 'pending' | 'dispatched' | 'received';
  from_location_id: number | null;
  from_location_name?: string | null;
  from_location_type?: string | null;
  /** Type of the dispatched product. 'raw' | 'semi' | 'finished' */
  product_type?: string | null;
  /** Type of the production ORDER's main product — used to route dispatches to the correct page. */
  po_product_type?: string | null;
  to_location_id: number | null;
  /** Joined from locations — present on daily-dispatch responses. */
  to_location_name?: string | null;
  movement_id: number | null;
  created_at: string;
  dispatched_at: string | null;
  dispatched_by: number | null;
  received_at: string | null;
  received_by: number | null;
}

/** `GET /api/production-orders/:id/bom` response envelope. */
export interface ProductionOrderBomResponse {
  order: ProductionOrder & { product_unit: string };
  bom: BomNode[];
  dispatch: DispatchLine[];
  sub_orders: (ProductionOrder & { product_unit: string })[];
}

/** `GET /api/production-orders/bom-preview` response. */
export interface BomPreviewResponse {
  bom: BomNode[];
  dispatch: DispatchLine[];
  suggested_location_id: number | null;
}

/** `GET /api/production-orders/daily-dispatch` response envelope. */
export interface DailyDispatchResponse {
  date: string;
  orders: { id: number; product_id: number; qty: number; product_name: string; location_name: string; product_type: string }[];
  dispatch: DispatchLine[];
  dispatch_items: ProductionDispatch[];
}

/** Purchase order status — purchase_orders.status enum. */
export type PurchaseOrderStatus =
  | 'draft'
  | 'approved'
  | 'received'
  | 'cancelled'
  | 'rejected';

/** Two-step approval step identifier — purchaseOrder.ts ApprovalStep. */
export type PurchaseApprovalStep = 'manager' | 'keeper';

// ---------------------------------------------------------------------------
// Sprint 3 — M8 Dashboard overview.
// Mirrors `apps/backend/src/routes/dashboard.ts` OverviewResponse.
// ---------------------------------------------------------------------------

/** Below-min row embedded in `DashboardOverview.below_min`. */
export interface DashboardBelowMinItem {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  qty: number;
  min_level: number;
  max_level: number;
  /** The open replenishment request id, if any (invariant 2: at most one). */
  open_request_id: number | null;
  /** Backend serialises the status enum as string; null when no open request. */
  open_request_status: ReplenishmentStatus | null;
}

/** Production plan row embedded in `DashboardOverview.production_plan`. */
export interface DashboardProductionPlanItem {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  status: ProductionOrderStatus;
  location_id: number;
  location_name: string;
  target_location_id: number | null;
  target_location_name: string | null;
  /** Date-only `YYYY-MM-DD` or null. */
  deadline: string | null;
}

/** Recent movement row embedded in `DashboardOverview.recent_movements`. */
export interface DashboardRecentMovementItem {
  id: number;
  created_at: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  qty: number;
  reason: MovementReason;
}

/**
 * F4.14 — `GET /api/dashboard/revenue-breakdown?date=YYYY-MM-DD` envelope.
 *
 * Aggregates the day's cheques by payment method. `byMethod.other` is
 * a catch-all for cheque payment-types that don't map to one of the
 * four canonical methods (cash, card, payme, click). Numbers are local
 * currency major units (so'm), matching the rest of the dashboard.
 */
export interface DashboardRevenueBreakdown {
  total: number;
  byMethod: {
    cash: number;
    card: number;
    payme: number;
    click: number;
    other?: number;
  };
}

/**
 * `GET /api/dashboard/overview` envelope. Wired to the backend
 * `OverviewResponse` shape (phase-1-mvp.md §4.8, §2.8).
 */
export interface DashboardOverview {
  below_min: DashboardBelowMinItem[];
  open_requests: {
    /** Counts keyed by open replenishment status (terminal ones excluded). */
    by_status: Partial<Record<ReplenishmentStatus, number>>;
    total: number;
    /** ISO timestamp of the oldest open request, or null. */
    oldest_created_at: string | null;
  };
  production_plan: DashboardProductionPlanItem[];
  recent_movements: DashboardRecentMovementItem[];
  kpis: {
    total_open_requests: number;
    below_min_count: number;
    active_production_orders: number;
    pending_approvals: number;
  };
}

// ---------------------------------------------------------------------------
// Dashboard MEGA Redesign Sprint C — detail drawers (5 endpoints).
// Mirrors `apps/backend/src/routes/dashboardDetail.ts`.
// ---------------------------------------------------------------------------

/** `GET /api/dashboard/raw` — Mahsulot Ombori drawer. */
export interface DashboardRawDetail {
  kpis: {
    raw_product_types: number;
    total_stock_by_unit: Array<{ unit: string; qty: number }>;
    below_min_count: number;
    open_purchase_orders: number;
  };
  below_min_items: Array<{
    product_id: number;
    product_name: string;
    unit: string;
    qty: number;
    min_level: number;
    max_level: number;
    location_id: number;
    location_name: string;
  }>;
  daily_movements: Array<{ date: string; received: number; issued: number }>;
  pending_purchase_orders: Array<{
    id: number;
    product_id: number;
    product_name: string;
    qty: number;
    supplier_id: number | null;
    created_at: string;
  }>;
}

/** `GET /api/dashboard/production` — Ishlab Chiqarish drawer. */
export interface DashboardProductionDetail {
  kpis: {
    active_orders: number;
    done_today: number;
    overdue: number;
    sex_count: number;
  };
  active_orders: Array<{
    id: number;
    product_id: number;
    product_name: string;
    qty: number;
    location_id: number;
    location_name: string;
    deadline: string | null;
    status: 'in_progress' | 'done';
    is_overdue: boolean;
  }>;
  top_produced_today: Array<{
    product_id: number;
    product_name: string;
    qty: number;
  }>;
  daily_io: Array<{ date: string; input: number; output: number }>;
  sex_load: Array<{
    location_id: number;
    location_name: string;
    open_orders: number;
    planned_qty: number;
  }>;
}

/** `GET /api/dashboard/supply` — Ta'minot bo'limi drawer. */
export interface DashboardSupplyDetail {
  kpis: {
    current_stock_count: number;
    open_requests: number;
    shipped_today: number;
    received_today: number;
  };
  daily_flow: Array<{ date: string; received: number; shipped: number }>;
  top_destinations_today: Array<{
    location_id: number;
    location_name: string;
    qty: number;
  }>;
  open_request_items: Array<{
    id: number;
    product_id: number;
    product_name: string;
    qty_needed: number;
    target_location_id: number;
    target_location_name: string;
    status: string;
    created_at: string;
  }>;
}

/** `GET /api/dashboard/central` — Markaziy Sklad drawer. */
export interface DashboardCentralDetail {
  kpis: {
    block_count: number;
    total_sku: number;
    below_min_count: number;
    last_sync_at: string | null;
    last_sync_status: 'ok' | 'partial' | 'failed' | null;
    sync_errors_24h: number;
  };
  blocks: Array<{
    location_id: number;
    location_name: string;
    product_count: number;
    below_min_count: number;
    total_qty: number;
  }>;
  recent_sync_log: Array<{
    id: number;
    entity: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    records_in: number;
    records_applied: number;
    error_detail: string | null;
  }>;
  daily_sync_runs: Array<{
    date: string;
    ok: number;
    partial: number;
    failed: number;
  }>;
}

/** `GET /api/dashboard/stores` — Do'konlar drawer. */
export interface DashboardStoresDetail {
  kpis: {
    store_count: number;
    sales_today_sum: number;
    sales_today_count: number;
    avg_receipt_today: number;
  };
  store_breakdown: Array<{
    location_id: number;
    location_name: string;
    sales_sum: number;
    sales_count: number;
    below_min_count: number;
    open_replenishments: number;
  }>;
  top_products_today: Array<{
    product_id: number;
    product_name: string;
    unit: string;
    qty: number;
    revenue: number;
  }>;
  /** 7 days x 24 hours; day_offset 0 = today, up to 6 = 6 days ago. */
  hourly_heatmap: Array<{ day_offset: number; hour: number; qty: number }>;
  daily_sales: Array<{ date: string; qty: number; revenue: number }>;
}

/**
 * `GET /api/dashboard/suppliers` — top-5 active suppliers for the
 * `EcosystemCanvas` left-side cluster. PM / ai_assistant only (chain-wide).
 * `supplier_id === null` is the "noma'lum yetkazib beruvchi" bucket. `status`
 * is the traffic light: 0 pending → `ok`, 1-2 → `warn`, 3+ → `danger`.
 */
export interface DashboardSuppliersResponse {
  suppliers: Array<{
    supplier_id: number | null;
    supplier_name: string;
    pending_pos: number;
    total_pos: number;
    received_qty: number;
    expected_qty: number;
    status: 'ok' | 'warn' | 'danger';
  }>;
}

// ---------------------------------------------------------------------------
// Faza-2 — F2.1 dynamic min/max + F2.3 import warnings admin.
// Mirrors `apps/backend/src/routes/admin.ts` (phase-2.md §4.3, §7.3).
// ---------------------------------------------------------------------------

/** `import_warnings.severity` enum (phase-2.md §7.3). */
export type ImportWarningSeverity = 'info' | 'warning' | 'error';

/**
 * A single `import_warnings` row — Poster sync / BOM mismatch /
 * dynamic-recalc anomalies surface here for the PM (phase-2.md §2.3.3).
 */
export interface ImportWarning {
  id: number;
  source: string;
  entity: string | null;
  severity: ImportWarningSeverity;
  message: string;
  payload: Record<string, unknown> | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

/** `GET /api/admin/import-warnings` envelope (phase-2.md §4.3). */
export interface ImportWarningsResponse {
  items: ImportWarning[];
  total: number;
  limit: number;
  offset: number;
}

/** `POST /api/admin/recalc-minmax` response (phase-2.md §4.3). */
export interface RecalcMinMaxResponse {
  updated_count: number;
  skipped_count: number;
  errors: Array<{ location_id: number; product_id: number; message: string }>;
}

// ---------------------------------------------------------------------------
// Faza-2 — F2.2 AI Assistant (Vertex AI Gemini, read-only).
// Mirrors `apps/backend/src/routes/assistant.ts` (phase-2.md §2.2, §4.1).
// ADR-0006 — `session_id` is a `number` for the frontend contract; the
// backend may carry it as UUID internally and surface a numeric handle, or
// emit it as bigint. We type as `number` per the team-lead spec; tests
// stub with simple integers.
// ---------------------------------------------------------------------------

/** A single tool-call summary attached to an assistant response. */
export interface AssistantToolCall {
  /** Tool function name, e.g. `get_stock`, `get_below_min`. */
  tool_name: string;
  /** Arguments the model called the tool with (server-injected RBAC scope is not shown). */
  args: Record<string, unknown>;
  /** Short human-readable summary of the tool result (e.g. "12 qator topildi"). */
  result_summary: string;
}

/**
 * Faza-3 F3.2 — AI write-action two-phase commit.
 * Mirrors `assistant_actions.status` enum on the backend.
 */
export type AssistantActionStatus =
  | 'pending'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'superseded';

/**
 * Pending write-action surfaced by the backend when the model invoked a
 * write tool. The UI renders a `PendingActionCard` and the user must
 * either `/confirm` or `/reject` before the side-effect lands.
 * Carried both inline (in `AssistantQueryResponse.pending_action`) and
 * attached to the assistant turn in `AssistantMessage.pending_action`.
 */
export interface AssistantPendingAction {
  action_id: number;
  tool_name: string;
  /** Human-readable one-line Uzbek summary of the action. */
  summary: string;
  args: Record<string, unknown>;
  /** ISO timestamp — action turns to `expired` after this moment. */
  expires_at: string;
}

/**
 * Resolved action — i.e. one that the user has confirmed or rejected,
 * or which the server has marked expired/superseded. Surfaces in the
 * message timeline (rebuilt from session history) and as the response of
 * `/confirm` and `/reject`.
 */
export interface AssistantActionResult {
  action_id: number;
  tool_name: string;
  summary: string;
  status: AssistantActionStatus;
  /** Tool-specific success payload; null on rejected/expired. */
  result?: unknown;
}

/**
 * `POST /api/assistant/query` response envelope.
 * `session_id` is returned even on the first turn (the backend created a new session).
 * `pending_action` is present when the model invoked a write tool — UI must surface it.
 */
export interface AssistantQueryResponse {
  session_id: number;
  /** Final assistant text — markdown allowed. */
  response: string;
  tool_calls: AssistantToolCall[];
  pending_action?: AssistantPendingAction;
}

/**
 * `POST /api/assistant/actions/:id/confirm` response envelope.
 * Returns the resolved action (status `executed`) plus tool-specific result.
 */
export interface AssistantConfirmActionResponse {
  action: AssistantActionResult;
}

/** `POST /api/assistant/actions/:id/reject` response envelope. */
export interface AssistantRejectActionResponse {
  action: AssistantActionResult;
}

/** A single chat message row, both for the live UI and for session history. */
export type AssistantMessageRole = 'user' | 'assistant' | 'tool';

export interface AssistantMessage {
  role: AssistantMessageRole;
  /** Text content; empty for pure tool-call rows. */
  content: string;
  /** Tool-calls emitted for an `assistant` turn (or describing the `tool` row). */
  tool_calls?: AssistantToolCall[];
  /**
   * Live pending write-action attached to this assistant turn (Faza-3 F3.2).
   * Mutually exclusive with `action_result` — once the user confirms/rejects
   * or the action expires, the UI replaces this with the resolved row.
   */
  pending_action?: AssistantPendingAction;
  /**
   * Resolved write-action surfaced after confirm/reject/expire, or hydrated
   * from session history. The card switches to a read-only outcome strip.
   */
  action_result?: AssistantActionResult;
  created_at: string;
}

/** `GET /api/assistant/sessions` row. */
export interface AssistantSessionSummary {
  id: number;
  /** Auto-summarised from the first user message; nullable for brand-new sessions. */
  title: string | null;
  updated_at: string;
}

/** `GET /api/assistant/sessions` envelope. */
export interface AssistantSessionsResponse {
  items: AssistantSessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/assistant/sessions/:id` envelope. */
export interface AssistantSessionDetail {
  session: AssistantSessionSummary;
  messages: AssistantMessage[];
}

/**
 * A single purchase_orders row.
 * `qty` is a JS `number` — see the NUMERIC parser note on
 * `ReplenishmentRequest.qty_needed`. Approval timestamps are ISO strings.
 */
// ---------------------------------------------------------------------------
// Faza-3 — F3.4 Forecasting (Prophet sidecar; ADR-0010, phase-3.md §2.4).
// Mirrors `apps/backend/src/routes/forecasts.ts` ForecastsResponse.
// ---------------------------------------------------------------------------

/** A single day from the 14-day forecast horizon. */
export interface ForecastDailyPrediction {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Predicted demand (`yhat`). */
  yhat: number;
  /** Lower confidence bound (`yhat_lower`). */
  yhat_lower: number;
  /** Upper confidence bound (`yhat_upper`). */
  yhat_upper: number;
}

/**
 * A single `forecasts` row enriched with location/product names.
 * `expected_stockout_date` is `YYYY-MM-DD` or `null` when the
 * 14-day window does not exhaust current stock.
 * `stale` is set when the row's `generated_at` is older than 24h
 * (sidecar / cron has lagged).
 */
export interface ForecastItem {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  daily_predictions: ForecastDailyPrediction[];
  expected_stockout_date: string | null;
  generated_at: string;
  stale: boolean;
}

/** `GET /api/forecasts` envelope. */
export interface ForecastsResponse {
  items: ForecastItem[];
}

// ---------------------------------------------------------------------------
// Faza-4 — F4.4 Dashboard ecosystem extension (phase-4.md §2.4).
// Mirrors `apps/backend/src/routes/dashboard.ts` GET /api/dashboard/ecosystem.
// ---------------------------------------------------------------------------

/** Poster POS sync run status — mirrors backend `poster_sync_runs.status`. */
export type PosterSyncStatus = 'ok' | 'partial' | 'failed';

/** Severity of a notification surfaced on the dashboard alerts feed. */
export type AlertSeverity = 'info' | 'warning' | 'danger';

/**
 * Notification type emitted by the backend `notifications` table. Mirrors
 * `apps/backend/src/services/notify.ts` `NotificationType`.
 */
export type DashboardAlertType =
  | 'stock_below_min'
  | 'replenishment_created'
  | 'production_order_created'
  | 'production_order_done'
  | 'shipment_created'
  | 'purchase_request_created'
  | 'purchase_request_approved'
  | 'poster_sync_failed'
  | 'negative_stock_detected';

/** Poster sync card — first block of the F4.4 envelope. */
export interface DashboardPosterStatus {
  /** ISO timestamp of the most recent `poster_sync_runs` finish, or null. */
  last_sync_at: string | null;
  /** null when no sync has run yet. */
  last_sync_status: PosterSyncStatus | null;
  /** Count of `import_warnings` rows with severity='error' in the last 24h. */
  sync_errors_24h: number;
  /** Number of sales rows ingested today (`poster_sales_log` rows). */
  sales_today_count: number;
  /** Total revenue of those sales, local-currency major units. */
  sales_today_sum: number;
}

/** One node in the ecosystem chain. */
export interface DashboardChainNode {
  location_id: number;
  location_name: string;
  location_type: LocationType;
  /** Number of (product, location) rows currently below `min_level`. */
  below_min_count: number;
  /** Number of non-terminal `replenishment_requests` targeting this location. */
  open_requests_count: number;
  /** Distinct products held at this location. */
  total_products: number;
  /**
   * Production-only KPI — count of `production_orders` at this sex in
   * `new` or `in_progress` status. `null` for any non-`production` row so
   * the adapter can branch on type without an extra lookup.
   *
   * Optional on the wire to keep older fixtures and the chain-layer
   * surfaces that don't depend on this KPI strict-type-safe; the
   * EcosystemCanvas adapter coalesces missing values to `0`.
   */
  active_production_orders?: number | null;
  /**
   * Production-only KPI — count of `production_orders` at this sex
   * completed (`status='done'`, `done_at` today). `null` for any
   * non-`production` row. See `active_production_orders` for the
   * optional-on-the-wire rationale.
   */
  done_today_count?: number | null;
}

// ---------------------------------------------------------------------------
// Dashboard MEGA Redesign Sprint B — `chain_summary` (one row per chain stage)
// ---------------------------------------------------------------------------
// `DashboardChainNode` (above) is row-per-location and stays the source for
// the existing `EcosystemHealthBar`. `ChainSummaryNode` is row-per-CHAIN-TYPE
// — exactly five entries (raw / production / supply / central / store) for
// the new `ChainFlowRow`. Mirrors `apps/backend/src/routes/dashboard.ts`
// `fetchChainSummary` (Sprint B / task B3).
// ---------------------------------------------------------------------------

export type ChainStatus = 'ok' | 'warn' | 'danger';

/**
 * Per-stage "pulse" — today's activity highlight. Discriminated union by
 * `kind` so each card can render type-specific micro-content. All numeric
 * fields are raw values (no formatting applied) — the UI formats with
 * Uzbek locale + the right unit suffix.
 *
 * Sprint C — extended KPIs are now produced by `fetchChainSummary` on every
 * response. Fields are kept OPTIONAL on the wire so existing fixtures /
 * adapters that still ship the Sprint-B shape stay valid; `chainFlowAdapter`
 * treats missing values as `0` / `null`. Once frontend-engineer strict-types
 * the adapter the `?` markers can be dropped. Mirrors
 * `apps/backend/src/routes/dashboard.ts` `ChainPulse`.
 */
export type ChainPulse =
  | {
      kind: 'raw';
      // Sprint B
      received_today: number;
      issued_today: number;
      // Sprint C
      /** Open `purchase_orders` whose target is a raw warehouse. */
      pending_purchase_orders?: number;
      /**
       * Total qty held at raw warehouses, grouped by `products.unit` (kg / l /
       * pcs are kept apart — never collapsed into a single scalar).
       */
      total_qty_by_unit?: Array<{ unit: string; qty: number }>;
    }
  | {
      kind: 'production';
      // Sprint B
      active_orders: number;
      done_today: number;
      // Sprint C
      /** Production orders past their `deadline` and still open. */
      overdue_orders?: number;
      /** Active production locations (sex_count). */
      sex_count?: number;
      /** Today's `production_input` qty (raw consumed by sexes). */
      input_today?: number;
      /** Today's `production_output` qty (sexes produced). */
      output_today?: number;
    }
  | {
      kind: 'supply';
      // Sprint B
      shipped_today: number;
      received_today: number;
      // Sprint C
      /** Open replenishment requests routed through a supply location. */
      open_requests?: number;
      /** Distinct destinations a supply location served today. */
      top_destination_count?: number;
    }
  | {
      kind: 'central';
      // Sprint B
      last_sync_at: string | null;
      last_sync_status: PosterSyncStatus | null;
      // Sprint C
      /** Failed `poster_sync_log` rows in the last 24h. */
      sync_errors_24h?: number;
    }
  | {
      kind: 'store';
      // Sprint B
      sales_today_sum: number;
      receipts_today: number;
      // Sprint C
      /** `sales_today_sum / receipts_today` (0 when no receipts). */
      avg_receipt_today?: number;
      /** Open replenishment requests originating from a store. */
      open_replenishments?: number;
      /**
       * Transfer movements with a replenishment link arriving at a store in
       * the last 24h (recent transit deliveries).
       */
      transit_count?: number;
      /** Best-selling product name today across stores in scope, or null. */
      top_product_name?: string | null;
      /** Total qty (units) sold today across stores in scope. */
      qty_today?: number;
    };

/** One row in `chain_summary` — exactly five entries for a chain-wide scope. */
export interface ChainSummaryNode {
  /** Supply-chain stage. */
  type: LocationType;
  /** Number of active locations of this type visible to the principal. */
  location_count: number;
  /** Distinct `product_id`s held in stock at any of those locations. */
  total_products: number;
  /** Count of `stock` rows where `qty <= min_level AND min_level > 0`. */
  below_min_count: number;
  /** Derived: 0 -> ok, 1..3 -> warn, 4+ -> danger. */
  status: ChainStatus;
  /** Type-specific "today" pulse metric — see `ChainPulse`. */
  pulse: ChainPulse;
}

/** One row in the alerts feed (mirrors `notifications` row). */
export interface DashboardAlert {
  id: number;
  type: DashboardAlertType;
  severity: AlertSeverity;
  message: string;
  /** Optional — only when the notification is location-scoped. */
  location_id: number | null;
  location_name?: string | null;
  created_at: string;
}

/** One point in the 30-day sales chart. */
export interface DashboardSalesPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Aggregate sold quantity for the day (sum of `stock_movements.qty` where reason='sale'). */
  qty: number;
}

/**
 * D-0026 — explicit M:N supply-chain edge between two locations. Sourced
 * from the backend `location_flows` table. The EcosystemCanvas now reads
 * these directly instead of inferring topology from `parent_id`.
 *
 * Flow types:
 *   - `production_output` — sex → its sex_storage (incl. shared Yarim Fabrika)
 *   - `bom_input`         — Yarim Fabrika skladi → sex (semi-finished re-use, reverse loop)
 *   - `forward`           — sex_storage → markaziy / markaziy → store
 *   - `reverse`           — claw-back / returns (markaziy → upstream)
 */
export type DashboardChainEdgeType =
  | 'production_output'
  | 'bom_input'
  | 'forward'
  | 'reverse';

export interface DashboardChainEdge {
  from: number;
  to: number;
  type: DashboardChainEdgeType;
}

/**
 * `GET /api/dashboard/ecosystem` envelope. Mirrors phase-4.md §2.4 contract.
 */
export interface DashboardEcosystem {
  poster_status: DashboardPosterStatus;
  chain_flow: DashboardChainNode[];
  /**
   * Sprint B — one row per supply-chain stage visible to the principal.
   * PM / ai_assistant see all 5 stages; a scoped manager sees only the
   * stages that intersect their assigned locations. New `ChainFlowRow`
   * UI consumes this; the legacy `EcosystemHealthBar` continues to read
   * `chain_flow`.
   */
  chain_summary: ChainSummaryNode[];
  /**
   * D-0026 — explicit M:N edges between supply-chain locations. The
   * EcosystemCanvas prefers these when present and falls back to the
   * derived layer-by-layer edges when empty (greenfield deployments).
   */
  chain_edges?: DashboardChainEdge[];
  alerts_feed: DashboardAlert[];
  sales_chart: {
    days: DashboardSalesPoint[];
  };
}

export interface PurchaseOrder {
  id: number;
  product_id: number;
  qty: number;
  supplier_id: number | null;
  target_location_id: number;
  status: PurchaseOrderStatus;
  replenishment_id: number | null;
  manager_approved_by: number | null;
  manager_approved_at: string | null;
  keeper_approved_by: number | null;
  keeper_approved_at: string | null;
  received_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /**
   * Embedded by the backend for display — `GET /api/purchase-orders`
   * always sends these. Approver / supplier names are nullable because
   * the referenced FK columns are themselves optional.
   */
  product_name: string;
  target_location_name: string;
  manager_approved_name: string | null;
  keeper_approved_name: string | null;
  supplier_name: string | null;
}

// ---------------------------------------------------------------------------
// Faza-4 — F4.6 chain-layer pages (raw / production / supply / central / stores).
// Mirrors `apps/backend/src/routes/dashboard.ts` GET /api/dashboard/chain-layer/:type
// and GET /api/sales. Each chain-layer page consumes the same envelope so the
// shared `ChainLayerLayout` can render KPI strip + locations grid + recent
// movements consistently across the five module screens.
// ---------------------------------------------------------------------------

/** One location row inside the chain-layer locations grid. */
export interface ChainLayerLocation {
  id: number;
  name: string;
  type: LocationType;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
}

/** Aggregate counters for a chain-layer KPI strip. */
export interface ChainLayerTotals {
  total_locations: number;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
  /** Only present for `location_type === 'production'`. */
  active_production_orders?: number;
  /** Only present for `location_type === 'supply'` / `central_warehouse`. */
  pending_shipments?: number;
  /** Only present for `location_type === 'store'`. */
  sales_today_count?: number;
}

/** Recent movement row scoped to a chain-layer. */
export interface ChainLayerMovement {
  id: number;
  created_at: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  qty: number;
  reason: MovementReason;
}

/**
 * `GET /api/dashboard/chain-layer/:type` envelope.
 *
 * `:type` is one of the five `LocationType` enum values; the backend
 * returns a payload tailored to that layer (aggregate counters tied to the
 * layer's role in the supply chain plus the locations belonging to it).
 */
export interface ChainLayerOverview {
  layer_type: LocationType;
  locations: ChainLayerLocation[];
  totals: ChainLayerTotals;
  recent_movements: ChainLayerMovement[];
}

/**
 * One row returned by `GET /api/sales?location_id=&from=&to=`.
 * `qty` is the quantity sold in `product_unit` (kg / l / dona). `total`
 * is the line total in local-currency major units (Poster gives us this
 * pre-aggregated on the cheque line). `created_at` is the cheque time.
 */
export interface SaleRow {
  id: number;
  /** Backend column: `sales.store_id`. */
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  qty: number;
  /** Unit price; multiply by qty for the line total. */
  price: number;
  sold_at: string;
  poster_transaction_id: number;
}

/** GET /api/sales returns `{ items, total, limit, offset }`. */
export interface SalesResponse {
  items: SaleRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * F4.10 — delivery task view derived from a replenishment_request.
 * `GET /api/delivery/tasks?status=` returns a bare list of these rows.
 * The backend joins the request with its requester/target locations and
 * the assigned delivery user.
 */
export type DeliveryStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER';

export interface DeliveryTask {
  id: number;
  replenishment_id: number;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  qty_needed: number;
  status: DeliveryStatus;
  requester_location_id: number;
  requester_location_name: string;
  target_location_id: number | null;
  target_location_name: string | null;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// EPIC 8 — Kassa / chek & nakladnoy (owner feedback, changes-2026-05).
//
// The backend contracts below (cash shifts, safe expenses, nakladnoy) are
// NOT implemented yet — they are gaps P8/P10/P11 in
// docs/specs/changes-2026-05-owner-feedback.md (Poster finance API + write
// layer). These types describe the EXPECTED shape so the UI can be built
// and unit-tested against fixtures now; swap the `// TODO(backend)` fetches
// to the real endpoints once they land. Keep the field names stable so the
// backend can target them.
// ---------------------------------------------------------------------------

/**
 * EPIC 8.2/8.3 — per-receipt (chek) stock reconciliation line.
 *
 * For one sold product inside a check: opening stock (`ost`), how many were
 * sold (`sold`), and the resulting remainder (`remaining = ost - sold`).
 * When the cash register rang up MORE than was on hand, `remaining` is
 * negative — a "fors-major" / "noto'g'ri urilgan" situation the owner wants
 * flagged visually (8.3). Stock itself never goes negative (invariant 3);
 * this is a reporting signal, not a stored qty.
 */
export interface ReceiptStockLine {
  product_id: number;
  product_name: string;
  product_unit: Unit;
  /** Opening on-hand before this check (ost). */
  opening_qty: number;
  /** Quantity sold on this check (sotildi). */
  sold_qty: number;
  /** opening_qty - sold_qty; negative means over-sold (fors-major). */
  remaining_qty: number;
}

/**
 * EPIC 8.1/8.2 — a single cash-register check with per-line stock
 * reconciliation. Extends the F4.9 receipt shape with `lines`.
 */
export interface ReceiptWithStock {
  poster_transaction_id: number;
  store_id: number;
  store_name: string;
  sold_at: string;
  total_qty: number;
  total_revenue: number;
  line_count: number;
  lines: ReceiptStockLine[];
  /** True when any line oversold (remaining_qty < 0). */
  has_force_majeure: boolean;
}

/** `GET /api/sales/receipts/stock` envelope (EPIC 8.2). */
export interface ReceiptsStockResponse {
  items: ReceiptWithStock[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * EPIC 8.5 — do'kon kassa smenasi (cash shift) close-out.
 *
 * When a store closes a shift the cashier reports the day's money flows;
 * the owner wants a kniжный/факт style balance (image2 referens):
 * itogo savdo, naqd, karta, rasxod (expenses), inkassatsiya (cash handed
 * up), and the closing qoldiq. Mirrors Poster `finance.getCashshifts`
 * (gap P8) once the backend wraps it.
 */
export type CashShiftStatus = 'open' | 'closed';

export interface CashShift {
  id: number;
  store_id: number;
  store_name: string;
  status: CashShiftStatus;
  opened_at: string;
  closed_at: string | null;
  /** Cashier (hodim) who ran the shift. */
  cashier_name: string | null;
  /** Total sales turnover (itogo savdo). */
  total_sales: number;
  /** Card / non-cash portion of sales. */
  card_amount: number;
  /** Cash portion of sales. */
  cash_amount: number;
  /** Expenses paid out of the till (rasxod). */
  expense_amount: number;
  /** Cash handed up the chain (inkassatsiya). */
  collected_amount: number;
  /** Closing till remainder (qoldiq) = cash_amount - expense - collected. */
  closing_balance: number;
  /**
   * Book vs fact discrepancy (kniжный − факт). 0 when balanced; non-zero
   * surfaces as a warning so the manager can investigate (image2).
   */
  balance_discrepancy: number;
}

/** `GET /api/cash-shifts` envelope (EPIC 8.5). */
export interface CashShiftsResponse {
  items: CashShift[];
}

/**
 * EPIC 8.7 — seyf rasxodi (safe expense). A withdrawal recorded against
 * the company safe; mirrors Poster `finance.createTransaction` (gap P11)
 * but lives ADIA-side only (owner decision: Poster stays read-only).
 */
export interface SafeExpense {
  id: number;
  /** ISO timestamp the expense was recorded. */
  spent_at: string;
  amount: number;
  /** Free-text category (e.g. "Ijara", "Maosh", "Transport"). */
  category: string;
  note: string | null;
  /** Who recorded it. */
  recorded_by_name: string | null;
}

/** `GET /api/safe-expenses` envelope (EPIC 8.7). */
export interface SafeExpensesResponse {
  items: SafeExpense[];
}

// ---------------------------------------------------------------------------
// M10 — Poster Поставки (supply deliveries)
// ---------------------------------------------------------------------------

export interface PosterSupplyItem {
  supply_id: number;
  ingredient_id: number;
  ingredient_name: string;
  ingredient_unit: string;
  qty: number;
  item_sum: number;
}

export interface PosterSupply {
  id: number;
  storage_id: number;
  storage_name: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  supply_date: string;
  supply_sum: number;
  comment: string | null;
  items: PosterSupplyItem[];
}

export interface PosterSuppliesResponse {
  items: PosterSupply[];
}

/**
 * EPIC 8.4 — zayavka → nakladnoy.
 *
 * "10 Napoleon sotildi" expands, via the recipes (BOM), into a single
 * nakladnoy split into sections (krem uchun, hamir uchun, ...) plus one
 * ITOGO roll-up of total raw material per unit (un, shakar... jami kg).
 * `stage` reuses the BOM `RecipeStage` so a section maps 1:1 to a recipe
 * stage. Mirrors a future `GET /api/nakladnoy/:id` (write layer gap P11).
 */
export interface NakladnoyMaterialLine {
  product_id: number;
  product_name: string;
  unit: Unit;
  /** Required quantity for this section, scaled to the order qty. */
  qty: number;
}

export interface NakladnoySection {
  /** BOM stage this section corresponds to (krem / hamir / bezak / boshqa). */
  stage: RecipeStage;
  lines: NakladnoyMaterialLine[];
}

/**
 * The ITOGO roll-up — total required quantity per raw material across all
 * sections (un, shakar... jami). One line per (product, unit).
 */
export interface NakladnoyTotalLine {
  product_id: number;
  product_name: string;
  unit: Unit;
  qty: number;
}

export interface Nakladnoy {
  id: number;
  /** Source order ("10 Napoleon"). */
  product_id: number;
  product_name: string;
  /** Units sold/ordered that this nakladnoy was computed for. */
  order_qty: number;
  /** Destination store/location the order came from. */
  store_id: number | null;
  store_name: string | null;
  created_at: string;
  /** Per-stage material breakdown (tepa-past bo'limlar). */
  sections: NakladnoySection[];
  /** Aggregated total per material (ITOGO umumiy un/shakar...). */
  totals: NakladnoyTotalLine[];
}

/** `GET /api/nakladnoy` envelope (EPIC 8.4). */
export interface NakladnoyListResponse {
  items: Nakladnoy[];
}
