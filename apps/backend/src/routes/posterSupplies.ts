/**
 * M10 — GET  /api/poster-supplies          — paginated supply list with items
 *        POST /api/poster-supplies/sync     — trigger a manual sync for a date range
 *
 * Each supply row includes its ingredient lines so the frontend can show
 * "which raw material → which storage, qty, price" without a second call.
 *
 * RBAC: pm, super_admin, raw_warehouse_manager.
 * Date range: standard `?range=today|week|month|6m|custom&from=&to=`.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPool } from '../db/pool.js';
import { parseDateRange, toPosterDate } from '../lib/dateRange.js';
import { syncPosterSupplies } from '../integrations/poster/suppliesSync.js';

export const posterSuppliesRouter: Router = Router();

// ---------------------------------------------------------------------------
// GET /api/poster-supplies?range=month  (or week|today|6m|custom&from=&to=)
// Optional: storage_id=2 to filter by a specific Poster storage.
// ---------------------------------------------------------------------------
posterSuppliesRouter.get(
  '/',
  authenticate,
  authorize('pm', 'super_admin', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const range = parseDateRange(req.query);

    const storageId =
      typeof req.query.storage_id === 'string' && req.query.storage_id !== ''
        ? parseInt(req.query.storage_id, 10)
        : null;

    const binds: (Date | number)[] = [range.from, range.to];
    const conditions = ['ps.supply_date >= $1', 'ps.supply_date < $2'];

    if (storageId !== null && !Number.isNaN(storageId)) {
      binds.push(storageId);
      conditions.push(`ps.storage_id = $${binds.length}`);
    }

    const where = conditions.join(' AND ');

    const { rows: supplies } = await pool.query<{
      id: number;
      storage_id: number;
      storage_name: string | null;
      supplier_id: number | null;
      supplier_name: string | null;
      supply_date: string;
      supply_sum: number;
      comment: string | null;
    }>(
      `SELECT id, storage_id, storage_name, supplier_id, supplier_name,
              supply_date, supply_sum, comment
         FROM poster_supplies ps
        WHERE ${where}
        ORDER BY supply_date DESC
        LIMIT 500`,
      binds,
    );

    if (supplies.length === 0) {
      return res.json({ items: [] });
    }

    const supplyIds = supplies.map((s) => s.id);
    const { rows: allItems } = await pool.query<{
      supply_id: number;
      ingredient_id: number;
      ingredient_name: string;
      ingredient_unit: string;
      qty: number;
      item_sum: number;
    }>(
      `SELECT supply_id, ingredient_id, ingredient_name, ingredient_unit, qty, item_sum
         FROM poster_supply_items
        WHERE supply_id = ANY($1)
        ORDER BY supply_id, ingredient_name`,
      [supplyIds],
    );

    const itemsBySupply = new Map<number, typeof allItems>();
    for (const item of allItems) {
      const list = itemsBySupply.get(item.supply_id) ?? [];
      list.push(item);
      itemsBySupply.set(item.supply_id, list);
    }

    return res.json({
      items: supplies.map((s) => ({
        ...s,
        items: itemsBySupply.get(s.id) ?? [],
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/poster-supplies/sync
// Body (optional): { range: "month" | "week" | ... } or { from: "YYYY-MM-DD", to: "...", range: "custom" }
// Defaults to last 30 days (month).
// ---------------------------------------------------------------------------
posterSuppliesRouter.post(
  '/sync',
  authenticate,
  authorize('pm', 'super_admin'),
  asyncHandler(async (req, res) => {
    const rangeParam = {
      range: req.body?.range ?? 'month',
      from: req.body?.from,
      to: req.body?.to,
    };
    const range = parseDateRange(rangeParam);
    const dateFrom = toPosterDate(range.from);
    const dateTo   = toPosterDate(range.to);

    const result = await syncPosterSupplies(dateFrom, dateTo);
    return res.json({ ok: true, ...result });
  }),
);
