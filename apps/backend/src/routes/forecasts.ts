/**
 * Forecasts read API — Faza-3 Sprint 4 (F3.4, ADR-0010).
 *
 *   GET  /api/forecasts                    — list forecasts (RBAC scoped).
 *   POST /api/admin/forecasts/recalc       — manual sidecar trigger (PM).
 *                                            Lives in admin.ts; this file
 *                                            owns the read endpoint.
 *
 * RBAC contract (mirrors the AI `get_forecast` tool, ADR-0010 §"AI tool"):
 *
 *   * PM sees every (location, product) pair.
 *   * Every other role with a JWT-bound `locationId` sees only their own
 *     location's forecasts. A scoped caller that passes `?location_id=`
 *     for a foreign id is silently filtered (no data leak); the model
 *     equivalent is the same pattern as the read-tool layer.
 *
 * Staleness flag: `generated_at > 24h ago` flips `stale: true`. The
 * dashboard widget uses this to show an "ESKI" badge instead of hiding
 * stale rows (ADR-0010 §"Cache strategiyasi"). Phase-2 cron writes daily,
 * so the only path to `stale=true` is a sidecar outage.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import type { SqlParam } from '../db/index.js';

export const forecastsRouter: Router = Router();

const STALE_AFTER_HOURS = 24;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

type ForecastRow = {
  location_id: string;
  location_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  daily_predictions: unknown;
  expected_stockout_date: Date | null;
  generated_at: Date;
  source: string;
};

forecastsRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);

    const params: SqlParam[] = [];
    const conditions: string[] = [];

    // RBAC scope (server-side; never trust the query string).
    if (!isSuperAdmin(principal)) {
      if (principal.locationId === null) {
        // No location bound to the JWT → return an empty list (cannot
        // resolve "your own location").
        res.status(200).json({ items: [], total: 0, limit: 0, offset: 0 });
        return;
      }
      params.push(principal.locationId);
      conditions.push(`f.location_id = $${params.length}`);
    } else if (typeof req.query.location_id === 'string' && req.query.location_id !== '') {
      const locParsed = Number(req.query.location_id);
      if (!Number.isInteger(locParsed) || locParsed <= 0) {
        throw AppError.validation('Query "location_id" must be a positive integer.');
      }
      params.push(locParsed);
      conditions.push(`f.location_id = $${params.length}`);
    }

    if (typeof req.query.product_id === 'string' && req.query.product_id !== '') {
      const prodParsed = Number(req.query.product_id);
      if (!Number.isInteger(prodParsed) || prodParsed <= 0) {
        throw AppError.validation('Query "product_id" must be a positive integer.');
      }
      params.push(prodParsed);
      conditions.push(`f.product_id = $${params.length}`);
    }

    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const countResult = await query<{ total: string }>(
      `SELECT count(*) AS total FROM forecasts f ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows } = await query<ForecastRow>(
      `SELECT f.location_id::text AS location_id,
              l.name              AS location_name,
              f.product_id::text  AS product_id,
              p.name              AS product_name,
              p.unit::text        AS product_unit,
              f.daily_predictions,
              f.expected_stockout_date,
              f.generated_at,
              f.source
         FROM forecasts f
         JOIN locations l ON l.id = f.location_id
         JOIN products  p ON p.id = f.product_id
         ${where}
         ORDER BY f.expected_stockout_date ASC NULLS LAST,
                  l.name, p.name
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );

    const nowMs = Date.now();
    const staleThreshold = STALE_AFTER_HOURS * 60 * 60 * 1000;
    const items = rows.map((r) => ({
      location_id: Number(r.location_id),
      location_name: r.location_name,
      product_id: Number(r.product_id),
      product_name: r.product_name,
      product_unit: r.product_unit,
      daily_predictions: r.daily_predictions,
      expected_stockout_date:
        r.expected_stockout_date === null
          ? null
          : (r.expected_stockout_date instanceof Date
              ? r.expected_stockout_date.toISOString().slice(0, 10)
              : String(r.expected_stockout_date).slice(0, 10)),
      generated_at:
        r.generated_at instanceof Date
          ? r.generated_at.toISOString()
          : String(r.generated_at),
      source: r.source,
      stale:
        r.generated_at instanceof Date
          ? nowMs - r.generated_at.getTime() > staleThreshold
          : false,
    }));

    res.status(200).json({ items, total, limit, offset });
  }),
);

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
