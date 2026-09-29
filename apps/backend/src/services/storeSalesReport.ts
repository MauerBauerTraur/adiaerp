/**
 * "Do'konlar sotuvi" — each store's sales for a period, read straight from
 * Poster's own reports (`dash.getSpotsSales` + `dash.getProductsSales`) so the
 * figures match Poster's "Товары" screen 1:1.
 *
 * It deliberately does NOT use the local `sales` table: that table's revenue
 * is unreliable (Poster's line `product_price` is the LINE total, and cake
 * slice modifiers often fail to resolve — see the report in chat 2026-09-29).
 *
 * Size modifiers (ЦЕЛЫЙ / ПОЛОВИНА / КУСОК) get a `whole_factor` — the share
 * of a whole cake one unit represents, from the product's group-modification
 * brutto weights (НАПОЛЕОН: КУСОК 62.5 g / ЦЕЛЫЙ 1000 g = 0.0625) — so the
 * UI can also show slices converted to whole cakes for production planning.
 * Every other modifier ("Рулет 6-шт", "баночный") is an item of its own.
 */
import type { PosterClient, PosterProductSalesRow } from '../integrations/poster/client.js';

export type StoreSalesItem = {
  product_name: string;
  /** Poster modifier name, or null when the row has none. */
  modifier: string | null;
  poster_product_id: number;
  modification_id: number | null;
  qty: number;
  unit: 'pcs' | 'kg';
  /** So'm actually paid. */
  revenue: number;
  /** Poster's profit, so'm. */
  profit: number;
  /** Share of a whole cake per unit — only for ЦЕЛЫЙ / ПОЛОВИНА / КУСОК. */
  whole_factor: number | null;
};

export type StoreSalesStore = {
  spot_id: number;
  name: string;
  revenue: number;
  profit: number;
  checks: number;
  avg_check: number;
  items: StoreSalesItem[];
};

export type StoreSalesReport = {
  from: string;
  to: string;
  generated_at: string;
  stores: StoreSalesStore[];
};

const SIZE_MODIFIERS = new Set(['ЦЕЛЫЙ', 'ПОЛОВИНА', 'КУСОК']);

// Past days never change, so they cache long; a range that reaches today
// is refreshed every few minutes. Weights change only when the menu does.
const TODAY_TTL_MS = 5 * 60 * 1000;
const PAST_TTL_MS = 6 * 60 * 60 * 1000;
const WEIGHT_TTL_MS = 6 * 60 * 60 * 1000;

const reportCache = new Map<string, { at: number; report: StoreSalesReport }>();
const weightCache = new Map<number, { at: number; weights: Record<string, number> }>();

/** TEST-ONLY — forget cached reports and weights. */
export function clearStoreSalesCache(): void {
  reportCache.clear();
  weightCache.clear();
}

/** Today's date (YYYY-MM-DD) in Tashkent, UTC+5. */
function tashkentToday(now: number): string {
  return new Date(now + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const posterDate = (iso: string): string => iso.replaceAll('-', '');
const som = (tiyin: string | number | undefined): number => Math.round(Number(tiyin ?? 0)) / 100;
const num = (v: string | number | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function sizeWeights(client: PosterClient, posterProductId: number, now: number): Promise<Record<string, number>> {
  const hit = weightCache.get(posterProductId);
  if (hit !== undefined && now - hit.at < WEIGHT_TTL_MS) return hit.weights;
  const weights: Record<string, number> = {};
  const product = await client.getProduct(posterProductId);
  for (const group of product?.group_modifications ?? []) {
    for (const m of group.modifications ?? []) {
      const name = String(m.name ?? '').trim().toUpperCase();
      const brutto = Number(m.brutto);
      if (name !== '' && Number.isFinite(brutto) && brutto > 0) weights[name] = brutto;
    }
  }
  weightCache.set(posterProductId, { at: now, weights });
  return weights;
}

function wholeFactor(modifier: string, weights: Record<string, number>): number | null {
  const full = weights['ЦЕЛЫЙ'] ?? Math.max(0, ...Object.values(weights));
  const own = weights[modifier];
  if (own !== undefined && full > 0) return own / full;
  if (modifier === 'ЦЕЛЫЙ') return 1;
  if (modifier === 'ПОЛОВИНА') return 0.5;
  return null;
}

function toItem(row: PosterProductSalesRow): StoreSalesItem {
  const modifier = String(row.modificator_name ?? '').trim();
  const modId = Number(row.modification_id);
  return {
    product_name: String(row.product_name ?? '').trim(),
    modifier: modifier === '' ? null : modifier,
    poster_product_id: Number(row.product_id),
    modification_id: Number.isInteger(modId) && modId > 0 ? modId : null,
    qty: num(row.count),
    unit: row.unit === 'kg' ? 'kg' : 'pcs',
    revenue: som(row.payed_sum),
    profit: som(row.product_profit),
    whole_factor: null,
  };
}

export async function buildStoreSalesReport(
  client: PosterClient,
  from: string,
  to: string,
  now: number = Date.now(),
): Promise<StoreSalesReport> {
  const key = `${from}|${to}`;
  const ttl = to >= tashkentToday(now) ? TODAY_TTL_MS : PAST_TTL_MS;
  const hit = reportCache.get(key);
  if (hit !== undefined && now - hit.at < ttl) return hit.report;

  const spots = (await client.getSpots())
    .map((s) => ({ id: Number(s.spot_id), name: String(s.spot_name ?? s.name ?? '').trim() }))
    .filter((s) => Number.isInteger(s.id) && s.id > 0)
    .sort((a, b) => a.id - b.id);

  const range = { dateFrom: posterDate(from), dateTo: posterDate(to) };
  const stores: StoreSalesStore[] = [];
  for (const spot of spots) {
    const totals = await client.getSpotsSales({ ...range, spotId: spot.id });
    const rows = await client.getProductsSales({ ...range, spotId: spot.id });
    const items = rows.map(toItem).sort((a, b) => b.revenue - a.revenue);
    for (const item of items) {
      const mod = item.modifier?.toUpperCase() ?? '';
      if (SIZE_MODIFIERS.has(mod)) {
        item.whole_factor = wholeFactor(mod, await sizeWeights(client, item.poster_product_id, now));
      }
    }
    const checks = num(totals?.clients);
    const revenue = num(totals?.revenue);
    stores.push({
      spot_id: spot.id,
      name: spot.name || `Do'kon ${spot.id}`,
      revenue,
      profit: Math.round(num(totals?.profit) * 100) / 100,
      checks,
      avg_check: checks > 0 ? Math.round(revenue / checks) : 0,
      items,
    });
  }

  const report: StoreSalesReport = { from, to, generated_at: new Date(now).toISOString(), stores };
  reportCache.set(key, { at: now, report });
  return report;
}
