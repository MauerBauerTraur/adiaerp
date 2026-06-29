/**
 * M1 — Locations CRUD (spec section 4.2).
 *
 *   GET    /api/locations        — list (RBAC-filtered)
 *   GET    /api/locations/:id    — one location (own scope or pm)
 *   POST   /api/locations        — create (pm only)
 *   PATCH  /api/locations/:id    — edit (pm only)
 *
 * RBAC: pm sees the whole chain; a location-scoped manager sees only its own
 * location row. Every write is audit-logged (invariant 6).
 *
 * List responses are bare arrays (spec section 4); single-resource responses
 * keep the `{ location }` envelope.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireEnum,
  requireId,
  requireString,
} from '../lib/validate.js';

export const locationsRouter: Router = Router();

// D7 (2026-05-28) — `sex_storage` is the new canonical type for sex skladi.
// `supply` is kept as a DEPRECATED synonym so older clients (and the few
// remaining `supply`-typed rows in legacy fixtures) still validate. Migration
// 0022 already flipped every live row; the value will be dropped in a later
// sprint once the assistant tool layer and the frontend types follow.
const LOCATION_TYPES = [
  'raw_warehouse',
  'production',
  'sex_storage',
  'supply',
  'central_warehouse',
  'store',
] as const;

type LocationRow = {
  id: number;
  name: string;
  type: string;
  stage_role: 'final' | 'zagatovka' | null;
  parent_id: number | null;
  poster_spot_id: number | null;
  poster_storage_id: number | null;
  lead_time_days: string;
  review_days: string;
  safety_factor: string;
  manager_user_id: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `id, name, type, stage_role, parent_id, poster_spot_id, poster_storage_id,
  lead_time_days, review_days, safety_factor, manager_user_id, is_active,
  created_at, updated_at`;

// EPIC 2.1 — explicit M:N supply-chain flows (migration 0026). Must match the
// `flow_type` CHECK constraint in 0026_location_flows.sql.
const FLOW_TYPES = ['production_output', 'bom_input', 'forward', 'reverse'] as const;

type LocationFlowRow = {
  id: number;
  from_location_id: number;
  to_location_id: number;
  flow_type: string;
  note: string | null;
};

const FLOW_COLUMNS = 'id, from_location_id, to_location_id, flow_type, note';

// =============================================================================
// EPIC 2.1 — location flow CRUD (admin connection management, pm only).
//
// These routes are declared BEFORE `GET /api/locations/:id` so the literal
// `/flows` path is not swallowed by the `:id` param matcher (which would
// reject "flows" as a non-integer id).
// =============================================================================

// GET /api/locations/flows  — list every flow (pm only).
locationsRouter.get(
  '/flows',
  authenticate,
  authorize('pm'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<LocationFlowRow>(
      `SELECT ${FLOW_COLUMNS} FROM location_flows ORDER BY id`,
    );
    // List endpoint returns a bare array (spec section 4) — no envelope.
    res.status(200).json(rows);
  }),
);

// POST /api/locations/flows  — create one flow (pm only).
locationsRouter.post(
  '/flows',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const fromId = requireId(body, 'from_location_id');
    const toId = requireId(body, 'to_location_id');
    const flowType = requireEnum(body, 'flow_type', FLOW_TYPES);
    const note = optionalString(body, 'note');

    if (fromId === toId) {
      throw AppError.validation('Manba va qabul bo‘g‘ini bir xil bo‘la olmaydi.');
    }

    // Both endpoints must exist (the FK would also catch this, but a clean
    // 422 beats a 500 from a constraint violation).
    const { rows: found } = await query<{ id: number }>(
      'SELECT id FROM locations WHERE id = ANY($1::int[])',
      [[fromId, toId]],
    );
    const foundIds = new Set(found.map((r) => Number(r.id)));
    if (!foundIds.has(fromId) || !foundIds.has(toId)) {
      throw AppError.validation('One or both locations do not exist.');
    }

    // UNIQUE(from, to, flow_type) — surface a duplicate as 422, not 500.
    const dup = await query<{ id: number }>(
      `SELECT id FROM location_flows
        WHERE from_location_id = $1 AND to_location_id = $2 AND flow_type = $3`,
      [fromId, toId, flowType],
    );
    if (dup.rows.length > 0) {
      throw AppError.validation('This flow already exists.');
    }

    const { rows } = await query<LocationFlowRow>(
      `INSERT INTO location_flows (from_location_id, to_location_id, flow_type, note)
       VALUES ($1, $2, $3, $4)
       RETURNING ${FLOW_COLUMNS}`,
      [fromId, toId, flowType, note ?? null],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Location flow insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location_flow.create',
      entity: 'location_flows',
      entityId: created.id,
      payload: { from_location_id: fromId, to_location_id: toId, flow_type: flowType },
    });
    res.status(201).json({ flow: created });
  }),
);

// DELETE /api/locations/flows/:id  — remove one flow (pm only).
locationsRouter.delete(
  '/flows/:id',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const { rows } = await query<{ id: number }>(
      'DELETE FROM location_flows WHERE id = $1 RETURNING id',
      [id],
    );
    if (rows[0] === undefined) {
      throw AppError.notFound('Location flow not found.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location_flow.delete',
      entity: 'location_flows',
      entityId: id,
      payload: null,
    });
    res.status(204).end();
  }),
);

// GET /api/locations  — pm: all; scoped manager: only own location.
locationsRouter.get(
  '/',
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

    // F4.9 — optional `?type=` filter (frontend builds the production sub-
    // department tree by filtering on type and grouping by `parent_id`).
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
    if (typeRaw !== undefined && !(LOCATION_TYPES as readonly string[]).includes(typeRaw)) {
      throw AppError.validation(
        `Query "type" must be one of: ${LOCATION_TYPES.join(', ')}.`,
      );
    }

    // List endpoints return a bare array (spec section 4) — no envelope.
    if (isSuperAdmin(principal)) {
      const params: (string | number)[] = [];
      let where = '';
      if (typeRaw !== undefined) {
        params.push(typeRaw);
        where = `WHERE type = $${params.length}`;
      }
      const { rows } = await query<LocationRow>(
        `SELECT ${SELECT_COLUMNS} FROM locations ${where} ORDER BY id`,
        params,
      );
      res.status(200).json(rows);
      return;
    }
    // A scoped manager sees only its own location.
    if (principal.locationId === null) {
      res.status(200).json([]);
      return;
    }
    const params: (string | number)[] = [principal.locationId];
    let where = 'WHERE id = $1';
    if (typeRaw !== undefined) {
      params.push(typeRaw);
      where += ` AND type = $${params.length}`;
    }
    const { rows } = await query<LocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM locations ${where}`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// GET /api/locations/:id
locationsRouter.get(
  '/:id',
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
    const id = parseIdParam(req.params.id, 'id');
    if (!isSuperAdmin(principal) && principal.locationId !== id) {
      throw AppError.forbidden('You may only view your own location.');
    }
    const { rows } = await query<LocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM locations WHERE id = $1`,
      [id],
    );
    const location = rows[0];
    if (location === undefined) {
      throw AppError.notFound('Location not found.');
    }
    res.status(200).json({ location });
  }),
);

// POST /api/locations  — pm only.
locationsRouter.post(
  '/',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const name = requireString(body, 'name');
    const type = requireEnum(body, 'type', LOCATION_TYPES);
    const parentId = optionalId(body, 'parent_id');
    const posterSpotId = optionalId(body, 'poster_spot_id');
    const posterStorageId = optionalId(body, 'poster_storage_id');

    const { rows } = await query<LocationRow>(
      `INSERT INTO locations (name, type, parent_id, poster_spot_id, poster_storage_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [name, type, parentId ?? null, posterSpotId ?? null, posterStorageId ?? null],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Location insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location.create',
      entity: 'locations',
      entityId: created.id,
      payload: { name, type },
    });
    res.status(201).json({ location: created });
  }),
);

// PATCH /api/locations/:id  — pm only.
locationsRouter.patch(
  '/:id',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // Build a partial update from the keys actually present.
    const sets: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    let i = 1;
    const add = (column: string, value: string | number | boolean | null): void => {
      sets.push(`${column} = $${i}`);
      params.push(value);
      i += 1;
    };

    const name = optionalString(body, 'name');
    if (name !== undefined) {
      add('name', name);
    }
    if ('manager_user_id' in body) {
      add('manager_user_id', optionalId(body, 'manager_user_id') ?? null);
    }
    if ('parent_id' in body) {
      add('parent_id', optionalId(body, 'parent_id') ?? null);
    }
    if ('is_active' in body) {
      const active = body.is_active;
      if (typeof active !== 'boolean') {
        throw AppError.validation('Field "is_active" must be a boolean.');
      }
      add('is_active', active);
    }
    // Phase-2 dynamic min/max tuning inputs (spec section 4.2, TZ 8.3).
    for (const column of ['lead_time_days', 'review_days', 'safety_factor'] as const) {
      if (column in body) {
        const raw = body[column];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
          throw AppError.validation(`Field "${column}" must be a non-negative number.`);
        }
        add(column, raw);
      }
    }
    if (sets.length === 0) {
      throw AppError.validation('No editable fields provided.');
    }

    params.push(id);
    const { rows } = await query<LocationRow>(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.notFound('Location not found.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location.update',
      entity: 'locations',
      entityId: id,
      payload: { fields: sets },
    });
    res.status(200).json({ location: updated });
  }),
);
