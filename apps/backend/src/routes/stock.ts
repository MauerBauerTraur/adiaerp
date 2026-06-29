/**
 * M3 — Stock & Movements (spec section 4.4).
 *
 *   GET   /api/stock?location_id=          — current stock (RBAC-scoped)
 *   PATCH /api/stock/minmax                — set min/max for (location, product)
 *   POST  /api/stock/movement              — atomic stock movement
 *   GET   /api/stock/movements?...         — movement history (paginated)
 *
 * Every movement is one atomic transaction (invariant 1) via `applyMovement`.
 * RBAC: a location-scoped manager only reads/writes its own location;
 * `store_manager` may not create movements (spec section 6 matrix).
 *
 * Response shapes (spec section 4): `GET /api/stock` returns a bare array;
 * `GET /api/stock/movements` returns `{ items, total, limit, offset }` — the
 * one paginated list. A manual movement's `reason` is `transfer` (two-sided)
 * or `adjust` (one-sided); system reasons are never accepted from a client.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize, authorizeWrite } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import {
  getPrincipal,
  isSuperAdmin,
  assertLocationAccess,
} from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseOptionalIdParam,
  requireId,
  requireNonNegativeNumber,
  requirePositiveNumber,
} from '../lib/validate.js';
import { applyMovement, type MovementReason } from '../services/stockMovement.js';

export const stockRouter: Router = Router();

/** Page size cap for movement history. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Valid `location_type` values for the `/api/stock?location_type=` filter
 * — must match the `location_type` enum in the database. D7 added
 * `sex_storage`; `supply` is kept as a DEPRECATED synonym for backward
 * compatibility with older clients.
 */
const LOCATION_TYPES = [
  'raw_warehouse',
  'production',
  'sex_storage',
  'supply',
  'central_warehouse',
  'store',
] as const;
type LocationType = (typeof LOCATION_TYPES)[number];

type StockRow = {
  location_id: number;
  product_id: number;
  qty: number;
  min_level: number;
  max_level: number;
  minmax_mode: string;
  updated_at: Date;
  product_name: string;
  product_unit: string;
  location_name: string;
};

/** Stock columns with the product + location JOIN — used by GET /api/stock. */
const STOCK_SELECT = `s.location_id, s.product_id, s.qty, s.min_level, s.max_level,
  s.minmax_mode, s.updated_at, p.name AS product_name, p.unit AS product_unit,
  l.name AS location_name`;

// GET /api/stock?location_id=&product_id=
stockRouter.get(
  '/',
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
    const locationIdParam = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const productIdParam = parseOptionalIdParam(
      typeof req.query.product_id === 'string' ? req.query.product_id : undefined,
      'product_id',
    );
    const locationTypeParam = parseOptionalLocationType(
      typeof req.query.location_type === 'string' ? req.query.location_type : undefined,
    );
    const belowMinOnly = req.query.below_min === 'true';

    // F4.6 — `location_type` filter aggregates every location of the given
    // type (raw_warehouse / production / supply / central_warehouse / store).
    // RBAC scoping: a scoped principal intersects the type set with its own
    // assigned `locationIds`. Mutually exclusive with `location_id`.
    if (locationTypeParam !== undefined) {
      if (locationIdParam !== undefined) {
        throw AppError.validation(
          'Use either "location_id" or "location_type", not both.',
        );
      }
      const params: (string | number | number[])[] = [locationTypeParam];
      let where = 'WHERE l.type = $1';
      if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
        if (principal.locationIds.length === 0) {
          res.status(200).json([]);
          return;
        }
        params.push(principal.locationIds);
        where += ` AND s.location_id = ANY($${params.length}::bigint[])`;
      }
      if (belowMinOnly) {
        where += ` AND s.qty < s.min_level AND s.min_level > 0`;
      }
      const { rows } = await query<StockRow>(
        `SELECT ${STOCK_SELECT}
         FROM stock s
         JOIN products p ON p.id = s.product_id
         JOIN locations l ON l.id = s.location_id
         ${where}
         ORDER BY s.location_id, s.product_id`,
        params,
      );

      res.status(200).json(rows);
      return;
    }

    // Decide the effective location filter from RBAC scope.
    let effectiveLocationId: number | undefined;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      effectiveLocationId = locationIdParam;
    } else {
      // A scoped manager is locked to its own location.
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      if (locationIdParam !== undefined && locationIdParam !== principal.locationId) {
        throw AppError.forbidden('You may only view stock for your own location.');
      }
      effectiveLocationId = principal.locationId;
    }

    // Build filter conditions combining location and optional product_id.
    const stockParams: (number | number[])[] = [];
    const stockConds: string[] = [];
    if (effectiveLocationId !== undefined) {
      stockParams.push(effectiveLocationId);
      stockConds.push(`s.location_id = $${stockParams.length}`);
    }
    if (productIdParam !== undefined) {
      stockParams.push(productIdParam);
      stockConds.push(`s.product_id = $${stockParams.length}`);
    }
    if (belowMinOnly) {
      stockConds.push(`s.qty < s.min_level AND s.min_level > 0`);
    }
    const stockWhere = stockConds.length > 0 ? `WHERE ${stockConds.join(' AND ')}` : '';
    const { rows } = await query<StockRow>(
      `SELECT ${STOCK_SELECT}
       FROM stock s
       JOIN products p ON p.id = s.product_id
       JOIN locations l ON l.id = s.location_id
       ${stockWhere}
       ORDER BY s.location_id, s.product_id`,
      stockParams,
    );
    // List endpoints return a bare array (spec section 4) — no envelope.
    res.status(200).json(rows);
  }),
);

// PATCH /api/stock/minmax
stockRouter.patch(
  '/minmax',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');
    const productId = requireId(body, 'product_id');
    const minLevel = requireNonNegativeNumber(body, 'min_level');
    const maxLevel = requireNonNegativeNumber(body, 'max_level');

    if (maxLevel < minLevel) {
      throw AppError.validation('max_level must be greater than or equal to min_level.');
    }
    assertLocationAccess(principal, locationId);

    // Upsert: a (location, product) pair may not yet have a stock row.
    const { rows } = await query<{
      location_id: number;
      product_id: number;
      qty: number;
      min_level: number;
      max_level: number;
      minmax_mode: string;
      updated_at: Date;
    }>(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 0, $3, $4)
       ON CONFLICT (location_id, product_id)
       DO UPDATE SET min_level = EXCLUDED.min_level, max_level = EXCLUDED.max_level
       RETURNING location_id, product_id, qty, min_level, max_level, minmax_mode, updated_at`,
      [locationId, productId, minLevel, maxLevel],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Stock minmax upsert returned no row.');
    }
    // `stock` PK is composite (location_id, product_id) — there is no single
    // scalar id, so entity_id stays null and the payload carries both keys.
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'stock.minmax.update',
      entity: 'stock',
      entityId: null,
      payload: {
        location_id: locationId,
        product_id: productId,
        min_level: minLevel,
        max_level: maxLevel,
      },
    });
    res.status(200).json({ stock: updated });
  }),
);

// PATCH /api/stock/minmax-mode — Phase-2 F2.1 dynamic/manual toggle.
//   Body: { location_id, product_id, mode: 'manual' | 'dynamic' }
//
// RBAC: pm everywhere; a scoped manager only on its own location. The
// row is upserted — a (location, product) pair without a stock row yet is
// created with qty=0 so the mode can be set up front (PM seeding the
// chain). The mode flip itself is durable: the next minmax_recalc cron
// pass will start (or stop) recalculating this row immediately.
stockRouter.patch(
  '/minmax-mode',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');
    const productId = requireId(body, 'product_id');
    const modeRaw = body.mode;
    if (modeRaw !== 'manual' && modeRaw !== 'dynamic') {
      throw AppError.validation('Field "mode" must be "manual" or "dynamic".');
    }
    const mode: 'manual' | 'dynamic' = modeRaw;
    assertLocationAccess(principal, locationId);

    const { rows } = await query<{
      location_id: number;
      product_id: number;
      qty: number;
      min_level: number;
      max_level: number;
      minmax_mode: string;
      updated_at: Date;
    }>(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
       VALUES ($1, $2, 0, 0, 0, $3)
       ON CONFLICT (location_id, product_id)
       DO UPDATE SET minmax_mode = EXCLUDED.minmax_mode
       RETURNING location_id, product_id, qty, min_level, max_level, minmax_mode, updated_at`,
      [locationId, productId, mode],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Stock minmax-mode upsert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'stock.minmax_mode.update',
      entity: 'stock',
      entityId: null,
      payload: { location_id: locationId, product_id: productId, mode },
    });
    res.status(200).json({ stock: updated });
  }),
);

// POST /api/stock/movement
//
// Owner-approved 2026-05-28: stock movement is a business write — PM is
// read-and-recommend. Only an operator who owns at least one endpoint
// of the movement may apply it.
stockRouter.post(
  '/movement',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const fromLocationId = optionalId(body, 'from_location_id') ?? null;
    const toLocationId = optionalId(body, 'to_location_id') ?? null;
    const qty = requirePositiveNumber(body, 'qty');
    const note = optionalString(body, 'note') ?? null;

    if (fromLocationId === null && toLocationId === null) {
      throw AppError.validation('A movement needs a from_location_id or a to_location_id.');
    }

    // A manual movement is only ever `transfer` (both endpoints) or `adjust`
    // (one endpoint). The system reasons — purchase / sale / production_* —
    // are set by M5/M6/M7 flows and must not arrive from a client.
    const reason = deriveManualReason(body, fromLocationId, toLocationId);

    // The operator must own at least one endpoint (M:N — ADR-0012).
    const touchesOwn =
      (fromLocationId !== null && principal.locationIds.includes(fromLocationId)) ||
      (toLocationId !== null && principal.locationIds.includes(toLocationId));
    if (!touchesOwn) {
      throw AppError.forbidden('A movement must involve your own location.');
    }

    const result = await applyMovement({
      productId,
      fromLocationId,
      toLocationId,
      qty,
      reason,
      note,
      actorUserId: principal.userId,
    });
    res.status(201).json({ movement_id: result.movementId });
  }),
);

type MovementRow = {
  id: number;
  product_id: number;
  from_location_id: number | null;
  to_location_id: number | null;
  qty: number;
  reason: string;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  product_name: string;
  product_unit: string;
  from_location_name: string | null;
  to_location_name: string | null;
};

// GET /api/stock/movements?location_id=&product_id=&limit=&offset=
stockRouter.get(
  '/movements',
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
    const locationIdParam = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const productIdParam = parseOptionalIdParam(
      typeof req.query.product_id === 'string' ? req.query.product_id : undefined,
      'product_id',
    );

    // RBAC: a scoped manager is forced to its own location filter.
    let scopeLocationId: number | undefined;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      scopeLocationId = locationIdParam;
    } else {
      if (principal.locationId === null) {
        res.status(200).json({ items: [], total: 0, limit: 0, offset: 0 });
        return;
      }
      if (locationIdParam !== undefined && locationIdParam !== principal.locationId) {
        throw AppError.forbidden('You may only view movements for your own location.');
      }
      scopeLocationId = principal.locationId;
    }

    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Filter conditions are shared by the COUNT and the page query.
    const conditions: string[] = [];
    const filterParams: (string | number)[] = [];
    if (scopeLocationId !== undefined) {
      filterParams.push(scopeLocationId);
      conditions.push(
        `(m.from_location_id = $${filterParams.length} OR m.to_location_id = $${filterParams.length})`,
      );
    }
    if (productIdParam !== undefined) {
      filterParams.push(productIdParam);
      conditions.push(`m.product_id = $${filterParams.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // `total` is the filtered row count (spec section 4) — drives pagination.
    const countResult = await query<{ total: string }>(
      `SELECT count(*) AS total FROM stock_movements m ${where}`,
      filterParams,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    // The page query embeds product + location names via JOINs (no N+1).
    const pageParams = [...filterParams, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows } = await query<MovementRow>(
      `SELECT m.id, m.product_id, m.from_location_id, m.to_location_id, m.qty,
              m.reason, m.note, m.created_by, m.created_at,
              p.name AS product_name, p.unit AS product_unit,
              fl.name AS from_location_name, tl.name AS to_location_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN locations fl ON fl.id = m.from_location_id
       LEFT JOIN locations tl ON tl.id = m.to_location_id
       ${where}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );
    // Paginated endpoint — the one list that keeps an envelope (spec section 4).
    res.status(200).json({ items: rows, total, limit, offset });
  }),
);

/**
 * Resolve the `reason` for a manual movement. The server derives it from the
 * endpoint shape — both locations -> `transfer`, one location -> `adjust`.
 * If the client sends a `reason`, it must match the derived value; a system
 * reason (purchase / sale / production_*) is rejected with a 422.
 */
function deriveManualReason(
  body: Record<string, unknown>,
  fromLocationId: number | null,
  toLocationId: number | null,
): MovementReason {
  const derived: MovementReason =
    fromLocationId !== null && toLocationId !== null ? 'transfer' : 'adjust';
  const sent = body.reason;
  if (sent !== undefined) {
    if (sent !== 'transfer' && sent !== 'adjust') {
      throw AppError.validation(
        'Manual movement "reason" must be "transfer" or "adjust"; system reasons are set by the system.',
      );
    }
    if (sent !== derived) {
      throw AppError.validation(
        derived === 'transfer'
          ? 'A two-sided movement must use reason "transfer".'
          : 'A one-sided movement must use reason "adjust".',
      );
    }
  }
  return derived;
}

/**
 * Parse a query-string `location_type` parameter. Returns `undefined` when
 * absent/empty; throws 422 when a value is provided but not a known type.
 */
function parseOptionalLocationType(raw: string | undefined): LocationType | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!(LOCATION_TYPES as readonly string[]).includes(raw)) {
    throw AppError.validation(
      `"location_type" must be one of: ${LOCATION_TYPES.join(', ')}.`,
    );
  }
  return raw as LocationType;
}

/** Parse a query value as an integer clamped to [min, max], else fallback. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}
