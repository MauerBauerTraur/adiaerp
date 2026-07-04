/**
 * Reports — aggregated analytical queries for PM/super_admin.
 *
 *   GET /api/reports/profit  — production profit report by product
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD (required)
 *     Returns production orders (status='done') in the date range grouped
 *     by product, with cost_price, sell_price, and computed foyda.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const reportsRouter: Router = Router();

reportsRouter.get(
  '/profit',
  authenticate,
  authorize('pm', 'super_admin'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;

    const fromDate =
      typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
    const toDate =
      typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null;

    if (!fromDate || !toDate) {
      throw AppError.validation(
        'Query params "from" and "to" are required (YYYY-MM-DD).',
      );
    }

    const { rows } = await query<{
      product_id: number;
      product_name: string;
      product_unit: string;
      total_qty: string;
      cost_price: string | null;
      sell_price: string | null;
    }>(
      `SELECT
         p.id           AS product_id,
         p.name         AS product_name,
         p.unit         AS product_unit,
         SUM(po.qty)    AS total_qty,
         p.cost_price,
         p.sell_price
       FROM production_orders po
       JOIN products p ON po.product_id = p.id
       WHERE po.status = 'done'
         AND (
           po.deadline BETWEEN $1 AND $2
           OR (po.deadline IS NULL AND po.updated_at::date BETWEEN $1 AND $2)
         )
       GROUP BY p.id, p.name, p.unit, p.cost_price, p.sell_price
       ORDER BY p.name`,
      [fromDate, toDate],
    );

    const items = rows.map((row) => {
      const qty = Number(row.total_qty);
      const costPrice = row.cost_price != null ? Number(row.cost_price) : null;
      const sellPrice = row.sell_price != null ? Number(row.sell_price) : null;
      const foydaPerUnit =
        costPrice != null && sellPrice != null ? sellPrice - costPrice : null;
      const totalFoyda = foydaPerUnit != null ? foydaPerUnit * qty : null;

      return {
        product_id: row.product_id,
        product_name: row.product_name,
        product_unit: row.product_unit,
        total_qty: qty,
        cost_price: costPrice,
        sell_price: sellPrice,
        foyda_per_unit: foydaPerUnit,
        total_foyda: totalFoyda,
      };
    });

    res.json({ items, from: fromDate, to: toDate });
  }),
);
