/**
 * Dashboard MEGA Redesign — Sprint C (task C3).
 *
 *   GET /api/dashboard/raw
 *   GET /api/dashboard/production
 *   GET /api/dashboard/supply
 *   GET /api/dashboard/central
 *   GET /api/dashboard/stores
 *
 * One endpoint per supply-chain stage. Each returns a `{ kpis, ... }` block
 * tailored to that stage's drawer (`ChainDetailSheet`). The endpoints are
 * READ-ONLY (no audit-log writes) and bounded — every list is capped, every
 * window-aware query is clipped by `?range`.
 *
 * RBAC mirrors `dashboard.ts`:
 *   - `pm` / `ai_assistant`           — chain-wide.
 *   - the matching layer manager role — location-scoped (M:N
 *     `principal.locationIds`); a scoped principal with no assigned
 *     locations returns an empty payload.
 *   - every other authenticated role  — 403.
 *
 * Performance contract (mirrors /overview + /ecosystem): each handler fans
 * out independent sub-queries via `Promise.all`; window-aware aggregates use
 * the existing `ix_*_created`/`ix_sales_store_date` indexes; the daily
 * series helpers fill missing days client-side rather than running a
 * `generate_series` join. Budget: < 1 s.
 *
 * Frontend mirror types live in `apps/frontend/src/lib/types.ts` —
 * `DashboardRawDetail` ... `DashboardStoresDetail`.
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseDateRange, type DateRange } from '../lib/dateRange.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import type { Role } from '../auth/roles.js';

export const dashboardDetailRouter: Router = Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Cap any "list-of-rows" return so a misconfigured dataset never bloats the
 *  drawer payload. Each endpoint picks the cap that matches its UI. */
const TOP_BELOW_MIN = 10;
const ACTIVE_ORDERS_CAP = 50;
const TOP_PRODUCED_TODAY = 5;
const PENDING_PURCHASE_ORDERS_CAP = 50;
const SYNC_LOG_RECENT = 10;
const TOP_SHIPMENTS_TODAY = 5;
const OPEN_REQUEST_ITEMS_CAP = 50;
const TOP_BLOCKS_CAP = 10;
const TOP_PRODUCTS_TODAY = 5;
const DAILY_SERIES_MAX_POINTS = 30;

/** The terminal `replenishment_status` values — anything else is "open". */
const TERMINAL_REPL_STATUSES = ['CLOSED', 'CANCELLED'] as const;

const ACTIVE_PO_STATUSES = ['new', 'in_progress'] as const;

/**
 * Detail scope — chain-wide (PM / ai_assistant) OR location-scoped to the
 * principal's assigned `locationIds`. `empty` is the scoped-with-no-locations
 * branch and produces an empty payload (mirrors the rest of the dashboard
 * surface).
 */
type DetailScope =
  | { kind: 'chain' }
  | { kind: 'locations'; locationIds: number[] }
  | { kind: 'empty' };

/** Map each detail page to its layer manager role (PM / ai_assistant pass any). */
const DETAIL_LAYER_ROLE = {
  raw: 'raw_warehouse_manager',
  production: 'production_manager',
  supply: 'supply_manager',
  central: 'central_warehouse_manager',
  stores: 'store_manager',
} as const;
type DetailLayer = keyof typeof DETAIL_LAYER_ROLE;

/** Translate (principal, layer) into a `DetailScope`. Layer-role mismatch
 *  is caught earlier (handler-level `assertLayerAccess`). */
function resolveDetailScope(principal: AuthPrincipal): DetailScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  if (principal.locationIds.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'locations', locationIds: principal.locationIds };
}

function assertLayerAccess(principal: AuthPrincipal, layer: DetailLayer): void {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') return;
  const expected: Role = DETAIL_LAYER_ROLE[layer];
  if (principal.role !== expected) {
    throw AppError.forbidden('You may not view this chain layer.');
  }
}

/**
 * Append a `WHERE id IN (SELECT id FROM locations WHERE type IN (...))`
 * fragment, narrowed to the scope. Returns the SQL snippet plus the param
 * list grown in place.
 *
 * D7 (2026-05-28) — accepts a single location_type OR an array. The supply
 * layer now spans BOTH the legacy `supply` rows (none on prod after migration
 * 0022, kept as deprecated enum value) and the new `sex_storage` rows. The
 * caller passes `['supply','sex_storage']` for the supply layer so the
 * existing `ChainDetailSheet` keeps working without a frontend change.
 */
function locationIdSetForType(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
  locationType: string | readonly string[],
  params: SqlParam[],
): string {
  const types = Array.isArray(locationType) ? [...locationType] : [locationType as string];
  params.push(types);
  const typesIdx = params.length;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const locsIdx = params.length;
    return `(SELECT id FROM locations
              WHERE type::text = ANY($${typesIdx}::text[])
                AND is_active = TRUE
                AND id = ANY($${locsIdx}::bigint[]))`;
  }
  return `(SELECT id FROM locations
            WHERE type::text = ANY($${typesIdx}::text[])
              AND is_active = TRUE)`;
}

/**
 * Type aliases for the chain-layer parameter sets. `SUPPLY_LAYER_TYPES`
 * means "the sex skladi layer" — both the new `sex_storage` rows and the
 * deprecated `supply` rows.
 */
const SUPPLY_LAYER_TYPES = ['supply', 'sex_storage'] as const;

/** Format a UTC `Date` (or DATE column from pg) as `YYYY-MM-DD`. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket TIMESTAMPTZ movement rows into per-day numbers. The aggregation is
 * done in SQL by `date_trunc('day', created_at AT TIME ZONE 'UTC')` to keep
 * the result set small (<=31 rows for any sensible range).
 */
type DailyMovementRow = {
  day: Date;
  received: string;
  issued: string;
};

// ---------------------------------------------------------------------------
// GET /api/dashboard/raw — Mahsulot Ombori
// ---------------------------------------------------------------------------

type DashboardRawDetail = {
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
};

dashboardDetailRouter.get(
  '/raw',
  authenticate,
  authorize('pm', 'ai_assistant', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    assertLayerAccess(principal, 'raw');
    const scope = resolveDetailScope(principal);
    const range = parseDateRange(req.query);

    if (scope.kind === 'empty') {
      res.status(200).json(emptyRawDetail());
      return;
    }

    const [kpis, belowMinItems, daily, pendingPo] = await Promise.all([
      fetchRawKpis(scope),
      fetchRawBelowMinItems(scope),
      fetchRawDailyMovements(scope, range),
      fetchRawPendingPurchaseOrders(scope),
    ]);

    const response: DashboardRawDetail = {
      kpis,
      below_min_items: belowMinItems,
      daily_movements: daily,
      pending_purchase_orders: pendingPo,
    };
    res.status(200).json(response);
  }),
);

async function fetchRawKpis(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardRawDetail['kpis']> {
  // raw_product_types  = COUNT(DISTINCT product_id) WHERE stock row is in a
  //                      raw_warehouse location AND product.type='raw'.
  // total_stock_by_unit = SUM(qty) grouped by product.unit, same scope.
  // below_min_count    = stock rows below min_level in raw locations.
  // open_purchase_orders = purchase_orders status='approved', target a raw
  //                       location. (NB: "open PO awaiting receipt" is
  //                       business-wise an approved PO that hasn't been
  //                       received yet.)
  const params: SqlParam[] = [];
  const rawLocs = locationIdSetForType(scope, 'raw_warehouse', params);

  const stockKpisQ = query<{
    raw_product_types: string;
    below_min_count: string;
  }>(
    `SELECT
       count(DISTINCT s.product_id) FILTER (WHERE p.type = 'raw') AS raw_product_types,
       count(*) FILTER (WHERE s.qty <= s.min_level AND s.min_level > 0) AS below_min_count
     FROM stock s
     JOIN products p ON p.id = s.product_id
     WHERE s.location_id IN ${rawLocs}`,
    params,
  );

  const stockByUnitParams: SqlParam[] = [];
  const rawLocs2 = locationIdSetForType(scope, 'raw_warehouse', stockByUnitParams);
  const stockByUnitQ = query<{ unit: string; qty: string }>(
    `SELECT p.unit::text AS unit, coalesce(sum(s.qty), 0) AS qty
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id IN ${rawLocs2}
      GROUP BY p.unit
      ORDER BY p.unit`,
    stockByUnitParams,
  );

  const poParams: SqlParam[] = [];
  const rawLocs3 = locationIdSetForType(scope, 'raw_warehouse', poParams);
  const openPoQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM purchase_orders
      WHERE status = 'approved'
        AND target_location_id IN ${rawLocs3}`,
    poParams,
  );

  const [stockKpis, byUnit, openPo] = await Promise.all([
    stockKpisQ,
    stockByUnitQ,
    openPoQ,
  ]);

  return {
    raw_product_types: Number(stockKpis.rows[0]?.raw_product_types ?? 0),
    total_stock_by_unit: byUnit.rows.map((r) => ({
      unit: r.unit,
      qty: Number(r.qty),
    })),
    below_min_count: Number(stockKpis.rows[0]?.below_min_count ?? 0),
    open_purchase_orders: Number(openPo.rows[0]?.cnt ?? 0),
  };
}

async function fetchRawBelowMinItems(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardRawDetail['below_min_items']> {
  const params: SqlParam[] = [];
  const rawLocs = locationIdSetForType(scope, 'raw_warehouse', params);
  params.push(TOP_BELOW_MIN);
  const limitIdx = params.length;
  const { rows } = await query<{
    product_id: string;
    product_name: string;
    unit: string;
    qty: string;
    min_level: string;
    max_level: string;
    location_id: string;
    location_name: string;
  }>(
    `SELECT s.product_id, p.name AS product_name, p.unit::text AS unit,
            s.qty, s.min_level, s.max_level,
            s.location_id, l.name AS location_name
       FROM stock s
       JOIN products  p ON p.id = s.product_id
       JOIN locations l ON l.id = s.location_id
      WHERE s.location_id IN ${rawLocs}
        AND s.qty <= s.min_level
        AND s.min_level > 0
      ORDER BY (s.min_level - s.qty) DESC, s.product_id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    product_id: Number(r.product_id),
    product_name: r.product_name,
    unit: r.unit,
    qty: Number(r.qty),
    min_level: Number(r.min_level),
    max_level: Number(r.max_level),
    location_id: Number(r.location_id),
    location_name: r.location_name,
  }));
}

async function fetchRawDailyMovements(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<DashboardRawDetail['daily_movements']> {
  // Inbound  = reason='purchase' with to_location_id in raw set.
  // Outbound = reason='production_input' with from_location_id in raw set.
  const params: SqlParam[] = [];
  const rawLocsTo = locationIdSetForType(scope, 'raw_warehouse', params);
  const rawLocsFrom = locationIdSetForType(scope, 'raw_warehouse', params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;

  const { rows } = await query<DailyMovementRow>(
    `SELECT date_trunc('day', m.created_at) AS day,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'purchase' AND m.to_location_id IN ${rawLocsTo}
            ), 0) AS received,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'production_input' AND m.from_location_id IN ${rawLocsFrom}
            ), 0) AS issued
       FROM stock_movements m
      WHERE m.created_at >= $${fromIdx}
        AND m.created_at <  $${toIdx}
        AND (
          (m.reason = 'purchase' AND m.to_location_id IN ${rawLocsTo})
          OR (m.reason = 'production_input' AND m.from_location_id IN ${rawLocsFrom})
        )
      GROUP BY 1
      ORDER BY 1
      LIMIT ${DAILY_SERIES_MAX_POINTS}`,
    params,
  );
  return rows.map((r) => ({
    date: toIsoDate(r.day),
    received: Number(r.received),
    issued: Number(r.issued),
  }));
}

async function fetchRawPendingPurchaseOrders(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardRawDetail['pending_purchase_orders']> {
  // "Pending" = approved by both parties (status='approved') but not yet
  // received (received_movement_id IS NULL). These are POs awaiting goods.
  const params: SqlParam[] = [];
  const rawLocs = locationIdSetForType(scope, 'raw_warehouse', params);
  params.push(PENDING_PURCHASE_ORDERS_CAP);
  const limitIdx = params.length;
  const { rows } = await query<{
    id: string;
    product_id: string;
    product_name: string;
    qty: string;
    supplier_id: string | null;
    created_at: Date;
  }>(
    `SELECT po.id, po.product_id, p.name AS product_name, po.qty,
            po.supplier_id, po.created_at
       FROM purchase_orders po
       JOIN products p ON p.id = po.product_id
      WHERE po.status = 'approved'
        AND po.received_movement_id IS NULL
        AND po.target_location_id IN ${rawLocs}
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    qty: Number(r.qty),
    supplier_id: r.supplier_id === null ? null : Number(r.supplier_id),
    created_at: r.created_at.toISOString(),
  }));
}

function emptyRawDetail(): DashboardRawDetail {
  return {
    kpis: {
      raw_product_types: 0,
      total_stock_by_unit: [],
      below_min_count: 0,
      open_purchase_orders: 0,
    },
    below_min_items: [],
    daily_movements: [],
    pending_purchase_orders: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/production — Ishlab Chiqarish
// ---------------------------------------------------------------------------

type DashboardProductionDetail = {
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
};

dashboardDetailRouter.get(
  '/production',
  authenticate,
  authorize('pm', 'ai_assistant', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    assertLayerAccess(principal, 'production');
    const scope = resolveDetailScope(principal);
    const range = parseDateRange(req.query);
    if (scope.kind === 'empty') {
      res.status(200).json(emptyProductionDetail());
      return;
    }

    const [kpis, active, top, dailyIo, sexLoad] = await Promise.all([
      fetchProductionKpis(scope),
      fetchProductionActiveOrders(scope),
      fetchProductionTopToday(scope),
      fetchProductionDailyIo(scope, range),
      fetchProductionSexLoad(scope),
    ]);

    const response: DashboardProductionDetail = {
      kpis,
      active_orders: active,
      top_produced_today: top,
      daily_io: dailyIo,
      sex_load: sexLoad,
    };
    res.status(200).json(response);
  }),
);

async function fetchProductionKpis(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardProductionDetail['kpis']> {
  // active_orders : status='in_progress'  AND location is production-typed.
  // done_today    : status='done'         AND done_at within today's window.
  // overdue       : status='in_progress'  AND deadline < CURRENT_DATE.
  // sex_count     : locations.type='production' AND is_active.
  const params: SqlParam[] = [];
  const prodLocs = locationIdSetForType(scope, 'production', params);

  const poQ = query<{ active: string; done: string; overdue: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'in_progress')                                  AS active,
       count(*) FILTER (WHERE status = 'done'
                         AND done_at >= date_trunc('day', now())
                         AND done_at <  date_trunc('day', now()) + interval '1 day')   AS done,
       count(*) FILTER (WHERE status = 'in_progress' AND deadline < CURRENT_DATE)      AS overdue
       FROM production_orders
      WHERE location_id IN ${prodLocs}`,
    params,
  );

  const sexParams: SqlParam[] = [];
  const sexLocs = locationIdSetForType(scope, 'production', sexParams);
  const sexQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM locations
      WHERE id IN ${sexLocs}`,
    sexParams,
  );

  const [po, sex] = await Promise.all([poQ, sexQ]);
  return {
    active_orders: Number(po.rows[0]?.active ?? 0),
    done_today: Number(po.rows[0]?.done ?? 0),
    overdue: Number(po.rows[0]?.overdue ?? 0),
    sex_count: Number(sex.rows[0]?.cnt ?? 0),
  };
}

async function fetchProductionActiveOrders(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardProductionDetail['active_orders']> {
  const params: SqlParam[] = [];
  const prodLocs = locationIdSetForType(scope, 'production', params);
  params.push(ACTIVE_ORDERS_CAP);
  const limitIdx = params.length;
  const { rows } = await query<{
    id: string;
    product_id: string;
    product_name: string;
    qty: string;
    location_id: string;
    location_name: string;
    deadline: Date | null;
    status: 'in_progress' | 'done';
  }>(
    `SELECT po.id, po.product_id, p.name AS product_name, po.qty,
            po.location_id, l.name AS location_name,
            po.deadline, po.status
       FROM production_orders po
       JOIN products  p ON p.id = po.product_id
       JOIN locations l ON l.id = po.location_id
      WHERE po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')
        AND po.location_id IN ${prodLocs}
      ORDER BY (po.deadline IS NULL), po.deadline ASC, po.id
      LIMIT $${limitIdx}`,
    params,
  );
  const today = new Date();
  const todayIso = toIsoDate(today);
  return rows.map((r) => {
    const deadlineIso = r.deadline === null ? null : toIsoDate(r.deadline);
    return {
      id: Number(r.id),
      product_id: Number(r.product_id),
      product_name: r.product_name,
      qty: Number(r.qty),
      location_id: Number(r.location_id),
      location_name: r.location_name,
      deadline: deadlineIso,
      status: (r.status === 'done' ? 'done' : 'in_progress') as
        | 'in_progress'
        | 'done',
      is_overdue: deadlineIso !== null && deadlineIso < todayIso,
    };
  });
}

async function fetchProductionTopToday(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardProductionDetail['top_produced_today']> {
  // Top 5 products by `production_output` qty today, scoped to production
  // locations the principal can see. We sum stock_movements (the authoritative
  // ledger) rather than production_orders.qty so partial outputs are captured.
  const params: SqlParam[] = [];
  const prodLocs = locationIdSetForType(scope, 'production', params);
  params.push(TOP_PRODUCED_TODAY);
  const limitIdx = params.length;
  const { rows } = await query<{
    product_id: string;
    product_name: string;
    qty: string;
  }>(
    `SELECT m.product_id, p.name AS product_name, sum(m.qty) AS qty
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.reason = 'production_output'
        AND m.from_location_id IN ${prodLocs}
        AND m.created_at >= date_trunc('day', now())
        AND m.created_at <  date_trunc('day', now()) + interval '1 day'
      GROUP BY m.product_id, p.name
      ORDER BY sum(m.qty) DESC, m.product_id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    product_id: Number(r.product_id),
    product_name: r.product_name,
    qty: Number(r.qty),
  }));
}

async function fetchProductionDailyIo(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<DashboardProductionDetail['daily_io']> {
  const params: SqlParam[] = [];
  const prodLocsFrom = locationIdSetForType(scope, 'production', params);
  const prodLocsTo = locationIdSetForType(scope, 'production', params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;
  const { rows } = await query<{ day: Date; input: string; output: string }>(
    `SELECT date_trunc('day', m.created_at) AS day,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'production_input' AND m.to_location_id IN ${prodLocsTo}
            ), 0) AS input,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'production_output' AND m.from_location_id IN ${prodLocsFrom}
            ), 0) AS output
       FROM stock_movements m
      WHERE m.created_at >= $${fromIdx}
        AND m.created_at <  $${toIdx}
        AND (
          (m.reason = 'production_input'  AND m.to_location_id   IN ${prodLocsTo})
          OR (m.reason = 'production_output' AND m.from_location_id IN ${prodLocsFrom})
        )
      GROUP BY 1
      ORDER BY 1
      LIMIT ${DAILY_SERIES_MAX_POINTS}`,
    params,
  );
  return rows.map((r) => ({
    date: toIsoDate(r.day),
    input: Number(r.input),
    output: Number(r.output),
  }));
}

async function fetchProductionSexLoad(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardProductionDetail['sex_load']> {
  // One row per production location, showing open-order load + planned qty.
  const params: SqlParam[] = [];
  const prodLocs = locationIdSetForType(scope, 'production', params);
  const { rows } = await query<{
    location_id: string;
    location_name: string;
    open_orders: string;
    planned_qty: string;
  }>(
    `SELECT l.id AS location_id, l.name AS location_name,
            coalesce(po_agg.open_orders, 0) AS open_orders,
            coalesce(po_agg.planned_qty, 0) AS planned_qty
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_orders, coalesce(sum(qty), 0) AS planned_qty
           FROM production_orders po
          WHERE po.location_id = l.id
            AND po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')
       ) po_agg ON TRUE
      WHERE l.id IN ${prodLocs}
      ORDER BY l.id`,
    params,
  );
  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    open_orders: Number(r.open_orders),
    planned_qty: Number(r.planned_qty),
  }));
}

function emptyProductionDetail(): DashboardProductionDetail {
  return {
    kpis: { active_orders: 0, done_today: 0, overdue: 0, sex_count: 0 },
    active_orders: [],
    top_produced_today: [],
    daily_io: [],
    sex_load: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/supply — Ta'minot bo'limi
// ---------------------------------------------------------------------------

type DashboardSupplyDetail = {
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
};

dashboardDetailRouter.get(
  '/supply',
  authenticate,
  authorize('pm', 'ai_assistant', 'supply_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    assertLayerAccess(principal, 'supply');
    const scope = resolveDetailScope(principal);
    const range = parseDateRange(req.query);
    if (scope.kind === 'empty') {
      res.status(200).json(emptySupplyDetail());
      return;
    }

    const [kpis, daily, top, openItems] = await Promise.all([
      fetchSupplyKpis(scope),
      fetchSupplyDailyFlow(scope, range),
      fetchSupplyTopDestinations(scope),
      fetchSupplyOpenRequestItems(scope),
    ]);

    const response: DashboardSupplyDetail = {
      kpis,
      daily_flow: daily,
      top_destinations_today: top,
      open_request_items: openItems,
    };
    res.status(200).json(response);
  }),
);

async function fetchSupplyKpis(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardSupplyDetail['kpis']> {
  // current_stock_count : distinct products held in any supply-typed location
  //                        with qty > 0.
  // open_requests       : replenishment_requests where target=supply-typed AND
  //                        requester is a store (open status only).
  //                        Spec says "open requests targeting stores from
  //                        supply" — we use `from_location_id IN supply set`
  //                        on the underlying movement when the target is a
  //                        store. Here we approximate via requester location
  //                        type=store joined to target=supply (the supply
  //                        team services these).
  // shipped_today       : SUM(qty) reason='transfer' from_location_id in supply.
  // received_today      : SUM(qty) reason='production_output' to_location_id in supply.
  const stockParams: SqlParam[] = [];
  const supplyLocs = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, stockParams);
  const stockQ = query<{ cnt: string }>(
    `SELECT count(DISTINCT s.product_id) AS cnt
       FROM stock s
      WHERE s.location_id IN ${supplyLocs}
        AND s.qty > 0`,
    stockParams,
  );

  const openParams: SqlParam[] = [];
  const supplyLocsOpen = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, openParams);
  const openQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM replenishment_requests rr
      WHERE rr.status NOT IN ('${TERMINAL_REPL_STATUSES.join("','")}')
        AND rr.target_location_id IN ${supplyLocsOpen}`,
    openParams,
  );

  const shipParams: SqlParam[] = [];
  const supplyLocsShip = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, shipParams);
  const shipQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'transfer'
        AND from_location_id IN ${supplyLocsShip}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    shipParams,
  );

  const recvParams: SqlParam[] = [];
  const supplyLocsRecv = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, recvParams);
  const recvQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_output'
        AND to_location_id IN ${supplyLocsRecv}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    recvParams,
  );

  const [stock, open, ship, recv] = await Promise.all([
    stockQ,
    openQ,
    shipQ,
    recvQ,
  ]);
  return {
    current_stock_count: Number(stock.rows[0]?.cnt ?? 0),
    open_requests: Number(open.rows[0]?.cnt ?? 0),
    shipped_today: Number(ship.rows[0]?.total ?? 0),
    received_today: Number(recv.rows[0]?.total ?? 0),
  };
}

async function fetchSupplyDailyFlow(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<DashboardSupplyDetail['daily_flow']> {
  const params: SqlParam[] = [];
  const supplyLocsTo = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, params);
  const supplyLocsFrom = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;
  const { rows } = await query<DailyMovementRow>(
    `SELECT date_trunc('day', m.created_at) AS day,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'production_output' AND m.to_location_id IN ${supplyLocsTo}
            ), 0) AS received,
            coalesce(sum(m.qty) FILTER (
              WHERE m.reason = 'transfer' AND m.from_location_id IN ${supplyLocsFrom}
            ), 0) AS issued
       FROM stock_movements m
      WHERE m.created_at >= $${fromIdx}
        AND m.created_at <  $${toIdx}
        AND (
          (m.reason = 'production_output' AND m.to_location_id   IN ${supplyLocsTo})
          OR (m.reason = 'transfer'         AND m.from_location_id IN ${supplyLocsFrom})
        )
      GROUP BY 1
      ORDER BY 1
      LIMIT ${DAILY_SERIES_MAX_POINTS}`,
    params,
  );
  return rows.map((r) => ({
    date: toIsoDate(r.day),
    received: Number(r.received),
    shipped: Number(r.issued),
  }));
}

async function fetchSupplyTopDestinations(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardSupplyDetail['top_destinations_today']> {
  // Rank stores by qty received from supply locations today.
  const params: SqlParam[] = [];
  const supplyLocs = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, params);
  params.push(TOP_SHIPMENTS_TODAY);
  const limitIdx = params.length;
  const { rows } = await query<{
    location_id: string;
    location_name: string;
    qty: string;
  }>(
    `SELECT m.to_location_id AS location_id,
            l.name           AS location_name,
            sum(m.qty)       AS qty
       FROM stock_movements m
       JOIN locations l ON l.id = m.to_location_id
      WHERE m.reason = 'transfer'
        AND m.from_location_id IN ${supplyLocs}
        AND m.created_at >= date_trunc('day', now())
        AND m.created_at <  date_trunc('day', now()) + interval '1 day'
        AND m.to_location_id IS NOT NULL
      GROUP BY m.to_location_id, l.name
      ORDER BY sum(m.qty) DESC, m.to_location_id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    qty: Number(r.qty),
  }));
}

async function fetchSupplyOpenRequestItems(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardSupplyDetail['open_request_items']> {
  const params: SqlParam[] = [];
  const supplyLocs = locationIdSetForType(scope, SUPPLY_LAYER_TYPES, params);
  params.push(OPEN_REQUEST_ITEMS_CAP);
  const limitIdx = params.length;
  const { rows } = await query<{
    id: string;
    product_id: string;
    product_name: string;
    qty_needed: string;
    target_location_id: string;
    target_location_name: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT rr.id, rr.product_id, p.name AS product_name, rr.qty_needed,
            rr.target_location_id, tl.name AS target_location_name,
            rr.status::text AS status, rr.created_at
       FROM replenishment_requests rr
       JOIN products  p  ON p.id  = rr.product_id
       JOIN locations tl ON tl.id = rr.target_location_id
      WHERE rr.status NOT IN ('${TERMINAL_REPL_STATUSES.join("','")}')
        AND rr.target_location_id IN ${supplyLocs}
      ORDER BY rr.created_at DESC, rr.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    qty_needed: Number(r.qty_needed),
    target_location_id: Number(r.target_location_id),
    target_location_name: r.target_location_name,
    status: r.status,
    created_at: r.created_at.toISOString(),
  }));
}

function emptySupplyDetail(): DashboardSupplyDetail {
  return {
    kpis: {
      current_stock_count: 0,
      open_requests: 0,
      shipped_today: 0,
      received_today: 0,
    },
    daily_flow: [],
    top_destinations_today: [],
    open_request_items: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/central — Markaziy Sklad
// ---------------------------------------------------------------------------

type DashboardCentralDetail = {
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
};

dashboardDetailRouter.get(
  '/central',
  authenticate,
  authorize('pm', 'ai_assistant', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    assertLayerAccess(principal, 'central');
    const scope = resolveDetailScope(principal);
    const range = parseDateRange(req.query);
    if (scope.kind === 'empty') {
      res.status(200).json(emptyCentralDetail());
      return;
    }

    const [kpis, blocks, syncLog, dailyRuns] = await Promise.all([
      fetchCentralKpis(scope),
      fetchCentralBlocks(scope),
      fetchCentralRecentSyncLog(),
      fetchCentralDailySyncRuns(range),
    ]);

    const response: DashboardCentralDetail = {
      kpis,
      blocks,
      recent_sync_log: syncLog,
      daily_sync_runs: dailyRuns,
    };
    res.status(200).json(response);
  }),
);

async function fetchCentralKpis(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardCentralDetail['kpis']> {
  // block_count        : count of central_warehouse locations.
  // total_sku          : distinct products across those locations' stock.
  // below_min_count    : stock below min in central locations.
  // last_sync_*        : MAX(finished_at) over poster_sync_log entity='stock'
  //                       (spec) - we fall back to ANY entity if no stock row
  //                       exists yet, to mirror /ecosystem.
  // sync_errors_24h    : failed rows in last 24h (chain-wide; sync is global).
  const params: SqlParam[] = [];
  const centralLocs = locationIdSetForType(scope, 'central_warehouse', params);

  const stockQ = query<{
    block_count: string;
    total_sku: string;
    below_min_count: string;
  }>(
    `SELECT
       (SELECT count(*) FROM locations WHERE id IN ${centralLocs})            AS block_count,
       count(DISTINCT s.product_id)                                           AS total_sku,
       count(*) FILTER (WHERE s.qty <= s.min_level AND s.min_level > 0)       AS below_min_count
     FROM stock s
     WHERE s.location_id IN ${centralLocs}`,
    params,
  );

  const lastSyncQ = query<{
    finished_at: Date | null;
    started_at: Date;
    status: 'ok' | 'partial' | 'failed';
  }>(
    `SELECT finished_at, started_at, status::text AS status
       FROM poster_sync_log
       WHERE entity = 'leftovers'
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
  );

  const errors24hQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM poster_sync_log
       WHERE status = 'failed'
         AND started_at > now() - interval '24 hours'`,
  );

  const [stock, lastSync, errors] = await Promise.all([
    stockQ,
    lastSyncQ,
    errors24hQ,
  ]);
  const lastRow = lastSync.rows[0];
  const lastWhen = lastRow?.finished_at ?? lastRow?.started_at ?? null;
  return {
    block_count: Number(stock.rows[0]?.block_count ?? 0),
    total_sku: Number(stock.rows[0]?.total_sku ?? 0),
    below_min_count: Number(stock.rows[0]?.below_min_count ?? 0),
    last_sync_at: lastWhen === null ? null : lastWhen.toISOString(),
    last_sync_status: lastRow?.status ?? null,
    sync_errors_24h: Number(errors.rows[0]?.cnt ?? 0),
  };
}

async function fetchCentralBlocks(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardCentralDetail['blocks']> {
  const params: SqlParam[] = [];
  const centralLocs = locationIdSetForType(scope, 'central_warehouse', params);
  params.push(TOP_BLOCKS_CAP);
  const limitIdx = params.length;
  const { rows } = await query<{
    location_id: string;
    location_name: string;
    product_count: string;
    below_min_count: string;
    total_qty: string;
  }>(
    `SELECT l.id AS location_id, l.name AS location_name,
            coalesce(agg.product_count, 0)   AS product_count,
            coalesce(agg.below_min_count, 0) AS below_min_count,
            coalesce(agg.total_qty, 0)       AS total_qty
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT product_id) AS product_count,
                count(*) FILTER (WHERE qty <= min_level AND min_level > 0) AS below_min_count,
                coalesce(sum(qty), 0) AS total_qty
           FROM stock s
          WHERE s.location_id = l.id
       ) agg ON TRUE
      WHERE l.id IN ${centralLocs}
      ORDER BY agg.total_qty DESC NULLS LAST, l.id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    product_count: Number(r.product_count),
    below_min_count: Number(r.below_min_count),
    total_qty: Number(r.total_qty),
  }));
}

async function fetchCentralRecentSyncLog(): Promise<
  DashboardCentralDetail['recent_sync_log']
> {
  const { rows } = await query<{
    id: string;
    entity: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
    records_in: number;
    records_applied: number;
    error_detail: string | null;
  }>(
    `SELECT id, entity::text AS entity, status::text AS status,
            started_at, finished_at, records_in, records_applied, error_detail
       FROM poster_sync_log
       ORDER BY started_at DESC, id DESC
       LIMIT ${SYNC_LOG_RECENT}`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    entity: r.entity,
    status: r.status,
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at === null ? null : r.finished_at.toISOString(),
    records_in: Number(r.records_in),
    records_applied: Number(r.records_applied),
    error_detail: r.error_detail,
  }));
}

async function fetchCentralDailySyncRuns(
  range: DateRange,
): Promise<DashboardCentralDetail['daily_sync_runs']> {
  const { rows } = await query<{
    day: Date;
    ok: string;
    partial: string;
    failed: string;
  }>(
    `SELECT date_trunc('day', started_at) AS day,
            count(*) FILTER (WHERE status = 'ok')      AS ok,
            count(*) FILTER (WHERE status = 'partial') AS partial,
            count(*) FILTER (WHERE status = 'failed')  AS failed
       FROM poster_sync_log
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1
      ORDER BY 1
      LIMIT ${DAILY_SERIES_MAX_POINTS}`,
    [range.from, range.to],
  );
  return rows.map((r) => ({
    date: toIsoDate(r.day),
    ok: Number(r.ok),
    partial: Number(r.partial),
    failed: Number(r.failed),
  }));
}

function emptyCentralDetail(): DashboardCentralDetail {
  return {
    kpis: {
      block_count: 0,
      total_sku: 0,
      below_min_count: 0,
      last_sync_at: null,
      last_sync_status: null,
      sync_errors_24h: 0,
    },
    blocks: [],
    recent_sync_log: [],
    daily_sync_runs: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/stores — Do'konlar
// ---------------------------------------------------------------------------

type DashboardStoresDetail = {
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
  hourly_heatmap: Array<{ day_offset: number; hour: number; qty: number }>;
  daily_sales: Array<{ date: string; qty: number; revenue: number }>;
};

dashboardDetailRouter.get(
  '/stores',
  authenticate,
  authorize('pm', 'ai_assistant', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    assertLayerAccess(principal, 'stores');
    const scope = resolveDetailScope(principal);
    const range = parseDateRange(req.query);
    if (scope.kind === 'empty') {
      res.status(200).json(emptyStoresDetail());
      return;
    }

    const [kpis, breakdown, top, heatmap, daily] = await Promise.all([
      fetchStoresKpis(scope),
      fetchStoresBreakdown(scope),
      fetchStoresTopProducts(scope),
      fetchStoresHourlyHeatmap(scope),
      fetchStoresDailySales(scope, range),
    ]);

    const response: DashboardStoresDetail = {
      kpis,
      store_breakdown: breakdown,
      top_products_today: top,
      hourly_heatmap: heatmap,
      daily_sales: daily,
    };
    res.status(200).json(response);
  }),
);

async function fetchStoresKpis(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardStoresDetail['kpis']> {
  const countParams: SqlParam[] = [];
  const storeLocs = locationIdSetForType(scope, 'store', countParams);
  const countQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM locations WHERE id IN ${storeLocs}`,
    countParams,
  );

  // sales (today) — read raw `sales` table; cron only refreshes the daily
  // aggregate at 03:00. Tight window + `ix_sales_store_date` keep it cheap.
  const salesParams: SqlParam[] = [];
  const storeLocsSales = locationIdSetForType(scope, 'store', salesParams);
  const salesQ = query<{
    total_sum: string | null;
    receipts: string;
  }>(
    `SELECT coalesce(sum(qty * price), 0)         AS total_sum,
            count(DISTINCT poster_transaction_id) AS receipts
       FROM sales
      WHERE sold_at >= date_trunc('day', now())
        AND sold_at <  date_trunc('day', now()) + interval '1 day'
        AND store_id IN ${storeLocsSales}`,
    salesParams,
  );

  const [count, sales] = await Promise.all([countQ, salesQ]);
  const sumNum = Number(sales.rows[0]?.total_sum ?? 0);
  const cntNum = Number(sales.rows[0]?.receipts ?? 0);
  return {
    store_count: Number(count.rows[0]?.cnt ?? 0),
    sales_today_sum: sumNum,
    sales_today_count: cntNum,
    avg_receipt_today: cntNum === 0 ? 0 : Number((sumNum / cntNum).toFixed(2)),
  };
}

async function fetchStoresBreakdown(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardStoresDetail['store_breakdown']> {
  // One row per store with today's sales + open replenishment count +
  // below-min stock count. LATERAL sub-queries keep this single-query and
  // the partial `ix_stock_below_min` index makes the below-min branch cheap.
  const params: SqlParam[] = [];
  const storeLocs = locationIdSetForType(scope, 'store', params);
  const { rows } = await query<{
    location_id: string;
    location_name: string;
    sales_sum: string;
    sales_count: string;
    below_min_count: string;
    open_replenishments: string;
  }>(
    `SELECT l.id AS location_id, l.name AS location_name,
            coalesce(sales_agg.sales_sum, 0)    AS sales_sum,
            coalesce(sales_agg.sales_count, 0)  AS sales_count,
            coalesce(stock_agg.below_min_count, 0) AS below_min_count,
            coalesce(repl_agg.open_replenishments, 0) AS open_replenishments
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(qty * price), 0)         AS sales_sum,
                count(DISTINCT poster_transaction_id) AS sales_count
           FROM sales
          WHERE store_id = l.id
            AND sold_at >= date_trunc('day', now())
            AND sold_at <  date_trunc('day', now()) + interval '1 day'
       ) sales_agg ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s
          WHERE s.location_id = l.id
            AND s.qty <= s.min_level
            AND s.min_level > 0
       ) stock_agg ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_replenishments
           FROM replenishment_requests rr
          WHERE rr.requester_location_id = l.id
            AND rr.status NOT IN ('${TERMINAL_REPL_STATUSES.join("','")}')
       ) repl_agg ON TRUE
      WHERE l.id IN ${storeLocs}
      ORDER BY sales_agg.sales_sum DESC NULLS LAST, l.id`,
    params,
  );
  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    sales_sum: Number(r.sales_sum),
    sales_count: Number(r.sales_count),
    below_min_count: Number(r.below_min_count),
    open_replenishments: Number(r.open_replenishments),
  }));
}

async function fetchStoresTopProducts(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardStoresDetail['top_products_today']> {
  const params: SqlParam[] = [];
  const storeLocs = locationIdSetForType(scope, 'store', params);
  params.push(TOP_PRODUCTS_TODAY);
  const limitIdx = params.length;
  const { rows } = await query<{
    product_id: string;
    product_name: string;
    unit: string;
    qty: string;
    revenue: string;
  }>(
    `SELECT s.product_id, p.name AS product_name, p.unit::text AS unit,
            sum(s.qty)        AS qty,
            sum(s.qty * s.price) AS revenue
       FROM sales s
       JOIN products p ON p.id = s.product_id
      WHERE s.sold_at >= date_trunc('day', now())
        AND s.sold_at <  date_trunc('day', now()) + interval '1 day'
        AND s.store_id IN ${storeLocs}
      GROUP BY s.product_id, p.name, p.unit
      ORDER BY sum(s.qty * s.price) DESC, s.product_id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows.map((r) => ({
    product_id: Number(r.product_id),
    product_name: r.product_name,
    unit: r.unit,
    qty: Number(r.qty),
    revenue: Number(r.revenue),
  }));
}

async function fetchStoresHourlyHeatmap(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
): Promise<DashboardStoresDetail['hourly_heatmap']> {
  // 7 days x 24 hours. Aggregate in SQL by `(today_offset, hour_of_day)` so
  // the client receives at most 168 rows.
  const params: SqlParam[] = [];
  const storeLocs = locationIdSetForType(scope, 'store', params);
  const { rows } = await query<{
    day_offset: number;
    hour: number;
    qty: string;
  }>(
    `SELECT (CURRENT_DATE - (sold_at AT TIME ZONE 'UTC')::date)::int AS day_offset,
            extract(hour FROM sold_at AT TIME ZONE 'UTC')::int       AS hour,
            sum(qty) AS qty
       FROM sales
      WHERE sold_at >= date_trunc('day', now()) - interval '6 days'
        AND sold_at <  date_trunc('day', now()) + interval '1 day'
        AND store_id IN ${storeLocs}
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    params,
  );
  return rows.map((r) => ({
    day_offset: Number(r.day_offset),
    hour: Number(r.hour),
    qty: Number(r.qty),
  }));
}

async function fetchStoresDailySales(
  scope: Exclude<DetailScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<DashboardStoresDetail['daily_sales']> {
  // Use `sales_stats_daily` for `qty` (already aggregated); join `sales` for
  // revenue only when the user picks a range short enough that the raw
  // table is cheap. For simplicity we always derive revenue from `sales`
  // (the dashboard range presets cap at 6 months — `ix_sales_store_date`
  // keeps it tractable).
  const fromDate = toIsoDate(range.from);
  const toInclusive = new Date(range.to.getTime() - 1);
  const toDate = toIsoDate(toInclusive);

  const dailyParams: SqlParam[] = [fromDate, toDate];
  let aggWhere = `WHERE stat_date >= $1::date AND stat_date <= $2::date`;
  if (scope.kind === 'locations') {
    dailyParams.push(scope.locationIds);
    aggWhere += ` AND location_id = ANY($${dailyParams.length}::bigint[])`;
  }
  const dailyAggQ = query<{ stat_date: Date; qty: string }>(
    `SELECT stat_date, sum(qty_sold) AS qty
       FROM sales_stats_daily
       ${aggWhere}
       GROUP BY stat_date
       ORDER BY stat_date`,
    dailyParams,
  );

  // Revenue per day from raw `sales`.
  const revParams: SqlParam[] = [];
  const storeLocs = locationIdSetForType(scope, 'store', revParams);
  revParams.push(range.from);
  const fromIdx = revParams.length;
  revParams.push(range.to);
  const toIdx = revParams.length;
  const revQ = query<{ day: Date; revenue: string }>(
    `SELECT date_trunc('day', sold_at) AS day,
            sum(qty * price) AS revenue
       FROM sales
      WHERE sold_at >= $${fromIdx}
        AND sold_at <  $${toIdx}
        AND store_id IN ${storeLocs}
      GROUP BY 1
      ORDER BY 1
      LIMIT ${DAILY_SERIES_MAX_POINTS}`,
    revParams,
  );

  const [agg, rev] = await Promise.all([dailyAggQ, revQ]);

  const revByDate = new Map<string, number>();
  for (const r of rev.rows) revByDate.set(toIsoDate(r.day), Number(r.revenue));

  // Union of dates from both result sets (qty from aggregate, revenue from raw).
  const dateSet = new Set<string>();
  for (const r of agg.rows) dateSet.add(toIsoDate(r.stat_date));
  for (const d of revByDate.keys()) dateSet.add(d);
  const dates = [...dateSet].sort();

  const qtyByDate = new Map<string, number>();
  for (const r of agg.rows) qtyByDate.set(toIsoDate(r.stat_date), Number(r.qty));

  return dates.map((date) => ({
    date,
    qty: qtyByDate.get(date) ?? 0,
    revenue: revByDate.get(date) ?? 0,
  }));
}

function emptyStoresDetail(): DashboardStoresDetail {
  return {
    kpis: {
      store_count: 0,
      sales_today_sum: 0,
      sales_today_count: 0,
      avg_receipt_today: 0,
    },
    store_breakdown: [],
    top_products_today: [],
    hourly_heatmap: [],
    daily_sales: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/suppliers — Yetkazib beruvchilar (PM / ai_assistant only)
// ---------------------------------------------------------------------------
//
// Used by `EcosystemCanvas` to draw the upstream "Yetkazib beruvchilar" node
// cluster (left of the raw warehouse). Returns the top-5 most active
// suppliers, ranked by the number of `purchase_orders` created within the
// `?range` window. RBAC: chain-wide — PM and `ai_assistant` only; every other
// role (including layer managers) → 403, because suppliers are an
// organisation-wide concern.

/** Top 5 — matches the visual node count of the canvas cluster. */
const TOP_SUPPLIERS = 5;

type SupplierStatus = 'ok' | 'warn' | 'danger';

type DashboardSuppliersResponse = {
  suppliers: Array<{
    supplier_id: number | null;
    supplier_name: string;
    pending_pos: number;
    total_pos: number;
    received_qty: number;
    expected_qty: number;
    status: SupplierStatus;
  }>;
};

/** Pending-PO → traffic-light. 0 = ok, 1-2 = warn, 3+ = danger. */
function supplierStatus(pendingPos: number): SupplierStatus {
  if (pendingPos === 0) return 'ok';
  if (pendingPos <= 2) return 'warn';
  return 'danger';
}

dashboardDetailRouter.get(
  '/suppliers',
  authenticate,
  authorize('pm', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    // `authorize` already enforces PM / ai_assistant. No layer scope here —
    // suppliers sit outside the per-location chain (they are organisation
    // partners, not warehouse rows).
    const range = parseDateRange(req.query);

    const { rows } = await query<{
      supplier_id: string | null;
      supplier_name: string;
      pending_pos: string;
      total_pos: string;
      received_qty: string;
      expected_qty: string;
    }>(
      `SELECT
         po.supplier_id,
         COALESCE(
           s.name,
           'Yetkazib beruvchi #' || po.supplier_id::text,
           'Noma''lum yetkazib beruvchi'
         ) AS supplier_name,
         COUNT(*) FILTER (
           WHERE po.status = 'approved' AND po.received_movement_id IS NULL
         ) AS pending_pos,
         COUNT(*) AS total_pos,
         COALESCE(SUM(
           CASE WHEN po.received_movement_id IS NOT NULL THEN po.qty ELSE 0 END
         ), 0) AS received_qty,
         COALESCE(SUM(
           CASE WHEN po.received_movement_id IS NULL THEN po.qty ELSE 0 END
         ), 0) AS expected_qty
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.created_at >= $1
         AND po.created_at <  $2
       GROUP BY po.supplier_id, s.name
       ORDER BY COUNT(*) DESC, po.supplier_id NULLS LAST
       LIMIT ${TOP_SUPPLIERS}`,
      [range.from, range.to],
    );

    const response: DashboardSuppliersResponse = {
      suppliers: rows.map((r) => {
        const pendingPos = Number(r.pending_pos);
        return {
          supplier_id: r.supplier_id === null ? null : Number(r.supplier_id),
          supplier_name: r.supplier_name,
          pending_pos: pendingPos,
          total_pos: Number(r.total_pos),
          received_qty: Number(r.received_qty),
          expected_qty: Number(r.expected_qty),
          status: supplierStatus(pendingPos),
        };
      }),
    };
    res.status(200).json(response);
  }),
);
