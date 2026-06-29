/**
 * M8 — Dashboard overview (spec section 4.8).
 *
 *   GET /api/dashboard/overview
 *
 * One read-only endpoint that returns the whole-chain (or location-scoped)
 * snapshot the operator sees: below-min stock rows, open replenishment
 * requests aggregated by status, the production plan for today (plus
 * overdue), the most recent stock movements, and a small KPI block.
 *
 * Performance contract (AC8.1 — TZ section 13): the endpoint must answer
 * in < 1 s. Each sub-query is bounded (LIMIT 20 on movements, status-keyed
 * aggregates), backed by existing indexes (`ix_stock_below_min`,
 * `ix_replenishment_status`, `ix_movements_created`), and the five queries
 * are issued in parallel via `Promise.all`.
 *
 * RBAC (spec section 6, dashboard row):
 *   - `pm` and `ai_assistant` see the entire chain.
 *   - every other role is locked to its own `location_id`. A scoped
 *     principal with `locationId === null` sees an empty snapshot (the
 *     guard mirrors `GET /api/stock`).
 *
 * Read-only — no audit-log writes (per spec).
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseDateRange, toPosterDate, type DateRange } from '../lib/dateRange.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import type { Role } from '../auth/roles.js';

export const dashboardRouter: Router = Router();

/** How many of the most-recent stock movements the overview returns. */
const RECENT_MOVEMENTS_LIMIT = 20;

/** Open replenishment statuses (terminal ones never appear in `by_status`). */
const OPEN_REPL_STATUSES = ['CLOSED', 'CANCELLED'] as const;

/** Active production order statuses (KPI + plan). */
const ACTIVE_PO_STATUSES = ['new', 'in_progress'] as const;

// ---------------------------------------------------------------------------
// Row types (raw shapes returned by pg — numerics arrive as strings)
// ---------------------------------------------------------------------------

type BelowMinRaw = {
  location_id: string;
  location_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  min_level: string;
  max_level: string;
  open_request_id: string | null;
  open_request_status: string | null;
};

type StatusCountRaw = { status: string; cnt: string };

type ProductionPlanRaw = {
  id: string;
  product_id: string;
  product_name: string;
  qty: string;
  status: 'new' | 'in_progress' | 'done' | 'cancelled';
  location_id: string;
  location_name: string;
  target_location_id: string | null;
  target_location_name: string | null;
  deadline: Date | null;
};

type RecentMovementRaw = {
  id: string;
  created_at: Date;
  product_id: string;
  product_name: string;
  product_unit: string;
  from_location_id: string | null;
  from_location_name: string | null;
  to_location_id: string | null;
  to_location_name: string | null;
  qty: string;
  reason: string;
};

type SimpleCountRaw = { cnt: string };
type OldestOpenRaw = { oldest: Date | null };

// ---------------------------------------------------------------------------
// Response types (JSON-clean: numbers/strings, no Date or BigInt)
// ---------------------------------------------------------------------------

type BelowMinItem = {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  min_level: number;
  max_level: number;
  open_request_id: number | null;
  open_request_status: string | null;
};

type ProductionPlanItem = {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  status: 'new' | 'in_progress' | 'done' | 'cancelled';
  location_id: number;
  location_name: string;
  target_location_id: number | null;
  target_location_name: string | null;
  deadline: string | null;
};

type RecentMovementItem = {
  id: number;
  created_at: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  qty: number;
  reason: string;
};

type OverviewResponse = {
  below_min: BelowMinItem[];
  open_requests: {
    by_status: Record<string, number>;
    total: number;
    oldest_created_at: string | null;
  };
  production_plan: ProductionPlanItem[];
  recent_movements: RecentMovementItem[];
  kpis: {
    total_open_requests: number;
    below_min_count: number;
    active_production_orders: number;
    pending_approvals: number;
  };
};

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

dashboardRouter.get(
  '/overview',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveScope(principal);

    // F4.9 — `?range` narrows time-bound aggregates (recent_movements here;
    // below_min/open_requests/production_plan/KPIs are "current state" and
    // intentionally ignore range).
    const range = parseDateRange(req.query);

    // A location-scoped principal whose JWT has `locationId=null` sees
    // nothing — mirror the `GET /api/stock` behaviour for consistency.
    if (scope.kind === 'empty') {
      res.status(200).json(emptyOverview());
      return;
    }

    // All five queries are independent reads — fire them in parallel.
    const [belowMin, openByStatus, prodPlan, movements, kpiRow] = await Promise.all([
      fetchBelowMin(scope),
      fetchOpenRequestsByStatus(scope),
      fetchProductionPlan(scope),
      fetchRecentMovements(scope, range),
      fetchKpiExtras(scope, principal),
    ]);

    const byStatus: Record<string, number> = {};
    let openTotal = 0;
    for (const row of openByStatus.counts) {
      const n = Number(row.cnt);
      byStatus[row.status] = n;
      openTotal += n;
    }

    const response: OverviewResponse = {
      below_min: belowMin.map(mapBelowMin),
      open_requests: {
        by_status: byStatus,
        total: openTotal,
        oldest_created_at:
          openByStatus.oldest === null ? null : openByStatus.oldest.toISOString(),
      },
      production_plan: prodPlan.map(mapProductionPlan),
      recent_movements: movements.map(mapMovement),
      kpis: {
        total_open_requests: openTotal,
        below_min_count: belowMin.length,
        active_production_orders: Number(kpiRow.activeProduction),
        pending_approvals: Number(kpiRow.pendingApprovals),
      },
    };
    res.status(200).json(response);
  }),
);

// ---------------------------------------------------------------------------
// Scope resolution — translates RBAC into a SQL filter
// ---------------------------------------------------------------------------

type Scope =
  | { kind: 'chain' } // pm / ai_assistant — whole supply chain
  | { kind: 'location'; locationId: number } // scoped manager
  | { kind: 'empty' }; // scoped principal with no location

function resolveScope(principal: AuthPrincipal): Scope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  if (principal.locationId === null) {
    return { kind: 'empty' };
  }
  return { kind: 'location', locationId: principal.locationId };
}

// ---------------------------------------------------------------------------
// Sub-queries
// ---------------------------------------------------------------------------

/**
 * Below-min stock with an embedded open replenishment_request id (if any).
 * The partial index `ix_stock_below_min` makes the `qty <= min_level` scan
 * O(matches). The LATERAL join picks at most one open request per
 * (product, location) — invariant 2 guarantees there is at most one.
 *
 * The `min_level > 0 AND max_level > 0` guard mirrors the replenishment scan
 * rule (`services/replenishment.ts`: `qty <= min_level AND max_level > 0`): a
 * product with no configured threshold (e.g. a Poster-synced row at
 * min/max = 0) has no reorder point and must NOT count as below-min/critical.
 * This is the SINGLE source the M8 `below_min` array AND the `below_min_count`
 * KPI both derive from, so the dashboard's critical count is internally
 * consistent.
 */
async function fetchBelowMin(scope: Exclude<Scope, { kind: 'empty' }>): Promise<BelowMinRaw[]> {
  const params: SqlParam[] = [];
  let where = 'WHERE s.qty <= s.min_level AND s.min_level > 0 AND s.max_level > 0';
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    where += ` AND s.location_id = $${params.length}`;
  }
  const { rows } = await query<BelowMinRaw>(
    `SELECT s.location_id, l.name AS location_name,
            s.product_id, p.name AS product_name, p.unit AS product_unit,
            s.qty, s.min_level, s.max_level,
            r.id     AS open_request_id,
            r.status::text AS open_request_status
     FROM stock s
     JOIN products  p ON p.id = s.product_id
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN LATERAL (
       SELECT rr.id, rr.status
       FROM replenishment_requests rr
       WHERE rr.product_id = s.product_id
         AND rr.requester_location_id = s.location_id
         AND rr.status NOT IN ('CLOSED','CANCELLED')
       LIMIT 1
     ) r ON TRUE
     ${where}
     ORDER BY s.location_id, s.product_id`,
    params,
  );
  return rows;
}

/**
 * Open replenishment requests grouped by status, plus the oldest one's
 * `created_at`. Terminal statuses are excluded.
 */
async function fetchOpenRequestsByStatus(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<{ counts: StatusCountRaw[]; oldest: Date | null }> {
  const params: SqlParam[] = [];
  const conditions: string[] = [
    `status NOT IN ('${OPEN_REPL_STATUSES.join("','")}')`,
  ];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    // The location appears as either requester or target — both touch it.
    conditions.push(
      `(requester_location_id = $${params.length} OR target_location_id = $${params.length})`,
    );
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [byStatus, oldest] = await Promise.all([
    query<StatusCountRaw>(
      `SELECT status::text AS status, count(*) AS cnt
       FROM replenishment_requests
       ${where}
       GROUP BY status`,
      params,
    ),
    query<OldestOpenRaw>(
      `SELECT min(created_at) AS oldest
       FROM replenishment_requests
       ${where}`,
      params,
    ),
  ]);
  return { counts: byStatus.rows, oldest: oldest.rows[0]?.oldest ?? null };
}

/**
 * Today's production plan + any overdue order. Cancelled and done orders
 * are excluded; a row with no deadline still counts as "today" so the
 * production manager sees it.
 */
async function fetchProductionPlan(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<ProductionPlanRaw[]> {
  const params: SqlParam[] = [];
  const conditions: string[] = [
    `po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')`,
    `(po.deadline IS NULL OR po.deadline <= CURRENT_DATE)`,
  ];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    // A production order touches the scope when produced AT or shipped TO
    // the principal's location.
    conditions.push(
      `(po.location_id = $${params.length} OR po.target_location_id = $${params.length})`,
    );
  }
  const { rows } = await query<ProductionPlanRaw>(
    `SELECT po.id, po.product_id, p.name AS product_name, po.qty, po.status,
            po.location_id, l.name AS location_name,
            po.target_location_id, tl.name AS target_location_name,
            po.deadline
     FROM production_orders po
     JOIN products  p  ON p.id = po.product_id
     JOIN locations l  ON l.id = po.location_id
     LEFT JOIN locations tl ON tl.id = po.target_location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY po.deadline NULLS LAST, po.id`,
    params,
  );
  return rows;
}

/**
 * The most-recent stock movements. The `ix_movements_created` index keeps
 * this cheap even on a large ledger. For a scoped principal the filter is
 * `from OR to = scope.locationId`.
 */
async function fetchRecentMovements(
  scope: Exclude<Scope, { kind: 'empty' }>,
  range: DateRange,
): Promise<RecentMovementRaw[]> {
  const params: SqlParam[] = [];
  const conditions: string[] = [];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    conditions.push(
      `(m.from_location_id = $${params.length} OR m.to_location_id = $${params.length})`,
    );
  }
  // F4.9 — clip to the requested range. Half-open: [from, to).
  params.push(range.from);
  conditions.push(`m.created_at >= $${params.length}`);
  params.push(range.to);
  conditions.push(`m.created_at < $${params.length}`);
  const where = `WHERE ${conditions.join(' AND ')}`;
  params.push(RECENT_MOVEMENTS_LIMIT);
  const limitIdx = params.length;
  const { rows } = await query<RecentMovementRaw>(
    `SELECT m.id, m.created_at,
            m.product_id, p.name AS product_name, p.unit AS product_unit,
            m.from_location_id, fl.name AS from_location_name,
            m.to_location_id,   tl.name AS to_location_name,
            m.qty, m.reason::text AS reason
     FROM stock_movements m
     JOIN products p   ON p.id  = m.product_id
     LEFT JOIN locations fl ON fl.id = m.from_location_id
     LEFT JOIN locations tl ON tl.id = m.to_location_id
     ${where}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${limitIdx}`,
    params,
  );
  return rows;
}

/**
 * The extra KPIs not already captured by other queries: active production
 * orders and purchase orders awaiting either approval step.
 *
 * `pending_approvals` is role-aware (C6 — Sprint 3 audit) — see
 * `pendingApprovalsClause` below. The two queries fan out in parallel.
 */
async function fetchKpiExtras(
  scope: Exclude<Scope, { kind: 'empty' }>,
  principal: AuthPrincipal,
): Promise<{ activeProduction: string; pendingApprovals: string }> {
  // Active production orders — same scope rule as production_plan.
  const prodParams: SqlParam[] = [];
  let prodWhere = `WHERE status IN ('${ACTIVE_PO_STATUSES.join("','")}')`;
  if (scope.kind === 'location') {
    prodParams.push(scope.locationId);
    prodWhere += ` AND (location_id = $${prodParams.length} OR target_location_id = $${prodParams.length})`;
  }

  const { sql: poSql, params: poParams } = pendingApprovalsClause(principal);

  const [prodRes, poRes] = await Promise.all([
    query<SimpleCountRaw>(
      `SELECT count(*) AS cnt FROM production_orders ${prodWhere}`,
      prodParams,
    ),
    query<SimpleCountRaw>(`SELECT count(*) AS cnt FROM purchase_orders ${poSql}`, poParams),
  ]);
  return {
    activeProduction: prodRes.rows[0]?.cnt ?? '0',
    pendingApprovals: poRes.rows[0]?.cnt ?? '0',
  };
}

/**
 * Build the `pending_approvals` WHERE clause and its bind params, role-aware.
 *
 * Spec D5 + section 4.5: a purchase_order is `draft` until both the supply
 * manager (step 1) and the raw-warehouse keeper (step 2) approve it. The
 * dashboard widget says "approvals waiting for YOU".
 *
 *   pm / ai_assistant / central_warehouse_manager:
 *     full chain — every draft missing at least one approval.
 *   raw_warehouse_manager:
 *     drafts targeting their warehouse (the only PO field that ties to a
 *     location), missing at least one approval. They are the keeper-step
 *     approver.
 *   supply_manager:
 *     supply_manager's `users.location_id` is the supply hub, not the raw
 *     warehouse. They cannot be filtered by `target_location_id`. They are
 *     the chain's draft-approvers (step 1) — show every draft still missing
 *     manager approval. Chain-wide visibility is by design.
 *   store_manager / production_manager:
 *     no role in the approval chain — show 0.
 */
function pendingApprovalsClause(
  principal: AuthPrincipal,
): { sql: string; params: SqlParam[] } {
  const role = principal.role;
  const draftOpen =
    `status = 'draft' AND (manager_approved_by IS NULL OR keeper_approved_by IS NULL)`;

  if (role === 'pm' || role === 'ai_assistant' || role === 'central_warehouse_manager') {
    return { sql: `WHERE ${draftOpen}`, params: [] };
  }
  if (role === 'raw_warehouse_manager') {
    if (principal.locationId === null) {
      return { sql: `WHERE 1 = 0`, params: [] };
    }
    return {
      sql: `WHERE ${draftOpen} AND target_location_id = $1`,
      params: [principal.locationId],
    };
  }
  if (role === 'supply_manager') {
    // C6 — show every draft still awaiting manager approval. A supply_manager
    // is the chain-wide draft-approver and their `location_id` is the supply
    // hub, not the raw warehouse a PO targets.
    return {
      sql: `WHERE ${draftOpen} AND manager_approved_by IS NULL`,
      params: [],
    };
  }
  // store_manager, production_manager — no role in PO approval chain.
  return { sql: `WHERE 1 = 0`, params: [] };
}

// ---------------------------------------------------------------------------
// Row -> response mappers (coerce BIGINT/NUMERIC strings into numbers and
// Dates into ISO strings, so the JSON shape matches the spec).
// ---------------------------------------------------------------------------

function mapBelowMin(r: BelowMinRaw): BelowMinItem {
  return {
    location_id: Number(r.location_id),
    location_name: r.location_name,
    product_id: Number(r.product_id),
    product_name: r.product_name,
    product_unit: r.product_unit,
    qty: Number(r.qty),
    min_level: Number(r.min_level),
    max_level: Number(r.max_level),
    open_request_id: r.open_request_id === null ? null : Number(r.open_request_id),
    open_request_status: r.open_request_status,
  };
}

function mapProductionPlan(r: ProductionPlanRaw): ProductionPlanItem {
  return {
    id: Number(r.id),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    qty: Number(r.qty),
    status: r.status,
    location_id: Number(r.location_id),
    location_name: r.location_name,
    target_location_id: r.target_location_id === null ? null : Number(r.target_location_id),
    target_location_name: r.target_location_name,
    deadline: r.deadline === null ? null : toIsoDate(r.deadline),
  };
}

function mapMovement(r: RecentMovementRaw): RecentMovementItem {
  return {
    id: Number(r.id),
    created_at: r.created_at.toISOString(),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    product_unit: r.product_unit,
    from_location_id: r.from_location_id === null ? null : Number(r.from_location_id),
    from_location_name: r.from_location_name,
    to_location_id: r.to_location_id === null ? null : Number(r.to_location_id),
    to_location_name: r.to_location_name,
    qty: Number(r.qty),
    reason: r.reason,
  };
}

/** Format a DATE column (`production_orders.deadline`) as `YYYY-MM-DD`. */
function toIsoDate(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

function emptyOverview(): OverviewResponse {
  return {
    below_min: [],
    open_requests: { by_status: {}, total: 0, oldest_created_at: null },
    production_plan: [],
    recent_movements: [],
    kpis: {
      total_open_requests: 0,
      below_min_count: 0,
      active_production_orders: 0,
      pending_approvals: 0,
    },
  };
}

// =============================================================================
// F4.4 — GET /api/dashboard/ecosystem
// =============================================================================
//
// One payload, four blocks:
//   - poster_status: last sync run + 24h failure count + today's sales pulse
//   - chain_flow:    every location with below-min / open-request counts,
//                    ordered by type so the UI can render the supply chain
//                    left-to-right (raw -> production -> supply -> central
//                    -> store).
//   - alerts_feed:   the latest 20 notifications with a derived severity.
//   - sales_chart:   the last 30 days of daily sales (per scoped location set).
//
// RBAC mirrors M8 dashboard/overview — every authenticated business role can
// hit the endpoint; non-chain roles are scoped to their assigned locations
// (M:N — F4.1 / ADR-0012) for `chain_flow`, `sales_chart`, and the
// `sales_today_*` fields of `poster_status`. `poster_status` headline metrics
// (last sync, sync_errors_24h) are intentionally chain-wide — Poster sync is
// a backend-wide event, not a per-location one.
//
// AC4.4.6 — endpoint P95 < 1000ms. Four queries fan out in parallel via
// Promise.all; each one is bounded (sales_chart 30 rows, alerts_feed 20).
// -----------------------------------------------------------------------------

const ALERTS_FEED_LIMIT = 20;

type EcosystemScope =
  | { kind: 'chain' } // pm / ai_assistant — every location.
  | { kind: 'locations'; locationIds: number[] } // scoped principal.
  | { kind: 'empty' }; // scoped principal with no assigned locations.

type PosterStatusBlock = {
  last_sync_at: string | null;
  last_sync_status: 'ok' | 'partial' | 'failed' | null;
  sync_errors_24h: number;
  sales_today_count: number;
  sales_today_sum: number;
};

type ChainFlowItem = {
  location_id: number;
  location_name: string;
  location_type: string;
  below_min_count: number;
  open_requests_count: number;
  total_products: number;
  /**
   * Production-only KPI: count of `production_orders` at this location in
   * `new` or `in_progress` status. `null` for non-production locations so
   * the frontend can branch on type without an extra lookup.
   */
  active_production_orders: number | null;
  /**
   * Production-only KPI: count of `production_orders` at this location
   * completed (`status='done'`, `done_at` falls on the current date).
   * `null` for non-production locations.
   */
  done_today_count: number | null;
};

// ---------------------------------------------------------------------------
// F4.4 / Dashboard MEGA Redesign Sprint B — `chain_summary`
// ---------------------------------------------------------------------------
//
// One row PER LOCATION TYPE (not per location). The `ChainFlowRow` UI renders
// exactly 5 cards — one per supply-chain stage — and needs aggregate counts
// across every location of that type plus a type-specific "pulse" metric for
// today. `chain_flow` (row per location) stays untouched for the existing
// `EcosystemHealthBar` consumer and the M8 overview screen.
//
// Status thresholds (plan §10, owner-approved):
//   below_min == 0     -> ok
//   below_min in 1..3  -> warn
//   below_min >= 4     -> danger
//
// The pulse shape is a discriminated union keyed by `type` so the frontend
// can render per-stage micro-content (today inflow/outflow for raw, active
// orders for production, etc.). Each pulse field is a number for the UI to
// format with units — never a pre-formatted string (i18n + dark theme tone).
// ---------------------------------------------------------------------------

const CHAIN_TYPES = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;
type ChainType = (typeof CHAIN_TYPES)[number];

type ChainStatus = 'ok' | 'warn' | 'danger';

/**
 * Per-stage pulse — today's activity highlight.
 *
 * Sprint C+ — every variant carries the original Sprint-B fields PLUS the
 * "expanded" KPIs the new `ChainCard` wants to render (4 → 6 stats per stage,
 * 10 for the store). New fields are additive — existing consumers stay
 * unchanged. Field naming is snake_case to match the rest of the API.
 */
type ChainPulse =
  | {
      kind: 'raw';
      // Sprint B
      received_today: number;
      issued_today: number;
      // Sprint C
      /** Open `purchase_orders` whose target is a raw warehouse. */
      pending_purchase_orders: number;
      /**
       * Total qty held at raw warehouses, grouped by `products.unit`. The
       * eskiz wants "ombor sig'imi" broken down per unit so kg / l / pcs
       * are never collapsed into a meaningless scalar.
       */
      total_qty_by_unit: Array<{ unit: string; qty: number }>;
    }
  | {
      kind: 'production';
      // Sprint B
      active_orders: number;
      done_today: number;
      // Sprint C
      /** Production orders whose `deadline < CURRENT_DATE` and still open. */
      overdue_orders: number;
      /** Active `production` locations (sex_count). */
      sex_count: number;
      /** Today's `production_input` (raw consumed by sexes). */
      input_today: number;
      /** Today's `production_output` (qty produced by sexes). */
      output_today: number;
    }
  | {
      kind: 'supply';
      // Sprint B
      shipped_today: number;
      received_today: number;
      // Sprint C
      /** Open replenishment requests routed through a supply location. */
      open_requests: number;
      /** Distinct destinations a supply location served today. */
      top_destination_count: number;
    }
  | {
      kind: 'central';
      // Sprint B
      last_sync_at: string | null;
      last_sync_status: 'ok' | 'partial' | 'failed' | null;
      // Sprint C
      /** Failed poster_sync_log rows in the last 24h. */
      sync_errors_24h: number;
    }
  | {
      kind: 'store';
      // Sprint B
      sales_today_sum: number;
      receipts_today: number;
      // Sprint C
      /** sales_today_sum / receipts_today (0 if no receipts). */
      avg_receipt_today: number;
      /** Open replenishment requests originating from a store. */
      open_replenishments: number;
      /** Transfer movements arriving at a store in the last 24h with a */
      /** replenishment link (i.e. recent transit deliveries).          */
      transit_count: number;
      /** Best-selling product name today (across the principal's stores). */
      top_product_name: string | null;
      /** Total qty (units) sold today across the principal's stores. */
      qty_today: number;
    };

type ChainSummaryNode = {
  type: ChainType;
  location_count: number;
  total_products: number;
  below_min_count: number;
  status: ChainStatus;
  pulse: ChainPulse;
};

type AlertSeverity = 'info' | 'warning' | 'danger';

type AlertsFeedItem = {
  id: number;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  location_id: number | null;
  created_at: string;
};

type SalesChartItem = {
  date: string; // YYYY-MM-DD
  qty: number;
};

/**
 * D-0026 (2026-05-28) — explicit M:N supply-chain edge, sourced from the
 * `location_flows` junction table. Until 0026 the canvas inferred edges
 * from `locations.parent_id` (a 1:N tree) which could not express the
 * Tort sexi → {Tort skladi, Yarim Fabrika skladi} fan-out or the BOM
 * re-entry loop from Yarim Fabrika skladi back into the sexes.
 *
 * `flow_type` is one of:
 *   production_output — sex → its sklad (or shared Yarim Fabrika sklad).
 *   bom_input         — Yarim Fabrika sklad → sex (semi-finished re-use).
 *   forward           — sex_storage → markaziy sklad (and onward).
 *   reverse           — markaziy → upstream (returns / claw-backs).
 */
type ChainEdge = {
  from: number;
  to: number;
  type: 'production_output' | 'bom_input' | 'forward' | 'reverse';
};

type EcosystemResponse = {
  poster_status: PosterStatusBlock;
  chain_flow: ChainFlowItem[];
  /**
   * Sprint B — one entry per supply-chain stage visible to the principal.
   * PM / ai_assistant see all 5 stages; a scoped manager sees only the
   * stages that intersect their assigned locations (typically one).
   */
  chain_summary: ChainSummaryNode[];
  /**
   * D-0026 — explicit M:N edges between supply-chain locations. Backed
   * by the `location_flows` table (migration 0026). Scoped principals
   * see only edges whose `from` OR `to` is in their assigned set.
   */
  chain_edges: ChainEdge[];
  alerts_feed: AlertsFeedItem[];
  sales_chart: { days: SalesChartItem[] };
};

dashboardRouter.get(
  '/ecosystem',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveEcosystemScope(principal);

    // F4.9 — `?range` shrinks the sales aggregates and chart window. The
    // chain_flow + alerts_feed are state snapshots and intentionally
    // ignore range.
    const range = parseDateRange(req.query);

    if (scope.kind === 'empty') {
      res.status(200).json(emptyEcosystem());
      return;
    }

    const [
      posterStatus,
      chainFlow,
      chainSummary,
      chainEdges,
      alertsFeed,
      salesChart,
    ] = await Promise.all([
      fetchPosterStatus(scope, range),
      fetchChainFlow(scope),
      fetchChainSummary(scope),
      fetchChainEdges(scope),
      fetchAlertsFeed(principal),
      fetchSalesChart(scope, range),
    ]);

    const response: EcosystemResponse = {
      poster_status: posterStatus,
      chain_flow: chainFlow,
      chain_summary: chainSummary,
      chain_edges: chainEdges,
      alerts_feed: alertsFeed,
      sales_chart: { days: salesChart },
    };
    res.status(200).json(response);
  }),
);

function resolveEcosystemScope(principal: AuthPrincipal): EcosystemScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  // M:N — every assigned location. Empty array -> empty payload.
  if (principal.locationIds.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'locations', locationIds: principal.locationIds };
}

/**
 * Alerts-feed visibility — broader than `resolveEcosystemScope` because the
 * central warehouse manager is the operational hub of the chain and needs
 * the chain-wide alert stream even though their stock/sales views are
 * location-scoped. Mirrors `pendingApprovalsClause` (D5).
 */
function isAlertsChainWide(principal: AuthPrincipal): boolean {
  return (
    isSuperAdmin(principal) ||
    principal.role === 'ai_assistant' ||
    principal.role === 'central_warehouse_manager'
  );
}

/**
 * Poster status block.
 *   - last_sync_*  : the most recent `poster_sync_log` row (any entity).
 *   - sync_errors_24h: count of `failed` rows in the last 24h.
 *   - sales_today_* : today's `sales` rows; for a scoped principal, filtered
 *     to their assigned stores. Stock movements/sync are chain-wide.
 */
async function fetchPosterStatus(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<PosterStatusBlock> {
  const salesParams: SqlParam[] = [range.from, range.to];
  let salesWhere = 'WHERE sold_at >= $1 AND sold_at < $2';
  if (scope.kind === 'locations') {
    salesParams.push(scope.locationIds);
    salesWhere += ` AND store_id = ANY($${salesParams.length}::bigint[])`;
  }

  const [lastSync, errors24h, salesToday] = await Promise.all([
    query<{ finished_at: Date | null; started_at: Date; status: 'ok' | 'partial' | 'failed' }>(
      // Order by `started_at` (NOT by id) — id reflects insert order, which
      // is fine for the common case, but back-fills or replayed rows could
      // arrive out of chronological order. The "last sync" the dashboard
      // should show is the most recent one in real time.
      `SELECT finished_at, started_at, status::text AS status
         FROM poster_sync_log
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
    ),
    query<{ cnt: string }>(
      `SELECT count(*) AS cnt
         FROM poster_sync_log
         WHERE status = 'failed'
           AND started_at > now() - interval '24 hours'`,
    ),
    query<{ cnt: string; total: string | null }>(
      // `total` is REVENUE (so'm), not a unit count — multiply qty by price.
      // The earlier `sum(qty)` rendered "OYLIK TUSHUM" as a piece/kg count,
      // which the UI labelled as currency. QA Prove-It pinned this regression.
      `SELECT count(*) AS cnt, coalesce(sum(qty * price),0) AS total
         FROM sales
         ${salesWhere}`,
      salesParams,
    ),
  ]);

  const lastRow = lastSync.rows[0];
  const lastWhen = lastRow?.finished_at ?? lastRow?.started_at ?? null;

  return {
    last_sync_at: lastWhen === null ? null : lastWhen.toISOString(),
    last_sync_status: lastRow?.status ?? null,
    sync_errors_24h: Number(errors24h.rows[0]?.cnt ?? 0),
    sales_today_count: Number(salesToday.rows[0]?.cnt ?? 0),
    sales_today_sum: Number(salesToday.rows[0]?.total ?? 0),
  };
}

/**
 * One row per location. `below_min_count` and `open_requests_count` are
 * computed in SQL with LEFT JOIN sub-aggregates — keeps the result one
 * query, scales linearly with location count (small — single digits in MVP).
 *
 * Ordering: type rank (raw -> production -> supply -> central -> store),
 * then by id for a stable left-to-right render.
 */
async function fetchChainFlow(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainFlowItem[]> {
  const params: SqlParam[] = [];
  let where = 'WHERE l.is_active = TRUE';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND l.id = ANY($${params.length}::bigint[])`;
  }

  const { rows } = await query<{
    location_id: string;
    location_name: string;
    location_type: string;
    below_min_count: string;
    open_requests_count: string;
    total_products: string;
    active_production_orders: string | null;
    done_today_count: string | null;
  }>(
    // The production sub-aggregates run via correlated LATERAL joins gated by
    // `l.type = 'production'` so they are short-circuited for every other
    // chain stage — keeps the existing query plan (raw/supply/central/store)
    // unchanged while adding sex-only KPIs.
    `SELECT l.id              AS location_id,
            l.name            AS location_name,
            l.type::text      AS location_type,
            coalesce(bm.below_min_count, 0)   AS below_min_count,
            coalesce(orq.open_requests_count, 0) AS open_requests_count,
            coalesce(tp.total_products, 0)    AS total_products,
            CASE WHEN l.type = 'production'
                 THEN coalesce(po_active.cnt, 0)
                 ELSE NULL END                AS active_production_orders,
            CASE WHEN l.type = 'production'
                 THEN coalesce(po_done.cnt, 0)
                 ELSE NULL END                AS done_today_count
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s
          WHERE s.location_id = l.id
            AND s.qty <= s.min_level
            AND s.min_level > 0
            AND s.max_level > 0
       ) bm ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_requests_count
           FROM replenishment_requests rr
          WHERE rr.requester_location_id = l.id
            AND rr.status NOT IN ('CLOSED','CANCELLED')
       ) orq ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS total_products
           FROM stock s2 WHERE s2.location_id = l.id
       ) tp ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS cnt
           FROM production_orders po
          WHERE l.type = 'production'
            AND po.location_id = l.id
            AND po.status IN ('new','in_progress')
       ) po_active ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS cnt
           FROM production_orders po2
          WHERE l.type = 'production'
            AND po2.location_id = l.id
            AND po2.status = 'done'
            AND po2.done_at >= date_trunc('day', now())
            AND po2.done_at <  date_trunc('day', now()) + interval '1 day'
       ) po_done ON TRUE
       ${where}
       ORDER BY CASE l.type
                  WHEN 'raw_warehouse'      THEN 1
                  WHEN 'production'         THEN 2
                  WHEN 'sex_storage'        THEN 3
                  WHEN 'supply'             THEN 3
                  WHEN 'central_warehouse'  THEN 4
                  WHEN 'store'              THEN 5
                  ELSE 6
                END,
                l.id`,
    params,
  );

  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    location_type: r.location_type,
    below_min_count: Number(r.below_min_count),
    open_requests_count: Number(r.open_requests_count),
    total_products: Number(r.total_products),
    active_production_orders:
      r.active_production_orders === null
        ? null
        : Number(r.active_production_orders),
    done_today_count:
      r.done_today_count === null ? null : Number(r.done_today_count),
  }));
}

/**
 * Sprint B — one summary row per supply-chain stage (raw / production /
 * supply / central / store).
 *
 * Strategy:
 *   1. A single SQL query (`base`) aggregates locations, products and below-
 *      min counts grouped by `locations.type`. Backed by `ix_stock_product`
 *      and the partial `ix_stock_below_min` index — for the seeded DB (38
 *      locations / 2,448 stock rows) this is sub-millisecond.
 *   2. Five small per-type "pulse" queries run in parallel. Each one is
 *      narrowly bounded (single-day `created_at::date = CURRENT_DATE`
 *      filter; for `central` we hit `poster_sync_log` ordered by
 *      `started_at` LIMIT 1).
 *   3. A scoped principal (locations-kind) sees only the chain types that
 *      intersect their assigned `locationIds` — same UX as `chain_flow`.
 *
 * Notes:
 *   - For the `store` pulse we read `sales` directly (not `sales_stats_daily`)
 *     because today's row isn't aggregated yet — the cron runs nightly at
 *     03:00. The query is bounded by `sold_at >= CURRENT_DATE` and uses
 *     `ix_sales_store_date`.
 *   - For raw/production/supply pulses we use the existing
 *     `ix_movements_created` + `ix_movements_reason` indexes; same-day
 *     filter keeps the working set tiny.
 */
async function fetchChainSummary(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainSummaryNode[]> {
  // -------- base aggregate (counts + below-min) per chain type --------
  const baseParams: SqlParam[] = [];
  let locFilter = 'l.is_active = TRUE';
  if (scope.kind === 'locations') {
    baseParams.push(scope.locationIds);
    locFilter += ` AND l.id = ANY($${baseParams.length}::bigint[])`;
  }

  // D7 (2026-05-28) — fold the new `sex_storage` type into the historical
  // `supply` bucket so the 5-card chain_summary layout stays stable. After
  // migration 0022 every live "supply" row is actually `sex_storage`; the
  // frontend still reads the `supply` key for the sex skladi stage.
  const baseSql = `
    SELECT CASE WHEN l.type::text = 'sex_storage'
                THEN 'supply'
                ELSE l.type::text
           END                                                                    AS type,
           count(DISTINCT l.id)                                                    AS location_count,
           count(DISTINCT s.product_id) FILTER (WHERE s.product_id IS NOT NULL)    AS total_products,
           coalesce(sum(CASE
                          WHEN s.qty <= s.min_level AND s.min_level > 0 AND s.max_level > 0 THEN 1
                          ELSE 0
                        END), 0)                                                   AS below_min_count
      FROM locations l
      LEFT JOIN stock s ON s.location_id = l.id
     WHERE ${locFilter}
     GROUP BY 1
  `;

  type BaseRow = {
    type: string;
    location_count: string;
    total_products: string;
    below_min_count: string;
  };
  const baseRes = await query<BaseRow>(baseSql, baseParams);

  const baseByType = new Map<ChainType, BaseRow>();
  for (const r of baseRes.rows) {
    if ((CHAIN_TYPES as readonly string[]).includes(r.type)) {
      baseByType.set(r.type as ChainType, r);
    }
  }

  // No locations matched -> nothing to summarise. PM still gets 5 nodes
  // (even empty stages stay in the response so the UI can render them).
  if (baseByType.size === 0 && scope.kind === 'locations') {
    return [];
  }

  // -------- pulses (5 small parallel queries) --------
  const [raw, production, supply, central, store] = await Promise.all([
    fetchRawPulse(scope),
    fetchProductionPulse(scope),
    fetchSupplyPulse(scope),
    fetchCentralPulse(scope),
    fetchStorePulse(scope),
  ]);

  const pulsesByType: Record<ChainType, ChainPulse> = {
    raw_warehouse: raw,
    production,
    supply,
    central_warehouse: central,
    store,
  };

  // For PM/ai_assistant always emit all 5 types (so the UI keeps a stable
  // 5-card row even when one stage has no locations yet — e.g. a fresh
  // tenant with no production sex seeded). For scoped principals, only
  // emit the types they actually have access to (matches chain_flow UX).
  const types: ChainType[] =
    scope.kind === 'chain'
      ? [...CHAIN_TYPES]
      : ([...CHAIN_TYPES] as ChainType[]).filter((t) => baseByType.has(t));

  return types.map<ChainSummaryNode>((type) => {
    const row = baseByType.get(type);
    const belowMin = row ? Number(row.below_min_count) : 0;
    return {
      type,
      location_count: row ? Number(row.location_count) : 0,
      total_products: row ? Number(row.total_products) : 0,
      below_min_count: belowMin,
      status: deriveChainStatus(belowMin),
      pulse: pulsesByType[type],
    };
  });
}

function deriveChainStatus(belowMin: number): ChainStatus {
  if (belowMin === 0) return 'ok';
  if (belowMin <= 3) return 'warn';
  return 'danger';
}

/**
 * Builds a stock_movements `WHERE` fragment that scopes the pulse query to
 * locations of the given type(s), optionally intersected with the principal's
 * `locationIds`. Returned as a SQL snippet `(SELECT id FROM locations ...)`
 * — keeps the param list flat and easy to reason about.
 *
 * D7 (2026-05-28) — accepts a single type OR an array of types. The supply
 * stage now spans both the legacy `supply` (deprecated, kept as enum) and
 * the new `sex_storage` rows; callers pass `SUPPLY_PULSE_TYPES` so the
 * "supply" card in the 5-stage chain_summary keeps reporting the sex skladi
 * traffic after migration 0022 flips the live rows.
 */
function locationIdsForTypeSql(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  type: ChainType | readonly string[],
  params: SqlParam[],
): string {
  const types = Array.isArray(type) ? [...type] : [type as string];
  params.push(types);
  const typesIdx = params.length;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const locIdx = params.length;
    return `(SELECT id FROM locations
              WHERE type::text = ANY($${typesIdx}::text[])
                AND is_active = TRUE
                AND id = ANY($${locIdx}::bigint[]))`;
  }
  return `(SELECT id FROM locations
            WHERE type::text = ANY($${typesIdx}::text[])
              AND is_active = TRUE)`;
}

/** D7 — the supply stage spans both legacy `supply` and new `sex_storage`. */
const SUPPLY_PULSE_TYPES = ['supply', 'sex_storage'] as const;

async function fetchRawPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // 1. Today's flow (received/issued) — same query as before.
  const flowParams: SqlParam[] = [];
  const locSql = locationIdsForTypeSql(scope, 'raw_warehouse', flowParams);
  const flowQ = query<{ received_today: string; issued_today: string }>(
    `SELECT
       coalesce(sum(qty) FILTER (
         WHERE reason = 'purchase' AND to_location_id IN ${locSql}
       ), 0) AS received_today,
       coalesce(sum(qty) FILTER (
         WHERE reason = 'production_input' AND from_location_id IN ${locSql}
       ), 0) AS issued_today
     FROM stock_movements
     WHERE created_at >= date_trunc('day', now())
       AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    flowParams,
  );

  // 2. Open purchase orders targeting a raw warehouse.
  const poParams: SqlParam[] = [];
  const poLocSql = locationIdsForTypeSql(scope, 'raw_warehouse', poParams);
  const poQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM purchase_orders
      WHERE status IN ('draft','approved')
        AND target_location_id IN ${poLocSql}`,
    poParams,
  );

  // 3. Total qty held at raw warehouses, grouped by `products.unit` so the UI
  //    can render "ombor sig'imi" per unit instead of collapsing kg / l / pcs
  //    into a meaningless scalar.
  const qtyParams: SqlParam[] = [];
  const qtyLocSql = locationIdsForTypeSql(scope, 'raw_warehouse', qtyParams);
  const qtyQ = query<{ unit: string; qty: string }>(
    `SELECT p.unit::text AS unit, coalesce(sum(s.qty), 0) AS qty
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id IN ${qtyLocSql}
      GROUP BY p.unit
      ORDER BY p.unit`,
    qtyParams,
  );

  const [flow, po, qty] = await Promise.all([flowQ, poQ, qtyQ]);
  const f = flow.rows[0];
  return {
    kind: 'raw',
    received_today: Number(f?.received_today ?? 0),
    issued_today: Number(f?.issued_today ?? 0),
    pending_purchase_orders: Number(po.rows[0]?.cnt ?? 0),
    total_qty_by_unit: qty.rows.map((r) => ({
      unit: r.unit,
      qty: Number(r.qty),
    })),
  };
}

async function fetchProductionPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  const params: SqlParam[] = [];
  const locSql = locationIdsForTypeSql(scope, 'production', params);
  const activeQ = query<{ active: string }>(
    `SELECT count(*) AS active
       FROM production_orders
      WHERE status IN ('new','in_progress')
        AND location_id IN ${locSql}`,
    params,
  );
  const doneParams: SqlParam[] = [];
  const doneLocSql = locationIdsForTypeSql(scope, 'production', doneParams);
  const doneQ = query<{ done: string }>(
    `SELECT count(*) AS done
       FROM production_orders
      WHERE status = 'done'
        AND done_at >= date_trunc('day', now())
        AND done_at <  date_trunc('day', now()) + interval '1 day'
        AND location_id IN ${doneLocSql}`,
    doneParams,
  );

  // Overdue: open production orders whose deadline has passed.
  const overdueParams: SqlParam[] = [];
  const overdueLocSql = locationIdsForTypeSql(scope, 'production', overdueParams);
  const overdueQ = query<{ overdue: string }>(
    `SELECT count(*) AS overdue
       FROM production_orders
      WHERE status IN ('new','in_progress')
        AND deadline IS NOT NULL
        AND deadline < CURRENT_DATE
        AND location_id IN ${overdueLocSql}`,
    overdueParams,
  );

  // sex_count: active production locations visible to the principal. We
  // bypass `locationIdsForTypeSql` (which returns an `IN (...)` subquery)
  // and reuse the same scope rules inline so we can SELECT count.
  const sexParams: SqlParam[] = [];
  let sexWhere = `type = 'production' AND is_active = TRUE`;
  if (scope.kind === 'locations') {
    sexParams.push(scope.locationIds);
    sexWhere += ` AND id = ANY($${sexParams.length}::bigint[])`;
  }
  const sexQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM locations WHERE ${sexWhere}`,
    sexParams,
  );

  // input_today: qty consumed by sexes today (production_input leaving a
  // location that is itself a production sex — sex consumes from its own
  // raw bin per the BOM).
  const inputParams: SqlParam[] = [];
  const inputLocSql = locationIdsForTypeSql(scope, 'production', inputParams);
  const inputQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_input'
        AND from_location_id IN ${inputLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    inputParams,
  );

  // output_today: qty produced by sexes today.
  const outputParams: SqlParam[] = [];
  const outputLocSql = locationIdsForTypeSql(scope, 'production', outputParams);
  const outputQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_output'
        AND from_location_id IN ${outputLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    outputParams,
  );

  const [a, d, ov, sx, inp, out] = await Promise.all([
    activeQ,
    doneQ,
    overdueQ,
    sexQ,
    inputQ,
    outputQ,
  ]);
  return {
    kind: 'production',
    active_orders: Number(a.rows[0]?.active ?? 0),
    done_today: Number(d.rows[0]?.done ?? 0),
    overdue_orders: Number(ov.rows[0]?.overdue ?? 0),
    sex_count: Number(sx.rows[0]?.cnt ?? 0),
    input_today: Number(inp.rows[0]?.total ?? 0),
    output_today: Number(out.rows[0]?.total ?? 0),
  };
}

async function fetchSupplyPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  const shipParams: SqlParam[] = [];
  const shipLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, shipParams);
  const shipQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'transfer'
        AND from_location_id IN ${shipLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    shipParams,
  );
  const recvParams: SqlParam[] = [];
  const recvLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, recvParams);
  const recvQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_output'
        AND to_location_id IN ${recvLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    recvParams,
  );

  // Open replenishment requests routed THROUGH a supply location. `supply`
  // is an intermediate hop, so it can appear as either the requester (the
  // supply chief asks for inputs) or the target (a store asks supply to
  // ship). We count rows where EITHER endpoint is a supply location in
  // scope and the request is not terminal.
  const openParams: SqlParam[] = [];
  const openLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, openParams);
  const openQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM replenishment_requests
      WHERE status NOT IN ('CLOSED','CANCELLED')
        AND (requester_location_id IN ${openLocSql}
             OR target_location_id IN ${openLocSql})`,
    openParams,
  );

  // Distinct destinations a supply location served today (today's transfer
  // fan-out count — useful for "today supply shipped to N stores").
  const destParams: SqlParam[] = [];
  const destLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, destParams);
  const destQ = query<{ cnt: string }>(
    `SELECT count(DISTINCT to_location_id) AS cnt
       FROM stock_movements
      WHERE reason = 'transfer'
        AND from_location_id IN ${destLocSql}
        AND to_location_id IS NOT NULL
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    destParams,
  );

  const [s, r, op, ds] = await Promise.all([shipQ, recvQ, openQ, destQ]);
  return {
    kind: 'supply',
    shipped_today: Number(s.rows[0]?.total ?? 0),
    received_today: Number(r.rows[0]?.total ?? 0),
    open_requests: Number(op.rows[0]?.cnt ?? 0),
    top_destination_count: Number(ds.rows[0]?.cnt ?? 0),
  };
}

async function fetchCentralPulse(
  _scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // Poster sync is chain-wide (no per-location scoping makes sense — the
  // pulse mirrors poster_status.last_sync_at). We keep this query trivially
  // cheap by hitting the `ix_poster_sync_entity` index with LIMIT 1.
  const latestQ = query<{
    started_at: Date;
    finished_at: Date | null;
    status: 'ok' | 'partial' | 'failed';
  }>(
    `SELECT started_at, finished_at, status::text AS status
       FROM poster_sync_log
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
  );

  // Failed sync runs in the last 24h — quick chain-wide health gauge that
  // a store_manager wouldn't see, but a PM cares about.
  const errorsQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM poster_sync_log
      WHERE status = 'failed'
        AND started_at > now() - interval '24 hours'`,
  );

  const [latest, errors] = await Promise.all([latestQ, errorsQ]);
  const row = latest.rows[0];
  const when = row?.finished_at ?? row?.started_at ?? null;
  return {
    kind: 'central',
    last_sync_at: when === null ? null : when.toISOString(),
    last_sync_status: row?.status ?? null,
    sync_errors_24h: Number(errors.rows[0]?.cnt ?? 0),
  };
}

async function fetchStorePulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // Today's sales — read from `sales` (not `sales_stats_daily`) because the
  // daily aggregate cron only runs at 03:00, so today's row doesn't exist
  // mid-day. The window is tight (1 day) and `ix_sales_store_date` keeps
  // the scan bounded; even at 70k+ rows this stays sub-100ms.
  const params: SqlParam[] = [];
  let where = `sold_at >= date_trunc('day', now())
               AND sold_at <  date_trunc('day', now()) + interval '1 day'`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND store_id = ANY($${params.length}::bigint[])`;
  }
  const salesQ = query<{
    total_sum: string | null;
    receipts: string;
    qty_today: string | null;
  }>(
    `SELECT coalesce(sum(qty * price), 0)         AS total_sum,
            count(DISTINCT poster_transaction_id) AS receipts,
            coalesce(sum(qty), 0)                 AS qty_today
       FROM sales
      WHERE ${where}`,
    params,
  );

  // Open replenishments originating from a store the principal can see.
  const replParams: SqlParam[] = [];
  const replLocSql = locationIdsForTypeSql(scope, 'store', replParams);
  const replQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM replenishment_requests
      WHERE status NOT IN ('CLOSED','CANCELLED')
        AND requester_location_id IN ${replLocSql}`,
    replParams,
  );

  // Transit deliveries: transfer movements arriving at a store in scope
  // within the last 24h that are linked to a replenishment request. The
  // `replenishment_id` link distinguishes a real "transit" from a manual
  // ad-hoc transfer.
  const transitParams: SqlParam[] = [];
  const transitLocSql = locationIdsForTypeSql(scope, 'store', transitParams);
  const transitQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM stock_movements
      WHERE reason = 'transfer'
        AND replenishment_id IS NOT NULL
        AND to_location_id IN ${transitLocSql}
        AND created_at > now() - interval '24 hours'`,
    transitParams,
  );

  // Best-selling product today across stores in scope.
  const topParams: SqlParam[] = [];
  let topWhere = `s.sold_at >= date_trunc('day', now())
                  AND s.sold_at <  date_trunc('day', now()) + interval '1 day'`;
  if (scope.kind === 'locations') {
    topParams.push(scope.locationIds);
    topWhere += ` AND s.store_id = ANY($${topParams.length}::bigint[])`;
  }
  const topQ = query<{ name: string }>(
    `SELECT p.name
       FROM sales s
       JOIN products p ON p.id = s.product_id
      WHERE ${topWhere}
      GROUP BY p.id, p.name
      ORDER BY sum(s.qty) DESC, p.id ASC
      LIMIT 1`,
    topParams,
  );

  const [sales, repl, transit, top] = await Promise.all([
    salesQ,
    replQ,
    transitQ,
    topQ,
  ]);
  const r = sales.rows[0];
  const salesSum = Number(r?.total_sum ?? 0);
  const receipts = Number(r?.receipts ?? 0);
  return {
    kind: 'store',
    sales_today_sum: salesSum,
    receipts_today: receipts,
    avg_receipt_today: receipts > 0 ? salesSum / receipts : 0,
    open_replenishments: Number(repl.rows[0]?.cnt ?? 0),
    transit_count: Number(transit.rows[0]?.cnt ?? 0),
    top_product_name: top.rows[0]?.name ?? null,
    qty_today: Number(r?.qty_today ?? 0),
  };
}

/**
 * The latest 20 notifications, scoped to the principal.
 *
 * F4.11 Bug-MIN-03 — previously this fetched chain-wide for every role, so a
 * store_manager saw alerts about locations they have no business seeing.
 * Scoping rules now mirror the rest of the dashboard:
 *
 *   - pm / ai_assistant / central_warehouse_manager
 *       chain-wide visibility (see `pendingApprovalsClause` for the same
 *       three-role split).
 *   - any other scoped role
 *       only alerts addressed to them personally
 *       (`notifications.recipient_user_id = principal.userId`)
 *       OR alerts tagged with a location id in `payload.location_id` that
 *       falls inside their assigned `locationIds` set.
 *
 * Severity is derived from `notifications.type` per the spec §2.4 routing
 * table.
 */
async function fetchAlertsFeed(
  principal: AuthPrincipal,
): Promise<AlertsFeedItem[]> {
  const params: SqlParam[] = [];
  let where = '';
  if (!isAlertsChainWide(principal)) {
    // No assigned locations -> only personal alerts are reachable.
    params.push(principal.userId);
    const personalIdx = params.length;
    if (principal.locationIds.length === 0) {
      where = `WHERE recipient_user_id = $${personalIdx}`;
    } else {
      params.push(principal.locationIds);
      const locsIdx = params.length;
      // `payload->>'location_id'` is text in JSONB; cast both sides through
      // bigint so numeric comparison works against the `bigint[]` ids.
      where =
        `WHERE recipient_user_id = $${personalIdx} ` +
        `   OR (payload ? 'location_id' ` +
        `       AND (payload->>'location_id') ~ '^[0-9]+$' ` +
        `       AND (payload->>'location_id')::bigint = ANY($${locsIdx}::bigint[]))`;
    }
  }
  params.push(ALERTS_FEED_LIMIT);
  const limitIdx = params.length;

  const { rows } = await query<{
    id: string;
    type: string;
    title: string;
    body: string;
    payload: { location_id?: number | string } | null;
    created_at: Date;
  }>(
    `SELECT id, type, title, body, payload, created_at
       FROM notifications
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx}`,
    params,
  );

  return rows.map((r) => {
    const payloadLoc = r.payload?.location_id;
    const locationId =
      payloadLoc === undefined || payloadLoc === null ? null : Number(payloadLoc);
    return {
      id: Number(r.id),
      type: r.type,
      severity: severityFor(r.type),
      title: r.title,
      message: r.body,
      location_id: Number.isFinite(locationId as number) ? (locationId as number) : null,
      created_at: r.created_at.toISOString(),
    };
  });
}

/** Spec §2.4 severity routing. Unknown types default to `info`. */
function severityFor(type: string): AlertSeverity {
  switch (type) {
    case 'negative_stock_detected':
    case 'wrong_keyed_check':
    case 'poster_sync_failed':
      return 'danger';
    case 'stock_below_min':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Last 30 days of sales, aggregated from `sales_stats_daily`. For a scoped
 * principal, only their assigned locations contribute. The chart is fed by
 * the nightly `salesAggregateCron`, so per-day rows always exist for days
 * that had sales.
 */
async function fetchSalesChart(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<SalesChartItem[]> {
  // F4.9 — chart window equals the requested range. The aggregate table is
  // keyed by `stat_date` (DATE, not TIMESTAMPTZ), so we compare against the
  // calendar bounds, inclusive on both ends.
  const fromDate = toIsoDate(range.from);
  // Subtract 1 ms so a half-open `[from, to)` window maps back to the last
  // inclusive calendar day in `to`. Without it `2026-05-25T00:00:00Z` would
  // pull in 2026-05-25 even when the caller asked through 2026-05-24.
  const toInclusive = new Date(range.to.getTime() - 1);
  const toDate = toIsoDate(toInclusive);
  const params: SqlParam[] = [fromDate, toDate];
  let where = `WHERE stat_date >= $1::date AND stat_date <= $2::date`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND location_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await query<{ stat_date: Date; qty: string }>(
    `SELECT stat_date, sum(qty_sold) AS qty
       FROM sales_stats_daily
       ${where}
       GROUP BY stat_date
       ORDER BY stat_date`,
    params,
  );
  return rows.map((r) => ({
    date: toIsoDate(r.stat_date),
    qty: Number(r.qty),
  }));
}

function emptyEcosystem(): EcosystemResponse {
  return {
    poster_status: {
      last_sync_at: null,
      last_sync_status: null,
      sync_errors_24h: 0,
      sales_today_count: 0,
      sales_today_sum: 0,
    },
    chain_flow: [],
    chain_summary: [],
    chain_edges: [],
    alerts_feed: [],
    sales_chart: { days: [] },
  };
}

/**
 * D-0026 — read explicit M:N edges from `location_flows`.
 *
 * Scoping rules:
 *   - chain     — every active edge (the PM canvas sees the full graph).
 *   - locations — edges where either endpoint is in the principal's
 *                 assigned set. A store_manager rarely has flow edges
 *                 (stores are leaf nodes today) but the rule is uniform.
 *
 * Only edges between two ACTIVE locations are returned — `is_active=false`
 * rows would render dangling endpoints on the canvas.
 */
async function fetchChainEdges(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainEdge[]> {
  const params: SqlParam[] = [];
  let where = `WHERE lf_from.is_active = TRUE AND lf_to.is_active = TRUE`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND (lf.from_location_id = ANY($${params.length}::bigint[])
                OR lf.to_location_id   = ANY($${params.length}::bigint[]))`;
  }

  const { rows } = await query<{
    from_location_id: string;
    to_location_id: string;
    flow_type: ChainEdge['type'];
  }>(
    `SELECT lf.from_location_id, lf.to_location_id, lf.flow_type
       FROM location_flows lf
       JOIN locations lf_from ON lf_from.id = lf.from_location_id
       JOIN locations lf_to   ON lf_to.id   = lf.to_location_id
       ${where}
       ORDER BY lf.from_location_id, lf.to_location_id, lf.flow_type`,
    params,
  );

  return rows.map((r) => ({
    from: Number(r.from_location_id),
    to: Number(r.to_location_id),
    type: r.flow_type,
  }));
}

// =============================================================================
// F4.6 — GET /api/dashboard/chain-layer/:type
// =============================================================================
//
// One aggregate the UI uses to render a single "chain layer" page (raw,
// production, supply, central_warehouse, or store). Every layer page wants
// the same skeleton — locations on this layer with per-location KPIs,
// rolled-up totals, and the most recent movements — plus a few layer-specific
// totals (active production orders for `production`, pending shipments for
// `supply`/`central_warehouse`, today's sales count for `store`).
//
// RBAC:
//   - pm + ai_assistant — every location of the requested type.
//   - the matching layer's manager role — only locations from the type set
//     that intersect their assigned `locationIds`.
//   - any other role — 403 (the supply_manager has no business on the raw
//     warehouse layer page, etc.).
//
// Performance: every sub-query is bounded (recent_movements LIMIT 20) and
// fans out via Promise.all. Same < 1s budget as /overview.
// -----------------------------------------------------------------------------

const CHAIN_LAYER_RECENT_MOVEMENTS = 20;

// D7 (2026-05-28) — `sex_storage` is accepted as a SYNONYM for the supply
// layer. The data-fetching SQL maps either path-segment to the same set
// `['supply','sex_storage']` so the existing `ChainDetailSheet` keeps working
// and a new client may use the canonical name.
const CHAIN_LAYER_TYPES = [
  'raw_warehouse',
  'production',
  'sex_storage',
  'supply',
  'central_warehouse',
  'store',
] as const;
type ChainLayerType = (typeof CHAIN_LAYER_TYPES)[number];

/** The single role that manages each layer. PM + ai_assistant pass any layer. */
const LAYER_MANAGER_ROLE: Record<ChainLayerType, Role> = {
  raw_warehouse: 'raw_warehouse_manager',
  production: 'production_manager',
  sex_storage: 'supply_manager',
  supply: 'supply_manager',
  central_warehouse: 'central_warehouse_manager',
  store: 'store_manager',
};

/**
 * SQL type filter for the requested layer. Supply / sex_storage both fan
 * out to BOTH location_type values so the dashboard surface keeps reporting
 * the sex skladi traffic after migration 0022 flipped the live rows.
 */
function chainLayerTypeFilter(layerType: ChainLayerType): readonly string[] {
  if (layerType === 'supply' || layerType === 'sex_storage') {
    return SUPPLY_PULSE_TYPES;
  }
  return [layerType];
}

type ChainLayerLocation = {
  id: number;
  name: string;
  type: ChainLayerType;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
};

type ChainLayerTotals = {
  total_locations: number;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
  active_production_orders?: number;
  pending_shipments?: number;
  sales_today_count?: number;
};

type ChainLayerResponse = {
  layer_type: ChainLayerType;
  locations: ChainLayerLocation[];
  totals: ChainLayerTotals;
  recent_movements: RecentMovementItem[];
};

type LayerScope =
  | { kind: 'chain'; type: ChainLayerType }
  | { kind: 'locations'; type: ChainLayerType; locationIds: number[] }
  | { kind: 'empty'; type: ChainLayerType };

dashboardRouter.get(
  '/chain-layer/:type',
  authenticate,
  // Authorize is broad here — the handler narrows per-layer (`LAYER_MANAGER_ROLE`).
  // A non-matching scoped role hits a clean 403 instead of a generic gate.
  authorize(
    'pm',
    'ai_assistant',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const rawType = req.params.type ?? '';
    if (!(CHAIN_LAYER_TYPES as readonly string[]).includes(rawType)) {
      throw AppError.validation(
        `"type" must be one of: ${CHAIN_LAYER_TYPES.join(', ')}.`,
      );
    }
    const layerType = rawType as ChainLayerType;

    // RBAC: only pm / ai_assistant / the matching layer manager pass.
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== LAYER_MANAGER_ROLE[layerType]
    ) {
      throw AppError.forbidden('You may not view this chain layer.');
    }

    // F4.9 — recent_movements + (store layer) sales_today_count clip to range.
    const range = parseDateRange(req.query);

    const scope = resolveLayerScope(principal, layerType);
    if (scope.kind === 'empty') {
      res.status(200).json(emptyChainLayer(layerType));
      return;
    }

    const [locations, layerExtras, recent] = await Promise.all([
      fetchChainLayerLocations(scope),
      fetchChainLayerExtras(scope, range),
      fetchChainLayerRecentMovements(scope, range),
    ]);

    const totals: ChainLayerTotals = {
      total_locations: locations.length,
      total_products: locations.reduce((sum, l) => sum + l.total_products, 0),
      below_min_count: locations.reduce((sum, l) => sum + l.below_min_count, 0),
      open_requests_count: locations.reduce((sum, l) => sum + l.open_requests_count, 0),
    };
    if (layerType === 'production') {
      totals.active_production_orders = layerExtras.activeProductionOrders;
    }
    if (
      layerType === 'supply' ||
      layerType === 'sex_storage' ||
      layerType === 'central_warehouse'
    ) {
      totals.pending_shipments = layerExtras.pendingShipments;
    }
    if (layerType === 'store') {
      totals.sales_today_count = layerExtras.salesTodayCount;
    }

    const response: ChainLayerResponse = {
      layer_type: layerType,
      locations,
      totals,
      recent_movements: recent,
    };
    res.status(200).json(response);
  }),
);

function resolveLayerScope(
  principal: AuthPrincipal,
  layerType: ChainLayerType,
): LayerScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain', type: layerType };
  }
  if (principal.locationIds.length === 0) {
    return { kind: 'empty', type: layerType };
  }
  return {
    kind: 'locations',
    type: layerType,
    locationIds: principal.locationIds,
  };
}

/** One row per active location of the requested type, with KPIs. */
async function fetchChainLayerLocations(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
): Promise<ChainLayerLocation[]> {
  // D7 — `supply` and `sex_storage` both resolve to the same set.
  const typeFilter = [...chainLayerTypeFilter(scope.type)];
  const params: SqlParam[] = [typeFilter];
  let where = 'WHERE l.type::text = ANY($1::text[]) AND l.is_active = TRUE';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND l.id = ANY($${params.length}::bigint[])`;
  }

  const { rows } = await query<{
    id: string;
    name: string;
    type: string;
    total_products: string;
    below_min_count: string;
    open_requests_count: string;
  }>(
    `SELECT l.id, l.name, l.type::text AS type,
            coalesce(tp.total_products, 0)       AS total_products,
            coalesce(bm.below_min_count, 0)      AS below_min_count,
            coalesce(orq.open_requests_count, 0) AS open_requests_count
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS total_products
           FROM stock s WHERE s.location_id = l.id
       ) tp ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s
          WHERE s.location_id = l.id
            AND s.qty <= s.min_level
            AND s.min_level > 0
            AND s.max_level > 0
       ) bm ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_requests_count
           FROM replenishment_requests rr
          WHERE rr.requester_location_id = l.id
            AND rr.status NOT IN ('CLOSED','CANCELLED')
       ) orq ON TRUE
       ${where}
       ORDER BY l.id`,
    params,
  );

  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    type: r.type as ChainLayerType,
    total_products: Number(r.total_products),
    below_min_count: Number(r.below_min_count),
    open_requests_count: Number(r.open_requests_count),
  }));
}

/**
 * Layer-specific extras: active production orders (production layer), pending
 * shipments (supply + central_warehouse layers), today's sales count (store
 * layer). Always returns all three fields — the handler only emits the ones
 * relevant to the requested layer.
 */
async function fetchChainLayerExtras(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<{
  activeProductionOrders: number;
  pendingShipments: number;
  salesTodayCount: number;
}> {
  const layerType = scope.type;
  const locFilter = scope.kind === 'locations' ? scope.locationIds : null;

  // Active production orders — only when the layer is production. A PO lives
  // on `production` locations, so the location filter is the scope's id set.
  const activeProdPromise =
    layerType === 'production'
      ? (async () => {
          const params: SqlParam[] = [];
          let where = `WHERE po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND po.location_id = ANY($${params.length}::bigint[])`;
          } else {
            // chain — implicit `po.location_id IN (every production location)`,
            // but every PO already targets a production location so no extra
            // filter is needed.
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt FROM production_orders po ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  // Pending shipments — open replenishment_requests where the target is one
  // of the layer's locations. "Pending" = not yet terminal (per the
  // `replenishment_status` enum, the terminal states are CLOSED and
  // CANCELLED). D7 — supply/sex_storage are aliased.
  const isSupplyOrSexStorage =
    layerType === 'supply' || layerType === 'sex_storage';
  const pendingShipmentsPromise =
    isSupplyOrSexStorage || layerType === 'central_warehouse'
      ? (async () => {
          const typeFilter = [...chainLayerTypeFilter(layerType)];
          const params: SqlParam[] = [typeFilter];
          let where =
            `WHERE rr.status NOT IN ('CLOSED','CANCELLED') AND tl.type::text = ANY($1::text[])`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND rr.target_location_id = ANY($${params.length}::bigint[])`;
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt
               FROM replenishment_requests rr
               JOIN locations tl ON tl.id = rr.target_location_id
               ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  // Sales count in the requested range — only on the store layer.
  // (Field is named `salesTodayCount` for backward compat with the response
  // schema; semantically it is "sales in range".)
  const salesTodayPromise =
    layerType === 'store'
      ? (async () => {
          const params: SqlParam[] = [range.from, range.to];
          let where = `WHERE sold_at >= $1 AND sold_at < $2`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND store_id = ANY($${params.length}::bigint[])`;
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt FROM sales ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  const [activeProductionOrders, pendingShipments, salesTodayCount] =
    await Promise.all([activeProdPromise, pendingShipmentsPromise, salesTodayPromise]);
  return { activeProductionOrders, pendingShipments, salesTodayCount };
}

/**
 * Recent movements touching the layer. A movement "touches" the layer when
 * either its source or destination is a location of the requested type
 * (and, for a scoped principal, also in their assigned set).
 */
async function fetchChainLayerRecentMovements(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<RecentMovementItem[]> {
  // D7 — `supply` / `sex_storage` both expand to the same type-set.
  const typeFilter = [...chainLayerTypeFilter(scope.type)];
  const params: SqlParam[] = [typeFilter];
  let where =
    `WHERE (fl.type::text = ANY($1::text[]) OR tl.type::text = ANY($1::text[]))`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where +=
      ` AND (m.from_location_id = ANY($${params.length}::bigint[]) ` +
      `OR m.to_location_id = ANY($${params.length}::bigint[]))`;
  }
  // F4.9 — clip to range.
  params.push(range.from);
  where += ` AND m.created_at >= $${params.length}`;
  params.push(range.to);
  where += ` AND m.created_at < $${params.length}`;
  params.push(CHAIN_LAYER_RECENT_MOVEMENTS);
  const limitIdx = params.length;

  const { rows } = await query<RecentMovementRaw>(
    `SELECT m.id, m.created_at,
            m.product_id, p.name AS product_name, p.unit AS product_unit,
            m.from_location_id, fl.name AS from_location_name,
            m.to_location_id,   tl.name AS to_location_name,
            m.qty, m.reason::text AS reason
       FROM stock_movements m
       JOIN products p   ON p.id  = m.product_id
       LEFT JOIN locations fl ON fl.id = m.from_location_id
       LEFT JOIN locations tl ON tl.id = m.to_location_id
       ${where}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${limitIdx}`,
    params,
  );
  return rows.map(mapMovement);
}

function emptyChainLayer(layerType: ChainLayerType): ChainLayerResponse {
  const totals: ChainLayerTotals = {
    total_locations: 0,
    total_products: 0,
    below_min_count: 0,
    open_requests_count: 0,
  };
  if (layerType === 'production') totals.active_production_orders = 0;
  if (
    layerType === 'supply' ||
    layerType === 'sex_storage' ||
    layerType === 'central_warehouse'
  ) {
    totals.pending_shipments = 0;
  }
  if (layerType === 'store') totals.sales_today_count = 0;
  return {
    layer_type: layerType,
    locations: [],
    totals,
    recent_movements: [],
  };
}

// =============================================================================
// Sub-task #5 — GET /api/dashboard/aging-alerts
// =============================================================================
//
// Surfaces stock sitting in a `sex_storage` (or legacy `supply`) location for
// longer than its `products.shelf_life_days` threshold.
//
// Aging is computed from the most recent inbound `stock_movement` (reasons:
// `production_output` or `transfer`) that landed product P into location L.
// We then compare `now() - last_inbound_at` against `shelf_life_days` and
// classify:
//   - days_in_storage >= shelf_life_days        -> 'critical' (already off)
//   - days_in_storage >= shelf_life_days * 0.7  -> 'warning'  (safe-zone)
//
// Products with NULL `shelf_life_days` (raw materials) are ignored — they
// have no expiry.
//
// RBAC mirrors `/api/dashboard/overview`:
//   - pm / ai_assistant -> chain-wide.
//   - scoped principal  -> only their assigned sex_storage / supply locations.
// =============================================================================

const AGING_WARNING_RATIO = 0.7;

type AgingAlertRaw = {
  location_id: string;
  location_name: string;
  location_type: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  shelf_life_days: number;
  last_inbound_at: Date;
  days_in_storage: string;
};

type AgingAlertItem = {
  location_id: number;
  location_name: string;
  location_type: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  shelf_life_days: number;
  last_inbound_at: string;
  days_in_storage: number;
  urgency: 'warning' | 'critical';
};

type AgingAlertsResponse = {
  items: AgingAlertItem[];
};

dashboardRouter.get(
  '/aging-alerts',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveEcosystemScope(principal);

    if (scope.kind === 'empty') {
      res.status(200).json({ items: [] } satisfies AgingAlertsResponse);
      return;
    }

    const params: SqlParam[] = [];
    // Sex skladi = `sex_storage` (post-D7) + legacy `supply` rows. Aging is
    // most relevant for half-finished goods sitting in a sex buffer, but we
    // include legacy `supply` rows so any unmigrated tenant still gets the
    // signal.
    let locFilter = `l.type IN ('sex_storage','supply') AND l.is_active = TRUE`;
    if (scope.kind === 'locations') {
      params.push(scope.locationIds);
      locFilter += ` AND l.id = ANY($${params.length}::bigint[])`;
    }

    // The aging signal is the most recent inbound movement into (L, P). We
    // consider `production_output` and `transfer` — both deposit qty into a
    // sex_storage. `purchase` is for raw warehouses, not sex buffers, and is
    // intentionally excluded.
    const { rows } = await query<AgingAlertRaw>(
      `SELECT s.location_id, l.name AS location_name, l.type::text AS location_type,
              s.product_id, p.name AS product_name, p.unit::text AS product_unit,
              s.qty,
              p.shelf_life_days,
              last_inbound.created_at AS last_inbound_at,
              EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0
                AS days_in_storage
         FROM stock s
         JOIN products  p ON p.id = s.product_id
         JOIN locations l ON l.id = s.location_id
         JOIN LATERAL (
           SELECT m.created_at
             FROM stock_movements m
            WHERE m.product_id = s.product_id
              AND m.to_location_id = s.location_id
              AND m.reason IN ('production_output','transfer')
            ORDER BY m.created_at DESC
            LIMIT 1
         ) last_inbound ON TRUE
        WHERE s.qty > 0
          AND p.shelf_life_days IS NOT NULL
          AND ${locFilter}
          AND EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0
              >= p.shelf_life_days * $${params.length + 1}::numeric
        ORDER BY (EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0)
                 / NULLIF(p.shelf_life_days, 0) DESC,
                 s.location_id, s.product_id`,
      [...params, AGING_WARNING_RATIO],
    );

    const items: AgingAlertItem[] = rows.map((r) => {
      const days = Number(r.days_in_storage);
      const shelf = r.shelf_life_days;
      const urgency: 'warning' | 'critical' =
        days >= shelf ? 'critical' : 'warning';
      return {
        location_id: Number(r.location_id),
        location_name: r.location_name,
        location_type: r.location_type,
        product_id: Number(r.product_id),
        product_name: r.product_name,
        product_unit: r.product_unit,
        qty: Number(r.qty),
        shelf_life_days: shelf,
        last_inbound_at: r.last_inbound_at.toISOString(),
        days_in_storage: Math.round(days * 100) / 100,
        urgency,
      };
    });

    res.status(200).json({ items } satisfies AgingAlertsResponse);
  }),
);

// =============================================================================
// Sub-task #7 — GET /api/dashboard/revenue-breakdown
// =============================================================================
//
// Today's revenue split by payment method (naqd / karta / Payme / Click /
// other). Backed by Poster `dash.getPaymentsReport` — already aggregated by
// the POS, so we don't pull every check line ourselves.
//
// Query params:
//   ?date=YYYY-MM-DD   default = today (the venue's local day).
//   ?spotId=<int>      optional Poster spot_id; restricts the lookup to one
//                       store. PM may pass any spot; a scoped principal may
//                       only pass a spot that maps to one of their assigned
//                       store locations.
//
// Response shape:
//   { date, spotId?, total, byMethod: { cash, card, payme, click, other } }
//
// RBAC: pm / ai_assistant / store_manager / central_warehouse_manager /
//       supply_manager — the same set that can read /api/sales.
// =============================================================================

type RevenueBreakdownResponse = {
  date: string;
  spot_id: number | null;
  total: number;
  by_method: {
    cash: number;
    card: number;
    payme: number;
    click: number;
    other: number;
  };
};

dashboardRouter.get(
  '/revenue-breakdown',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const dateStr = parseDateParam(req.query.date);
    const spotIdParam = parseOptionalSpotId(req.query.spotId ?? req.query.spot_id);

    // RBAC scoping for spotId: a scoped principal may only target a spot
    // mapped to one of their assigned store locations.
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== 'central_warehouse_manager' &&
      principal.role !== 'supply_manager' &&
      spotIdParam !== null
    ) {
      const ok = await isSpotAssignedToPrincipal(principal.locationIds, spotIdParam);
      if (!ok) {
        throw AppError.forbidden(
          'You may only query revenue for spots in your assigned stores.',
        );
      }
    }

    // EPIC 0.3 — REAL Poster path. `dash.getPaymentsReport` is already
    // aggregated by the POS, so we ask Poster for the day's split directly
    // instead of synthesising a fixed ratio from the (possibly corrupted)
    // local `sales` table. Money arrives in TIYIN and is converted to so'm by
    // `paymentReportToBuckets` (see posterMoney.ts for the live-verified ÷100
    // proof). The buckets always reconcile back to `total`.
    const { paymentReportToBuckets } = await import(
      '../integrations/poster/posterMoney.js'
    );
    const { createPosterClientFromConfig } = await import(
      '../integrations/poster/client.js'
    );

    const client = createPosterClientFromConfig();
    // YYYY-MM-DD -> Poster YYYYMMDD (shared helper; UTC-anchored).
    const compact = toPosterDate(new Date(`${dateStr}T00:00:00.000Z`));
    const report = await client.getPaymentsReport({
      dateFrom: compact,
      dateTo: compact,
      ...(spotIdParam !== null ? { spotId: spotIdParam } : {}),
    });

    const { byMethod, total } = paymentReportToBuckets(report);

    const response: RevenueBreakdownResponse = {
      date: dateStr,
      spot_id: spotIdParam,
      total,
      by_method: {
        cash: byMethod.cash,
        card: byMethod.card,
        payme: byMethod.payme,
        click: byMethod.click,
        other: byMethod.other,
      },
    };
    res.status(200).json(response);
  }),
);

/** Parse `?date=YYYY-MM-DD`; default to today's date (UTC) when missing. */
function parseDateParam(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppError.validation('"date" must be a YYYY-MM-DD string.');
  }
  return raw;
}

/** Parse `?spotId=` to a positive integer, or `null` when missing. */
function parseOptionalSpotId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.validation('"spotId" must be a positive integer.');
  }
  return n;
}

/**
 * Confirm that the Poster `spot_id` resolves to a `locations.id` inside the
 * principal's assigned set. Returns false when no `store` location maps
 * to the spot or the mapped location is not in scope.
 */
async function isSpotAssignedToPrincipal(
  locationIds: readonly number[],
  spotId: number,
): Promise<boolean> {
  if (locationIds.length === 0) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations
      WHERE poster_spot_id = $1 AND type = 'store' AND is_active = TRUE
      LIMIT 1`,
    [spotId],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) return false;
  return locationIds.includes(Number(idRaw));
}
