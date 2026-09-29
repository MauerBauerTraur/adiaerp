/**
 * Kunlik ishlab chiqarish hisoboti — the production half of the daily report
 * for management (GET /api/reports/production-daily).
 *
 * Period semantics match the Zayavkalar page: an order belongs to the Tashkent
 * day it was given (created_at), top-level orders only (a sub-order is part
 * of its parent), cancelled ones excluded. "Produced" is what a done order
 * actually yielded (actual_qty, else qty).
 *
 * Money:
 *   - unit cost (tannarx) = recipe-walked raw-material cost + production_cost,
 *     from the same costing service as the production cost report;
 *   - sales value = produced qty × the menu selling price;
 *   - raw given to an otdel = warehouse-issued dispatch lines in the period
 *     × cost_price (same source as Xomashyo iste'moli).
 * Warehouse values are the CURRENT stock (qty × cost_price), not end-of-day.
 * Supplier deliveries come live from Poster (storage.getSupplies), because the
 * local poster_supplies table is only synced by hand.
 */
import { query } from '../db/index.js';
import type { PosterClient } from '../integrations/poster/client.js';
import { costingForProducts } from './productCosting.js';

export type ProductLine = {
  product_id: number;
  product_name: string;
  unit: string;
  location_id: number | null;
  location_name: string | null;
  ordered_qty: number;
  produced_qty: number;
  pending_orders: number;
  unit_cost: number | null;
  sell_price: number | null;
  cost_total: number | null;
  sales_total: number | null;
  profit_total: number | null;
  loss: boolean;
};

export type OtdelLine = {
  location_id: number | null;
  location_name: string;
  orders: number;
  produced_qty: number;
  raw_given_value: number;
  cost_total: number;
  sales_total: number;
  profit_total: number;
};

export type SupplyLine = { supplier_name: string; storage_name: string; date: string; sum: number };

export type ProductionDailyReport = {
  from: string;
  to: string;
  generated_at: string;
  summary: {
    orders: number;
    otdels: number;
    ordered_qty: number;
    produced_qty: number;
    done_orders: number;
    cost_total: number;
    sales_total: number;
    profit_total: number;
    margin_pct: number | null;
    supplies_total: number | null;
    supplies_count: number | null;
  };
  products: ProductLine[];
  otdels: OtdelLine[];
  stock: {
    groups: { key: 'central' | 'raw' | 'zagotovka'; label: string; value: number }[];
    low: { product_name: string; unit: string; qty: number; min_level: number; location_name: string }[];
  };
  supplies: SupplyLine[] | null;
  problems: {
    losses: { product_name: string; location_name: string | null; loss: number }[];
    unfinished: { order_id: number; product_name: string; location_name: string | null; qty: number; status: string }[];
  };
  warnings: string[];
};

/** Poster storage id of the zagotovka buffer ("Склад Заготовок", ADR-0017). */
const ZAGOTOVKA_STORAGE_ID = 35;

const STOCK_LABELS = {
  central: 'Markaziy sklad (tayyor mahsulot)',
  raw: 'Xomashyo ombori',
  zagotovka: 'Zagotovka ombori',
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deliveries registered in Poster for the period (deleted ones skipped). */
export async function fetchPosterSupplies(client: PosterClient, from: string, to: string): Promise<SupplyLine[]> {
  const rows = await client.getSupplies({ dateFrom: from.replaceAll('-', ''), dateTo: to.replaceAll('-', '') });
  return rows
    .filter((r) => String(r.delete ?? '0') !== '1')
    .map((r) => ({
      supplier_name: String(r.supplier_name ?? '').trim() || "Noma'lum yetkazib beruvchi",
      storage_name: String(r.storage_name ?? '').trim(),
      date: String(r.date ?? ''),
      // storage.getSupplies returns the header sum in tiyin.
      sum: Math.round(Number(r.supply_sum ?? 0)) / 100,
    }))
    .sort((a, b) => b.sum - a.sum);
}

export async function buildProductionDailyReport(
  from: string,
  to: string,
  loadSupplies: (() => Promise<SupplyLine[]>) | null,
): Promise<ProductionDailyReport> {
  const warnings: string[] = [];

  // 1. Top-level orders given in the period.
  const { rows: orders } = await query<{
    id: number;
    product_id: number;
    product_name: string;
    unit: string;
    location_id: number | null;
    location_name: string | null;
    qty: number;
    actual_qty: number | null;
    status: string;
  }>(
    `SELECT po.id, po.product_id, p.name AS product_name, p.unit::text AS unit,
            po.location_id, l.name AS location_name,
            po.qty::float AS qty, po.actual_qty::float AS actual_qty, po.status::text AS status
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations l ON l.id = po.location_id
      WHERE po.parent_production_order_id IS NULL
        AND po.status <> 'cancelled'
        AND (po.created_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN $1 AND $2
      ORDER BY po.id`,
    [from, to],
  );

  // 2. Products per (product, otdel).
  const costing = await costingForProducts(orders.map((o) => Number(o.product_id)));
  const lines = new Map<string, ProductLine>();
  for (const o of orders) {
    const productId = Number(o.product_id);
    const locationId = o.location_id === null ? null : Number(o.location_id);
    const key = `${productId}|${locationId ?? ''}`;
    let line = lines.get(key);
    if (line === undefined) {
      const c = costing.get(productId);
      const unitCost =
        c?.xomashyo_cost_per_unit == null ? null : round2(c.xomashyo_cost_per_unit + (c.production_cost ?? 0));
      line = {
        product_id: productId,
        product_name: o.product_name,
        unit: o.unit,
        location_id: locationId,
        location_name: o.location_name,
        ordered_qty: 0,
        produced_qty: 0,
        pending_orders: 0,
        unit_cost: unitCost,
        sell_price: c?.sell_price ?? null,
        cost_total: null,
        sales_total: null,
        profit_total: null,
        loss: false,
      };
      lines.set(key, line);
    }
    line.ordered_qty += Number(o.qty);
    if (o.status === 'done') line.produced_qty += Number(o.actual_qty ?? o.qty);
    else line.pending_orders += 1;
  }
  const products = [...lines.values()];
  for (const l of products) {
    l.ordered_qty = round2(l.ordered_qty);
    l.produced_qty = round2(l.produced_qty);
    l.cost_total = l.unit_cost === null ? null : round2(l.unit_cost * l.produced_qty);
    l.sales_total = l.sell_price === null ? null : round2(l.sell_price * l.produced_qty);
    l.profit_total = l.cost_total !== null && l.sales_total !== null ? round2(l.sales_total - l.cost_total) : null;
    l.loss = l.unit_cost !== null && l.sell_price !== null && l.sell_price < l.unit_cost;
  }
  products.sort((a, b) => (b.sales_total ?? 0) - (a.sales_total ?? 0));
  const noPrice = products.filter((p) => p.sell_price === null || p.unit_cost === null).length;
  if (noPrice > 0) {
    warnings.push(`${noPrice} ta mahsulotda sotuv narxi yoki retsept yo'q — ularning foydasi hisoblanmadi.`);
  }

  // 3. Raw materials the warehouse issued to each otdel in the period.
  const { rows: given } = await query<{ location_id: number | null; location_name: string | null; value: number }>(
    `SELECT pd.to_location_id AS location_id, l.name AS location_name,
            COALESCE(SUM(pd.qty_needed * COALESCE(p.cost_price, 0)), 0)::float AS value
       FROM production_dispatches pd
       JOIN production_orders po ON po.id = pd.production_order_id
       JOIN products p ON p.id = pd.product_id
       LEFT JOIN locations fl ON fl.id = pd.from_location_id
       LEFT JOIN locations l ON l.id = pd.to_location_id
      WHERE pd.status IN ('dispatched', 'received')
        AND pd.dispatched_at IS NOT NULL
        AND pd.product_id <> po.product_id
        AND (fl.id IS NULL OR fl.type = 'raw_warehouse')
        AND (pd.dispatched_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN $1 AND $2
      GROUP BY pd.to_location_id, l.name`,
    [from, to],
  );

  // 4. Otdels.
  const otdelMap = new Map<string, OtdelLine>();
  const otdelFor = (id: number | null, name: string | null): OtdelLine => {
    const key = String(id ?? '');
    let o = otdelMap.get(key);
    if (o === undefined) {
      o = { location_id: id, location_name: name ?? "Noma'lum otdel", orders: 0, produced_qty: 0, raw_given_value: 0, cost_total: 0, sales_total: 0, profit_total: 0 };
      otdelMap.set(key, o);
    }
    return o;
  };
  for (const o of orders) otdelFor(o.location_id === null ? null : Number(o.location_id), o.location_name).orders += 1;
  for (const l of products) {
    const o = otdelFor(l.location_id, l.location_name);
    o.produced_qty = round2(o.produced_qty + l.produced_qty);
    o.cost_total = round2(o.cost_total + (l.cost_total ?? 0));
    o.sales_total = round2(o.sales_total + (l.sales_total ?? 0));
    o.profit_total = round2(o.profit_total + (l.profit_total ?? 0));
  }
  for (const g of given) {
    otdelFor(g.location_id === null ? null : Number(g.location_id), g.location_name).raw_given_value = round2(Number(g.value));
  }
  const otdels = [...otdelMap.values()].sort((a, b) => b.sales_total - a.sales_total);

  // 5. Warehouses (current) and raw materials below their minimum.
  const { rows: stockRows } = await query<{ grp: 'central' | 'raw' | 'zagotovka'; value: number }>(
    `SELECT CASE WHEN l.type = 'central_warehouse' THEN 'central'
                 WHEN l.type = 'raw_warehouse' THEN 'raw'
                 ELSE 'zagotovka' END AS grp,
            COALESCE(SUM(GREATEST(s.qty, 0) * COALESCE(p.cost_price, 0)), 0)::float AS value
       FROM stock s
       JOIN locations l ON l.id = s.location_id
       JOIN products p ON p.id = s.product_id
      WHERE l.is_active = TRUE
        AND (l.type IN ('central_warehouse', 'raw_warehouse') OR l.poster_storage_id = $1)
      GROUP BY 1`,
    [ZAGOTOVKA_STORAGE_ID],
  );
  const stockValue = new Map(stockRows.map((r) => [r.grp, round2(Number(r.value))]));
  const groups = (['central', 'raw', 'zagotovka'] as const).map((key) => ({
    key,
    label: STOCK_LABELS[key],
    value: stockValue.get(key) ?? 0,
  }));
  const { rows: low } = await query<{ product_name: string; unit: string; qty: number; min_level: number; location_name: string }>(
    `SELECT p.name AS product_name, p.unit::text AS unit, s.qty::float AS qty,
            s.min_level::float AS min_level, l.name AS location_name
       FROM stock s
       JOIN locations l ON l.id = s.location_id
       JOIN products p ON p.id = s.product_id
      WHERE l.is_active = TRUE AND l.type = 'raw_warehouse'
        AND s.min_level > 0 AND s.qty < s.min_level
      ORDER BY (s.qty / s.min_level) ASC, p.name
      LIMIT 12`,
  );

  // 6. Supplier deliveries — a Poster outage must not sink the whole report.
  let supplies: SupplyLine[] | null = null;
  if (loadSupplies === null) {
    warnings.push("Poster ulanmagan — yetkazib beruvchilardan kirim ko'rsatilmadi.");
  } else {
    try {
      supplies = await loadSupplies();
    } catch {
      warnings.push("Poster'dan postavkalarni olib bo'lmadi — kirim ko'rsatilmadi.");
    }
  }

  const doneOrders = orders.filter((o) => o.status === 'done').length;
  const costTotal = round2(products.reduce((s, l) => s + (l.cost_total ?? 0), 0));
  const salesTotal = round2(products.reduce((s, l) => s + (l.sales_total ?? 0), 0));
  const profitTotal = round2(products.reduce((s, l) => s + (l.profit_total ?? 0), 0));

  return {
    from,
    to,
    generated_at: new Date().toISOString(),
    summary: {
      orders: orders.length,
      otdels: new Set(orders.map((o) => o.location_id)).size,
      ordered_qty: round2(products.reduce((s, l) => s + l.ordered_qty, 0)),
      produced_qty: round2(products.reduce((s, l) => s + l.produced_qty, 0)),
      done_orders: doneOrders,
      cost_total: costTotal,
      sales_total: salesTotal,
      profit_total: profitTotal,
      margin_pct: salesTotal > 0 ? Math.round((profitTotal / salesTotal) * 1000) / 10 : null,
      supplies_total: supplies === null ? null : round2(supplies.reduce((s, x) => s + x.sum, 0)),
      supplies_count: supplies === null ? null : supplies.length,
    },
    products,
    otdels,
    stock: { groups, low: low.map((r) => ({ ...r, qty: Number(r.qty), min_level: Number(r.min_level) })) },
    supplies,
    problems: {
      losses: products
        .filter((l) => l.loss)
        .map((l) => ({ product_name: l.product_name, location_name: l.location_name, loss: l.profit_total ?? 0 })),
      unfinished: orders
        .filter((o) => o.status !== 'done')
        .map((o) => ({ order_id: Number(o.id), product_name: o.product_name, location_name: o.location_name, qty: Number(o.qty), status: o.status })),
    },
    warnings,
  };
}
