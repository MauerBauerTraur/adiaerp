/**
 * Pure "what does this become" grouping logic — extracted from
 * `WarehouseDispatchPage.tsx`'s `openLocationPrint` / `openGlobalPrint`
 * (both used to compute this independently, near-identical, PDF-only).
 *
 * Given the dispatch items sent to a location (or a whole day) plus the
 * production-order lookup map, walks the `parent_production_order_id`
 * chain (ADR-0016 zagatovka → ukrasheniye) to answer: which zagotovkas
 * (semi) are involved, and which finished/gp products do they (or the
 * directly-dispatched finished orders) ultimately become. Consumed both
 * by the print HTML generators (no behaviour change) and by the live
 * on-screen `<DestinationContext>` component so warehouse/production
 * staff can see the same chain without opening "Chop etish".
 */
import type { ProductionDispatch } from '@/lib/types';

/**
 * Order lookup row shape used across the daily-dispatch surfaces —
 * shared between `WarehouseDispatchPage.tsx` and this module so both
 * sides of the `orderById` map stay in sync.
 */
export type OrderInfo = {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  unit: string;
  location_id: number | null;
  location_name: string | null;
  product_type: string;
  production_cost: number | null;
  target_location_name: string | null;
  parent_production_order_id: number | null;
  parent_product_name: string | null;
  parent_unit: string | null;
  parent_qty: number | null;
  parent_production_cost: number | null;
  grandparent_production_order_id: number | null;
  grandparent_product_name: string | null;
  grandparent_unit: string | null;
  grandparent_qty: number | null;
  grandparent_production_cost: number | null;
};

export interface DestinationZagotovka {
  product_name: string;
  qty: number;
  unit: string;
}

export interface DestinationFinishedGood {
  product_id: number | null;
  product_name: string;
  qty: number;
  unit: string;
  production_cost: number | null;
}

export interface DestinationContextData {
  zagotovkas: DestinationZagotovka[];
  finishedGoods: DestinationFinishedGood[];
}

/**
 * Traverse `orderById` up the `parent_production_order_id` chain from a
 * zagotovka (semi) sub-order to find the root GP (finished) order it
 * belongs to. Falls back to the flattened grandparent_* columns when the
 * immediate parent row isn't present in the map (BIGINT-serialisation /
 * partial-fetch edge cases already handled by the original print code).
 */
function getRootGP(
  startId: number,
  orderById: Map<number, OrderInfo>,
): { id: number; product_id: number | null; product_name: string; qty: number; unit: string; production_cost: number | null } {
  let cur = orderById.get(startId);
  if (!cur) return { id: startId, product_id: null, product_name: '?', qty: 0, unit: '', production_cost: null };
  const visited = new Set<number>();
  while (cur.parent_production_order_id != null && !visited.has(cur.parent_production_order_id)) {
    visited.add(cur.id);
    const par = orderById.get(cur.parent_production_order_id);
    if (!par) {
      if (cur.grandparent_production_order_id != null && cur.grandparent_product_name) {
        return {
          id: cur.grandparent_production_order_id,
          product_id: null,
          product_name: cur.grandparent_product_name,
          qty: cur.grandparent_qty ?? cur.parent_qty ?? cur.qty,
          unit: cur.grandparent_unit ?? cur.parent_unit ?? cur.unit ?? '',
          production_cost: cur.grandparent_production_cost ?? cur.parent_production_cost ?? cur.production_cost,
        };
      }
      return {
        id: cur.parent_production_order_id,
        product_id: null,
        product_name: cur.parent_product_name ?? cur.product_name,
        qty: cur.parent_qty ?? cur.qty,
        unit: cur.parent_unit ?? cur.unit ?? '',
        production_cost: cur.parent_production_cost ?? cur.production_cost,
      };
    }
    cur = par;
  }
  return { id: cur.id, product_id: cur.product_id, product_name: cur.product_name, qty: cur.qty, unit: cur.unit ?? '', production_cost: cur.production_cost };
}

/**
 * Build the "this becomes that" breakdown for a set of dispatch items.
 *
 * - `zagotovkas` — semi (zagotovka) orders referenced by `items`, merged
 *   by product name.
 * - `finishedGoods` — GP/finished orders referenced by `items` directly,
 *   PLUS the root GP order(s) resolved by walking up from any zagotovka
 *   found above, PLUS (when `opts.locationName` is given) any other
 *   gp/finished order in `orderById` whose `location_name` matches — this
 *   catches finished orders at the same sex that aren't directly
 *   referenced by a raw-material dispatch item but are still "what this
 *   location is making" (mirrors the original print fallback).
 */
export function buildDestinationContext(
  items: ProductionDispatch[],
  orderById: Map<number, OrderInfo>,
  opts: { locationName?: string | null } = {},
): DestinationContextData {
  const referencedOrderIds = new Set(items.map((i) => i.production_order_id));
  const zagByName = new Map<string, DestinationZagotovka>();
  const gpByName = new Map<string, DestinationFinishedGood>();
  const seenGpRootIds = new Set<number>();

  for (const ordId of referencedOrderIds) {
    const o = orderById.get(ordId);
    if (!o) continue;
    if (o.product_type === 'semi') {
      const existingZag = zagByName.get(o.product_name);
      if (existingZag) {
        existingZag.qty += o.qty;
      } else {
        zagByName.set(o.product_name, { product_name: o.product_name, qty: o.qty, unit: o.unit ?? '' });
      }
      if (o.parent_production_order_id != null) {
        const root = getRootGP(o.parent_production_order_id, orderById);
        if (!seenGpRootIds.has(root.id)) {
          seenGpRootIds.add(root.id);
          gpByName.set(root.product_name, {
            product_id: root.product_id,
            product_name: root.product_name,
            qty: root.qty,
            unit: root.unit,
            production_cost: root.production_cost,
          });
        }
      }
    } else {
      const existing = gpByName.get(o.product_name);
      if (existing) {
        existing.qty += o.qty;
      } else {
        gpByName.set(o.product_name, {
          product_id: o.product_id,
          product_name: o.product_name,
          qty: o.qty,
          unit: o.unit ?? '',
          production_cost: o.production_cost,
        });
      }
    }
  }

  const locationName = opts.locationName ?? null;
  if (locationName != null) {
    for (const o of orderById.values()) {
      if ((o.product_type === 'gp' || o.product_type === 'finished') && !gpByName.has(o.product_name) && o.location_name === locationName) {
        gpByName.set(o.product_name, {
          product_id: o.product_id,
          product_name: o.product_name,
          qty: o.qty,
          unit: o.unit ?? '',
          production_cost: o.production_cost,
        });
      }
    }
  }

  return {
    zagotovkas: [...zagByName.values()],
    finishedGoods: [...gpByName.values()],
  };
}
