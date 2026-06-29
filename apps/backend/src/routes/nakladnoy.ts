/**
 * EPIC 8.4 — nakladnoy (material requisition) API.
 *
 *   POST /api/nakladnoy            { product_id, qty, location_id?, source?, note? }
 *        -> generate + persist a sectioned material nakladnoy from the BOM.
 *   GET  /api/nakladnoy            ?location_id=&limit=
 *        -> list recent nakladnoy headers (RBAC-scoped).
 *   GET  /api/nakladnoy/:id        -> one header + its lines.
 *
 * RBAC: generation is a WRITE — the caller must operate the target location
 * (`requireLocationOperator`), so PM is read-and-recommend (blocked from POST).
 * Reads are scoped: a non-PM principal sees only nakladnoy for its own
 * locations. The nakladnoy itself NEVER mutates stock or touches Poster.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { poolRunner } from '../lib/audit.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getEffectiveLocationIds,
  getPrincipal,
  requireLocationOperator,
} from '../lib/principal.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import { AppError } from '../errors/index.js';
import {
  createNakladnoy,
  getNakladnoy,
  toNakladnoyDto,
  type NakladnoySource,
} from '../services/nakladnoy.js';

export const nakladnoyRouter: Router = Router();

/**
 * Shared read scope for both nakladnoy read endpoints, so the list and the
 * single-document fetch make the IDENTICAL RBAC decision (incl. the
 * `ai_assistant` and `activeLocationId`-narrowing behaviour):
 *
 *   - `null`  -> chain-wide (PM/super-admin): no location filter.
 *   - `[]`    -> scoped principal with no assigned locations: sees nothing.
 *   - `[..]`  -> the location ids this principal may read.
 */
function nakladnoyReadScope(principal: AuthPrincipal): number[] | null {
  return getEffectiveLocationIds(principal);
}

/** Whether a scoped principal may read a single nakladnoy at `locationId`. */
function canReadNakladnoyLocation(
  scope: number[] | null,
  locationId: number | null,
): boolean {
  if (scope === null) return true; // chain-wide
  if (locationId === null) return false; // location-less doc, scoped principal
  return scope.includes(locationId);
}

const ALLOWED_SOURCES: readonly NakladnoySource[] = [
  'sale',
  'manual',
  'voice',
  'production_order',
];

// POST /api/nakladnoy — generate from a product demand.
nakladnoyRouter.post(
  '/',
  authenticate,
  authorize('production_manager', 'central_warehouse_manager', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const locationId = optionalId(body, 'location_id') ?? principal.activeLocationId;
    if (locationId === null || locationId === undefined) {
      throw AppError.validation('location_id is required (no active location).');
    }
    // WRITE RBAC — the operator must own the target location.
    await requireLocationOperator(principal, locationId);

    const sourceRaw = optionalString(body, 'source');
    const source: NakladnoySource =
      sourceRaw !== undefined && (ALLOWED_SOURCES as readonly string[]).includes(sourceRaw)
        ? (sourceRaw as NakladnoySource)
        : 'manual';
    const note = optionalString(body, 'note') ?? null;

    const result = await createNakladnoy({
      source,
      productId,
      qty,
      locationId,
      note,
      actorUserId: principal.userId,
    });
    res.status(201).json(result);
  }),
);

// GET /api/nakladnoy — recent headers (RBAC-scoped).
nakladnoyRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager', 'store_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const scope = nakladnoyReadScope(principal);

    const params: Array<number | number[]> = [];
    let where = '';
    if (scope !== null) {
      // A scoped principal only sees its own locations' documents. An empty
      // assigned set yields NO rows (rather than leaking everything).
      if (scope.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }
      params.push(scope);
      where = `WHERE n.location_id = ANY($1::bigint[])`;
    }
    params.push(limit);
    // Headers + resolved product/store names in one pass (LEFT JOIN — a
    // multi-product or location-less nakladnoy keeps NULLs).
    const { rows: headerRows } = await query<{
      id: string;
      product_id: string | null;
      product_name: string | null;
      qty: string;
      location_id: string | null;
      store_name: string | null;
      created_at: Date | string;
    }>(
      `SELECT n.id, n.product_id, p.name AS product_name, n.qty,
              n.location_id, l.name AS store_name, n.created_at
         FROM nakladnoy n
         LEFT JOIN products  p ON p.id = n.product_id
         LEFT JOIN locations l ON l.id = n.location_id
         ${where}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $${params.length}`,
      params,
    );

    if (headerRows.length === 0) {
      res.status(200).json({ items: [] });
      return;
    }

    // Lines for the whole page in one query, grouped in memory.
    const ids = headerRows.map((r) => Number(r.id));
    const { rows: lineRows } = await query<{
      nakladnoy_id: string;
      section: 'hamir' | 'krem' | 'bezak' | 'itogo';
      component_product_id: string | null;
      label: string;
      qty: string;
      unit: string;
    }>(
      `SELECT nakladnoy_id, section::text AS section, component_product_id,
              label, qty, unit
         FROM nakladnoy_lines
        WHERE nakladnoy_id = ANY($1::bigint[])
        ORDER BY id`,
      [ids],
    );
    const linesByDoc = new Map<number, typeof lineRows>();
    for (const lr of lineRows) {
      const key = Number(lr.nakladnoy_id);
      const arr = linesByDoc.get(key) ?? [];
      arr.push(lr);
      linesByDoc.set(key, arr);
    }

    const items = headerRows.map((h) => {
      const id = Number(h.id);
      const lines = (linesByDoc.get(id) ?? []).map((l) => ({
        section: l.section,
        component_product_id:
          l.component_product_id === null ? null : Number(l.component_product_id),
        label: l.label,
        qty: Number(l.qty),
        unit: l.unit,
      }));
      return toNakladnoyDto({
        header: {
          id,
          source: 'manual',
          source_ref: null,
          product_id: h.product_id === null ? null : Number(h.product_id),
          qty: Number(h.qty),
          location_id: h.location_id === null ? null : Number(h.location_id),
          total_amount: 0,
          created_by: null,
          created_at:
            h.created_at instanceof Date
              ? h.created_at.toISOString()
              : String(h.created_at),
        },
        lines,
        productName: h.product_name ?? '',
        storeName: h.store_name,
      });
    });
    res.status(200).json({ items });
  }),
);

// GET /api/nakladnoy/:id — header + lines.
nakladnoyRouter.get(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager', 'store_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'nakladnoy id');
    const result = await getNakladnoy(id, poolRunner);
    if (result === null) {
      throw AppError.notFound('Nakladnoy not found.');
    }
    // Scope guard — identical RBAC decision as the list endpoint (shared helper).
    const scope = nakladnoyReadScope(principal);
    if (!canReadNakladnoyLocation(scope, result.header.location_id)) {
      throw AppError.forbidden('You may only read nakladnoy for your own location.');
    }
    // Resolve product/store names for the frontend `Nakladnoy` contract.
    const { rows: nameRows } = await query<{
      product_name: string | null;
      store_name: string | null;
    }>(
      `SELECT p.name AS product_name, l.name AS store_name
         FROM nakladnoy n
         LEFT JOIN products  p ON p.id = n.product_id
         LEFT JOIN locations l ON l.id = n.location_id
        WHERE n.id = $1`,
      [id],
    );
    const dto = toNakladnoyDto({
      header: result.header,
      lines: result.lines,
      productName: nameRows[0]?.product_name ?? '',
      storeName: nameRows[0]?.store_name ?? null,
    });
    res.status(200).json(dto);
  }),
);
