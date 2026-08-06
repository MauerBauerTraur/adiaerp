/**
 * Reports — aggregated analytical queries for PM/super_admin.
 *
 *   GET /api/reports/profit  — production profit report by product
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD (required)
 *     Returns production orders (status='done') in the date range grouped
 *     by product, with cost_price, production_cost, sell_price, foyda, sof_foyda.
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
      production_cost: string | null;
      sell_price: string | null;
    }>(
      `SELECT
         p.id               AS product_id,
         p.name             AS product_name,
         p.unit             AS product_unit,
         SUM(po.qty)        AS total_qty,
         p.cost_price,
         p.production_cost,
         p.sell_price
       FROM production_orders po
       JOIN products p ON po.product_id = p.id
       WHERE po.status = 'done'
         AND (
           po.deadline BETWEEN $1 AND $2
           OR (po.deadline IS NULL AND po.updated_at::date BETWEEN $1 AND $2)
         )
       GROUP BY p.id, p.name, p.unit, p.cost_price, p.production_cost, p.sell_price
       ORDER BY p.name`,
      [fromDate, toDate],
    );

    // JS name matching to fill missing production_cost / sell_price from same-named products.
    // SQL LOWER(TRIM()) fails for Cyrillic encoding mismatches; normalize('NFC') is safe.
    const { rows: allProducts } = await query<{
      name: string;
      production_cost: number | null;
      sell_price: number | null;
      has_poster_product_id: boolean;
    }>(
      `SELECT p.name,
              p.production_cost::float AS production_cost,
              p.sell_price::float AS sell_price,
              (p.poster_product_id IS NOT NULL) AS has_poster_product_id
       FROM products p
       WHERE p.type IN ('semi', 'finished', 'gp')`,
    );

    // Strip everything except letters and digits — handles "/" vs "∕", "()" vs " ", etc.
    const norm = (s: string) =>
      s.normalize('NFC').toLowerCase().replace(/[^\p{L}\d]/gu, '');

    type PInfo = { production_cost: number | null; sell_price: number | null; has_poster_product_id: boolean };
    const byName = new Map<string, PInfo[]>();
    for (const p of allProducts) {
      const key = norm(p.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(p);
    }

    const items = rows.map((row) => {
      const qty = Number(row.total_qty);
      const costPrice = row.cost_price != null ? Number(row.cost_price) : null;
      const partners = byName.get(norm(row.product_name)) ?? [];

      // production_cost: direct first, then any same-named partner that has it
      let productionCost = row.production_cost != null ? Number(row.production_cost) : null;
      if (productionCost == null) {
        const withProd = partners
          .filter((p) => p.production_cost != null)
          .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
        if (withProd[0]?.production_cost != null) productionCost = Number(withProd[0].production_cost);
      }

      // sell_price: direct first, then any same-named partner that has it
      let sellPrice = row.sell_price != null ? Number(row.sell_price) : null;
      if (sellPrice == null) {
        const withSell = partners
          .filter((p) => p.sell_price != null && p.sell_price > 0)
          .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
        if (withSell[0]?.sell_price != null) sellPrice = Number(withSell[0].sell_price);
      }

      // Gross foyda = sotuv narxi - Poster xarid narxi (cost_price)
      const foydaPerUnit =
        costPrice != null && sellPrice != null ? sellPrice - costPrice : null;
      const totalFoyda = foydaPerUnit != null ? foydaPerUnit * qty : null;

      // Sof foyda = sotuv narxi - ishlab chiqarish narxi (production_cost)
      const sofFoydaPerUnit =
        productionCost != null && sellPrice != null ? sellPrice - productionCost : null;
      const totalSofFoyda = sofFoydaPerUnit != null ? sofFoydaPerUnit * qty : null;

      return {
        product_id: row.product_id,
        product_name: row.product_name,
        product_unit: row.product_unit,
        total_qty: qty,
        cost_price: costPrice,
        production_cost: productionCost,
        sell_price: sellPrice,
        foyda_per_unit: foydaPerUnit,
        total_foyda: totalFoyda,
        sof_foyda_per_unit: sofFoydaPerUnit,
        total_sof_foyda: totalSofFoyda,
      };
    });

    res.json({ items, from: fromDate, to: toDate });
  }),
);
