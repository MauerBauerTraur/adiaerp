/**
 * BOM cost propagation service.
 *
 * After raw material costs are loaded from Poster (via stockSync prime_cost),
 * this module computes cost_price for every semi-finished and finished product
 * by traversing the BOM tree.
 *
 * Algorithm:
 *   1. Load all products with their current cost_price.
 *   2. Load all BOM entries (product_id, component_product_id, qty_per_unit).
 *   3. For each semi/finished product, recursively compute:
 *        cost = sum(component.cost_price × qty_per_unit)
 *      qty_per_unit is already normalised per 1 unit of output (kg or pcs),
 *      so no batch_yield division is needed here.
 *   4. Persist computed values — only writes when the value changes.
 *
 * Cycles in the BOM are detected via a "visiting" set and produce null cost
 * (skipped) rather than a crash. Missing raw material costs also produce null.
 */

import { query } from '../db/index.js';

export type CostCalcResult = {
  readonly updated: number;
  readonly skippedNoCost: number;
  readonly cycles: number;
};

type ProductRow = {
  id: number;
  type: string;
  cost_price: number | null;
};

type RecipeRow = {
  product_id: number;
  component_product_id: number;
  qty_per_unit: number;
};

/**
 * Traverse the BOM tree and compute cost_price for every semi/finished product.
 * Persists results to the DB. Returns a summary.
 */
export async function recalculateBomCosts(): Promise<CostCalcResult> {
  // 1. Load all products.
  const { rows: products } = await query<ProductRow>(
    `SELECT id, type, cost_price FROM products ORDER BY id`,
  );

  // 2. Build a Map for O(1) lookup: product_id → cost_price (raw = from DB).
  const costMap = new Map<number, number>();
  for (const p of products) {
    const cp = Number(p.cost_price ?? null);
    if (p.type === 'raw' && Number.isFinite(cp) && cp > 0) {
      costMap.set(p.id, cp);
    }
  }

  // 3. Build BOM adjacency list: product_id → [{ compId, qty }].
  const { rows: recipes } = await query<RecipeRow>(
    `SELECT product_id, component_product_id, qty_per_unit::float8 AS qty_per_unit
     FROM recipes
     WHERE qty_per_unit > 0`,
  );

  const bom = new Map<number, { compId: number; qty: number }[]>();
  for (const r of recipes) {
    const list = bom.get(r.product_id) ?? [];
    list.push({ compId: r.component_product_id, qty: Number(r.qty_per_unit) });
    bom.set(r.product_id, list);
  }

  // 4. Recursive cost calculation with cycle detection.
  const visiting = new Set<number>();
  let cycles = 0;

  function calcCost(productId: number): number | null {
    // Already computed.
    if (costMap.has(productId)) return costMap.get(productId)!;

    // Cycle guard.
    if (visiting.has(productId)) {
      cycles += 1;
      return null;
    }

    const components = bom.get(productId);
    if (!components || components.length === 0) return null;

    visiting.add(productId);
    let total = 0;
    for (const { compId, qty } of components) {
      const compCost = calcCost(compId);
      if (compCost === null) {
        visiting.delete(productId);
        return null; // missing cost for a component → can't compute parent
      }
      total += compCost * qty;
    }
    visiting.delete(productId);

    if (!Number.isFinite(total) || total <= 0) return null;

    costMap.set(productId, total);
    return total;
  }

  // 5. Compute and persist costs for semi/finished products.
  let updated = 0;
  let skippedNoCost = 0;

  for (const p of products) {
    if (p.type === 'raw') continue; // raw products get cost from Poster directly

    const newCost = calcCost(p.id);

    if (newCost === null || newCost <= 0) {
      skippedNoCost += 1;
      continue;
    }

    const oldCost = Number(p.cost_price ?? null);
    if (Number.isFinite(oldCost) && Math.abs(oldCost - newCost) < 1) {
      // Less than 1 so'm difference — skip unnecessary write.
      continue;
    }

    await query(
      `UPDATE products SET cost_price = $1, updated_at = now()
       WHERE id = $2 AND cost_price IS DISTINCT FROM $1`,
      [newCost, p.id],
    );
    updated += 1;
  }

  return { updated, skippedNoCost, cycles };
}
