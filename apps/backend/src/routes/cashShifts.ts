/**
 * EPIC 8.5 — GET /api/cash-shifts (kassa smenasi close-out).
 *
 *   GET /api/cash-shifts?range=today|week|month|custom&from=&to=&store_id=
 *
 * Read-only window onto Poster `finance.getCashshifts`, mapped to the frontend
 * `CashShift` contract (savdo / naqd / karta / rasxod / inkassatsiya / qoldiq +
 * kniжный/факт farq). RBAC mirrors the sales endpoints: PM + ai_assistant see
 * every store; a scoped principal (store_manager, etc.) is locked to its
 * assigned `locationIds`. Poster stays read-only — nothing is written back.
 *
 * Envelope: `{ items: CashShift[] }`.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError } from '../errors/index.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseOptionalIdParam } from '../lib/validate.js';
import { parseDateRange, toPosterDate } from '../lib/dateRange.js';
import { listCashShifts } from '../services/cashShift.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';

export const cashShiftsRouter: Router = Router();

cashShiftsRouter.get(
  '/',
  authenticate,
  authorize('pm', 'store_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range = parseDateRange(req.query);
    const storeIdParam = parseOptionalIdParam(
      typeof req.query.store_id === 'string' ? req.query.store_id : undefined,
      'store_id',
    );

    // RBAC scoping — parity with GET /api/sales/receipts.
    let storeIds: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeIds = storeIdParam === undefined ? null : [storeIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }
      if (storeIdParam !== undefined) {
        if (!principal.locationIds.includes(storeIdParam)) {
          throw AppError.forbidden('You may only view cash shifts for your own location.');
        }
        storeIds = [storeIdParam];
      } else {
        storeIds = principal.locationIds;
      }
    }

    const poster = createPosterClientFromConfig();
    const items = await listCashShifts(poster, {
      dateFrom: toPosterDate(range.from),
      // `to` is the exclusive upper bound; step back a ms so the YYYYMMDD day
      // is the last full day in the window.
      dateTo: toPosterDate(new Date(range.to.getTime() - 1)),
      storeIds,
    });
    res.status(200).json({ items });
  }),
);
