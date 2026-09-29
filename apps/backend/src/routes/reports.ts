/**
 * Reports — aggregated analytical queries for PM/super_admin.
 *
 *   GET /api/reports/profit  — production profit report by product
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD (required)
 *     Returns production orders (status='done') in the date range grouped
 *     by product, with cost_price, production_cost, sell_price, foyda, sof_foyda.
 *
 *   GET /api/reports/store-sales — "Do'konlar sotuvi", each store's sales
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD (required), read from Poster's reports.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { loadConfig } from '../config/index.js';
import { createPosterClientFromConfig } from '../integrations/poster/client.js';
import { redactUrl } from '../integrations/poster/syncLog.js';
import { buildStoreSalesReport } from '../services/storeSalesReport.js';
import { buildProductionDailyReport, fetchPosterSupplies } from '../services/productionDailyReport.js';

export const reportsRouter: Router = Router();

/** Longest period one store-sales request may cover (Poster call volume). */
const STORE_SALES_MAX_DAYS = 62;

/** Validate ?from&to (YYYY-MM-DD, ordered, at most `maxDays`) and return them. */
function parsePeriod(query: Record<string, unknown>, maxDays: number): { from: string; to: string } {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof query.from === 'string' ? query.from : '';
  const to = typeof query.to === 'string' ? query.to : '';
  if (!datePattern.test(from) || !datePattern.test(to)) {
    throw AppError.validation('"from" va "to" sanalari kerak (YYYY-MM-DD).');
  }
  if (from > to) {
    throw AppError.validation("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas.");
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > maxDays) {
    throw AppError.validation(`Bir so'rovda ko'pi bilan ${maxDays} kunlik davr tanlash mumkin.`);
  }
  return { from, to };
}

// GET /api/reports/production-daily?from&to — the production half of the
// daily report for management (orders, output, cost/profit, otdels,
// warehouses, supplier deliveries).
reportsRouter.get(
  '/production-daily',
  authenticate,
  authorize('pm', 'super_admin'),
  asyncHandler(async (req, res) => {
    const { from, to } = parsePeriod(req.query, STORE_SALES_MAX_DAYS);
    const loadSupplies =
      loadConfig().poster.token === ''
        ? null
        : () => fetchPosterSupplies(createPosterClientFromConfig(), from, to);
    res.status(200).json(await buildProductionDailyReport(from, to, loadSupplies));
  }),
);

reportsRouter.get(
  '/store-sales',
  authenticate,
  authorize('pm', 'super_admin'),
  asyncHandler(async (req, res) => {
    const { from, to } = parsePeriod(req.query, STORE_SALES_MAX_DAYS);
    if (loadConfig().poster.token === '') {
      throw AppError.posterSync("Poster ulanmagan: serverda POSTER_TOKEN sozlanmagan.");
    }
    try {
      res.status(200).json(await buildStoreSalesReport(createPosterClientFromConfig(), from, to));
    } catch (err) {
      if (err instanceof AppError) throw err;
      const detail = redactUrl(err instanceof Error ? err.message : String(err));
      throw AppError.posterSync(`Poster'dan sotuv ma'lumotini olib bo'lmadi: ${detail}`);
    }
  }),
);

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
