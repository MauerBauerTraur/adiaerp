/**
 * Phase-2 admin endpoints — PM-only operations.
 *
 *   POST /api/admin/recalc-minmax        — manual trigger for the dynamic
 *                                          min/max recalc (TZ §8.3, F2.1).
 *   GET  /api/admin/import-warnings      — list import / sync warnings.
 *   POST /api/admin/import-warnings/:id/resolve — mark one warning resolved.
 *
 * Every endpoint requires `pm`. Each write writes an audit_log row (the
 * recalc cron itself audits per-row; the trigger endpoint additionally
 * audits the human action so the audit feed answers "who pressed the
 * button at 14:32").
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  parseIdParam,
  parseOptionalIdParam,
} from '../lib/validate.js';
import { runMinmaxRecalcCycle } from '../workers/minmaxRecalcCron.js';
import { runForecastRefreshCycle } from '../workers/forecastRefreshCron.js';
import { loadConfig } from '../config/index.js';

export const adminRouter: Router = Router();

// -----------------------------------------------------------------------------
// POST /api/admin/recalc-minmax
// -----------------------------------------------------------------------------
//
// Trigger the dynamic min/max recalc on demand. The optional body filter
// narrows the work to one location and/or product (PM "fix this row now"
// flow). Without a filter every `minmax_mode='dynamic'` row is processed.
//
// Synchronous: the handler waits for the cycle to finish and returns the
// summary. The spec budget is ~5s for the typical ~5_000-row chain; if a
// future ERP scales past that, we promote the endpoint to async-job mode.
adminRouter.post(
  '/recalc-minmax',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    // Body filter is optional — accept both an empty body and the documented
    // `{ location_id?, product_id? }` shape.
    const body = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const locationId = optionalId(body, 'location_id');
    const productId = optionalId(body, 'product_id');

    const summary = await runMinmaxRecalcCycle(
      {
        ...(locationId !== undefined ? { locationId } : {}),
        ...(productId !== undefined ? { productId } : {}),
      },
      principal.userId,
    );

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'admin.recalc_minmax.trigger',
      entity: 'stock.minmax',
      entityId: null,
      payload: {
        filter: { location_id: locationId ?? null, product_id: productId ?? null },
        summary,
      },
    });
    res.status(200).json(summary);
  }),
);

// -----------------------------------------------------------------------------
// POST /api/admin/forecasts/recalc  (F3.4 / ADR-0010)
// -----------------------------------------------------------------------------
//
// Manual trigger for the Prophet forecast refresh. Synchronous like the
// minmax trigger — waits for the whole batch and returns the summary. On a
// disabled sidecar (no FORECASTER_URL / shared secret) returns 503 so the
// PM sees "feature unavailable" instead of a silent no-op.
adminRouter.post(
  '/forecasts/recalc',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.forecaster.enabled) {
      throw AppError.serviceUnavailable(
        'Forecaster sidecar is not configured (FORECASTER_URL / FORECASTER_SHARED_SECRET).',
      );
    }
    const principal = getPrincipal(req);
    const summary = await runForecastRefreshCycle(principal.userId);
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'admin.forecasts.recalc.trigger',
      entity: 'forecasts',
      entityId: null,
      payload: { summary },
    });
    res.status(200).json(summary);
  }),
);

// -----------------------------------------------------------------------------
// GET /api/admin/import-warnings?source=&resolved=&severity=&limit=&offset=
// -----------------------------------------------------------------------------

type WarningRow = {
  id: number;
  source: string;
  entity: string | null;
  severity: string;
  message: string;
  payload: unknown;
  resolved: boolean;
  resolved_at: Date | null;
  resolved_by: number | null;
  created_at: Date;
};

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

adminRouter.get(
  '/import-warnings',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const source = typeof req.query.source === 'string' && req.query.source !== ''
      ? req.query.source
      : undefined;
    const severity = typeof req.query.severity === 'string' && req.query.severity !== ''
      ? req.query.severity
      : undefined;
    if (severity !== undefined && severity !== 'info' && severity !== 'warning' && severity !== 'error') {
      throw AppError.validation('Query "severity" must be one of info, warning, error.');
    }
    const resolvedRaw = typeof req.query.resolved === 'string' ? req.query.resolved : undefined;
    const resolvedFilter =
      resolvedRaw === 'true' ? true : resolvedRaw === 'false' ? false : undefined;

    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const conds: string[] = [];
    const params: (string | number | boolean)[] = [];
    if (source !== undefined) {
      params.push(source);
      conds.push(`source = $${params.length}`);
    }
    if (severity !== undefined) {
      params.push(severity);
      conds.push(`severity = $${params.length}`);
    }
    if (resolvedFilter !== undefined) {
      params.push(resolvedFilter);
      conds.push(`resolved = $${params.length}`);
    }
    const where = conds.length === 0 ? '' : `WHERE ${conds.join(' AND ')}`;

    const countResult = await query<{ total: string }>(
      `SELECT count(*) AS total FROM import_warnings ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows } = await query<WarningRow>(
      `SELECT id, source, entity, severity, message, payload,
              resolved, resolved_at, resolved_by, created_at
         FROM import_warnings
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );
    res.status(200).json({ items: rows, total, limit, offset });
  }),
);

// -----------------------------------------------------------------------------
// POST /api/admin/import-warnings/:id/resolve
// -----------------------------------------------------------------------------

adminRouter.post(
  '/import-warnings/:id/resolve',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const { rows } = await query<WarningRow>(
      `UPDATE import_warnings
          SET resolved = TRUE, resolved_at = now(), resolved_by = $2
        WHERE id = $1 AND resolved = FALSE
        RETURNING id, source, entity, severity, message, payload,
                  resolved, resolved_at, resolved_by, created_at`,
      [id, principal.userId],
    );
    const updated = rows[0];
    if (updated === undefined) {
      // Either the row does not exist or it was already resolved — both 404.
      throw AppError.notFound('Import warning not found or already resolved.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'admin.import_warning.resolve',
      entity: 'import_warnings',
      entityId: id,
      payload: { id },
    });
    res.status(200).json({ warning: updated });
  }),
);

// Re-export of `parseOptionalIdParam` keeps the import set explicit; remove if
// the helper is not needed by a future endpoint in this file.
void parseOptionalIdParam;

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
