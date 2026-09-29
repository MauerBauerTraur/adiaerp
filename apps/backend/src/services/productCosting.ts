/**
 * Per-product selling price and raw-material (xomashyo) cost, as the
 * production cost report computes them. Shared by GET
 * /api/production-orders/cost-summary and the daily production report so
 * both show the same numbers.
 *
 * - sell_price: a production product often has a same-named twin that
 *   carries the menu price ("Г/П ТВОРОЖНЫЙ (ЦЕЛЫЙ)" vs "ТВОРОЖНЫЙ"), so the
 *   price is found by an aggressive name match, then by shared Poster ids,
 *   preferring the twin that is on the Poster menu.
 * - xomashyo_cost_per_unit: the canonical twin that has a recipe is walked
 *   recursively (6 levels), summing leaf quantities × cost_price.
 * - production_cost: products.production_cost (labour/overhead per unit).
 */
import { query } from '../db/index.js';

export type ProductCosting = {
  sell_price: number | null;
  xomashyo_cost_per_unit: number | null;
  production_cost: number | null;
};

/** Letters and digits only, NFC — survives slash/paren/space/encoding differences. */
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\d]/gu, '');

type ProductEntry = {
  id: number;
  name: string;
  sell_price: number | null;
  has_recipe: boolean;
  has_poster_product_id: boolean;
  poster_ingredient_id: number | null;
  poster_product_id: number | null;
};

export async function costingForProducts(productIds: readonly number[]): Promise<Map<number, ProductCosting>> {
  const result = new Map<number, ProductCosting>();
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length === 0) return result;

  const { rows: allProducts } = await query<ProductEntry>(
    `SELECT p.id,
            p.name,
            p.sell_price::float AS sell_price,
            EXISTS(SELECT 1 FROM recipes WHERE product_id = p.id) AS has_recipe,
            (p.poster_product_id IS NOT NULL) AS has_poster_product_id,
            p.poster_ingredient_id,
            p.poster_product_id
       FROM products p
      WHERE p.type IN ('semi', 'finished', 'gp')`,
  );
  const byName = new Map<string, ProductEntry[]>();
  const byIngId = new Map<number, ProductEntry[]>();
  for (const p of allProducts) {
    const key = norm(p.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(p);
    if (p.poster_ingredient_id != null) {
      if (!byIngId.has(p.poster_ingredient_id)) byIngId.set(p.poster_ingredient_id, []);
      byIngId.get(p.poster_ingredient_id)!.push(p);
    }
  }

  const { rows: own } = await query<{
    id: number;
    name: string;
    poster_ingredient_id: number | null;
    poster_product_id: number | null;
    production_cost: number | null;
  }>(
    `SELECT id, name, poster_ingredient_id, poster_product_id, production_cost::float AS production_cost
       FROM products WHERE id = ANY($1::int[])`,
    [uniqueIds],
  );

  const priceById = new Map<number, number | null>();
  const canonMap = new Map<number, number>();
  for (const row of own) {
    const id = Number(row.id);
    const candidates: ProductEntry[] = [];
    (byName.get(norm(row.name)) ?? []).forEach((p) => candidates.push(p));
    if (row.poster_ingredient_id != null) {
      (byIngId.get(row.poster_ingredient_id) ?? []).forEach((p) => { if (!candidates.includes(p)) candidates.push(p); });
    }
    // A partner may use this product's poster_product_id as its ingredient id.
    if (row.poster_product_id != null) {
      (byIngId.get(row.poster_product_id) ?? []).forEach((p) => { if (!candidates.includes(p)) candidates.push(p); });
    }
    const withSell = candidates
      .filter((p) => p.sell_price != null && p.sell_price > 0)
      .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
    priceById.set(id, withSell[0]?.sell_price ?? null);
    const withRecipe = candidates
      .filter((p) => p.has_recipe)
      .sort((a, b) => Number(b.has_poster_product_id) - Number(a.has_poster_product_id));
    if (withRecipe[0]) canonMap.set(id, withRecipe[0].id);
  }

  const xomashyoMap = new Map<number, number>();
  const allCanonical = [...new Set(canonMap.values())];
  if (allCanonical.length > 0) {
    const { rows: bomRows } = await query<{ root_id: number; xomashyo_cost: number }>(
      `WITH RECURSIVE bom AS (
         SELECT r.product_id AS root_id,
                r.component_product_id AS comp_id,
                r.qty_per_unit::float AS eff_qty,
                1 AS depth
         FROM recipes r
         WHERE r.product_id = ANY($1::int[])
         UNION ALL
         SELECT b.root_id,
                r.component_product_id,
                b.eff_qty * r.qty_per_unit::float,
                b.depth + 1
         FROM bom b
         JOIN products comp ON comp.id = b.comp_id
         JOIN recipes r ON r.product_id = b.comp_id
         WHERE b.depth < 6
           AND comp.type IN ('semi', 'finished', 'gp')
       )
       SELECT b.root_id,
              COALESCE(SUM(b.eff_qty * COALESCE(comp.cost_price::float, 0)), 0)::float
                AS xomashyo_cost
       FROM bom b
       JOIN products comp ON comp.id = b.comp_id
       WHERE NOT EXISTS (SELECT 1 FROM recipes r2 WHERE r2.product_id = b.comp_id)
       GROUP BY b.root_id`,
      [allCanonical],
    );
    for (const r of bomRows) xomashyoMap.set(Number(r.root_id), Number(r.xomashyo_cost));
  }

  for (const row of own) {
    const id = Number(row.id);
    const canonId = canonMap.get(id);
    result.set(id, {
      sell_price: priceById.get(id) ?? null,
      xomashyo_cost_per_unit: canonId !== undefined ? (xomashyoMap.get(canonId) ?? null) : null,
      production_cost: row.production_cost === null ? null : Number(row.production_cost),
    });
  }
  return result;
}
