/**
 * F4.6 — Sales read endpoint.
 *
 *   GET /api/sales?location_id=&from=&to=&limit=&offset=
 *
 * One read-only window onto the Poster-synced `sales` table for the store
 * pages. PM / ai_assistant may query any store; a scoped principal is
 * locked to its assigned `locationIds` (M:N). Date filters accept ISO
 * timestamps (or YYYY-MM-DD); `from` defaults to start of today, `to`
 * defaults to "open-ended".
 *
 * The endpoint is paginated to keep the page bounded — same `{items,total,
 * limit,offset}` envelope as `GET /api/stock/movements` (spec section 4).
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseOptionalIdParam } from '../lib/validate.js';
import { parseDateRange, type DateRange } from '../lib/dateRange.js';

export const salesRouter: Router = Router();

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

type SalesRow = {
  id: string;
  store_id: string;
  store_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  price: string;
  sold_at: Date;
  poster_transaction_id: string;
};

type SalesItem = {
  id: number;
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  price: number;
  sold_at: string;
  poster_transaction_id: number;
};

salesRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationIdParam = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const fromParam = parseOptionalDate(
      typeof req.query.from === 'string' ? req.query.from : undefined,
      'from',
    );
    const toParam = parseOptionalDate(
      typeof req.query.to === 'string' ? req.query.to : undefined,
      'to',
    );
    if (fromParam !== undefined && toParam !== undefined && fromParam > toParam) {
      throw AppError.validation('"from" must be earlier than or equal to "to".');
    }

    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // RBAC scoping. PM / ai_assistant — chain. Scoped principal — intersect
    // with `locationIds`. A scoped principal asking for a foreign location
    // gets 403; absence of the param falls back to its own set.
    let storeFilter: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeFilter = locationIdParam === undefined ? null : [locationIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [], total: 0, limit, offset });
        return;
      }
      if (locationIdParam !== undefined) {
        if (!principal.locationIds.includes(locationIdParam)) {
          throw AppError.forbidden('You may only view sales for your own location.');
        }
        storeFilter = [locationIdParam];
      } else {
        storeFilter = principal.locationIds;
      }
    }

    const conditions: string[] = [];
    const params: SqlParam[] = [];
    if (storeFilter !== null) {
      params.push(storeFilter);
      conditions.push(`s.store_id = ANY($${params.length}::bigint[])`);
    }
    if (fromParam !== undefined) {
      params.push(fromParam);
      conditions.push(`s.sold_at >= $${params.length}`);
    }
    if (toParam !== undefined) {
      params.push(toParam);
      conditions.push(`s.sold_at <= $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await query<{ total: string }>(
      `SELECT count(*) AS total FROM sales s ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows } = await query<SalesRow>(
      `SELECT s.id, s.store_id, l.name AS store_name,
              s.product_id, p.name AS product_name, p.unit AS product_unit,
              s.qty, s.price, s.sold_at, s.poster_transaction_id
         FROM sales s
         JOIN products  p ON p.id = s.product_id
         JOIN locations l ON l.id = s.store_id
         ${where}
         ORDER BY s.sold_at DESC, s.id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );

    const items: SalesItem[] = rows.map((r) => ({
      id: Number(r.id),
      store_id: Number(r.store_id),
      store_name: r.store_name,
      product_id: Number(r.product_id),
      product_name: r.product_name,
      product_unit: r.product_unit,
      qty: Number(r.qty),
      price: Number(r.price),
      sold_at: r.sold_at.toISOString(),
      poster_transaction_id: Number(r.poster_transaction_id),
    }));
    res.status(200).json({ items, total, limit, offset });
  }),
);

/**
 * Parse an ISO timestamp or `YYYY-MM-DD` date string. Throws 422 on invalid.
 * Returns the parsed `Date`, or `undefined` when the field is absent/empty.
 */
function parseOptionalDate(raw: string | undefined, label: string): Date | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation(`"${label}" must be an ISO timestamp or YYYY-MM-DD.`);
  }
  return d;
}

/** Parse a query value as an integer clamped to [min, max], else fallback. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}

// =============================================================================
// F4.9 — GET /api/sales/receipts
// =============================================================================
//
// One row per Poster check (distinct `poster_transaction_id`) instead of one
// row per sold product. Each receipt embeds the top 5 products that made up
// the check — enough for a sortable list view without a second fetch.
//
// Query parameters:
//   - range=today|week|month|custom  (default today)
//   - from / to (YYYY-MM-DD, required when range=custom)
//   - store_id (optional; RBAC-bounded — a scoped principal cannot escape its
//     assigned locationIds)
//   - limit (1..200, default 50), offset (>=0)
//
// RBAC mirrors `GET /api/sales`: PM and ai_assistant chain-wide; every other
// listed role is locked to its assigned `locationIds`. A scoped principal with
// no assigned locations returns an empty page.
// -----------------------------------------------------------------------------

const TOP_PRODUCTS_PER_RECEIPT = 5;

type ReceiptProduct = {
  product_id: number;
  product_name: string;
  qty: number;
  price: number;
};

type ReceiptItem = {
  poster_transaction_id: number;
  store_id: number;
  store_name: string;
  sold_at: string;
  total_qty: number;
  total_revenue: number;
  line_count: number;
  products: ReceiptProduct[];
};

salesRouter.get(
  '/receipts',
  authenticate,
  authorize(
    'pm',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range: DateRange = parseDateRange(req.query);
    const storeIdParam = parseOptionalIdParam(
      typeof req.query.store_id === 'string' ? req.query.store_id : undefined,
      'store_id',
    );
    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // RBAC scoping (parity with GET /api/sales).
    let storeFilter: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeFilter = storeIdParam === undefined ? null : [storeIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [], total: 0, limit, offset });
        return;
      }
      if (storeIdParam !== undefined) {
        if (!principal.locationIds.includes(storeIdParam)) {
          throw AppError.forbidden('You may only view receipts for your own location.');
        }
        storeFilter = [storeIdParam];
      } else {
        storeFilter = principal.locationIds;
      }
    }

    const conditions: string[] = ['s.sold_at >= $1', 's.sold_at < $2'];
    const params: SqlParam[] = [range.from, range.to];
    if (storeFilter !== null) {
      params.push(storeFilter);
      conditions.push(`s.store_id = ANY($${params.length}::bigint[])`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    // 1) Total — distinct checks in range.
    const countRes = await query<{ total: string }>(
      `SELECT count(DISTINCT (s.poster_transaction_id, s.store_id)) AS total
         FROM sales s
         ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    // 2) Page of receipts (per (transaction, store) — Poster transaction_ids
    //    are unique per store in practice but we group on both to be safe).
    //    `sold_at` reflects when the check closed; max() picks the line-level
    //    timestamp Poster recorded.
    const pageParams: SqlParam[] = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows: receipts } = await query<{
      poster_transaction_id: string;
      store_id: string;
      store_name: string;
      sold_at: Date;
      total_qty: string;
      total_revenue: string;
      line_count: string;
    }>(
      `SELECT s.poster_transaction_id,
              s.store_id,
              l.name                          AS store_name,
              max(s.sold_at)                  AS sold_at,
              sum(s.qty)                      AS total_qty,
              sum(s.qty * s.price)            AS total_revenue,
              count(*)                        AS line_count
         FROM sales s
         JOIN locations l ON l.id = s.store_id
         ${where}
        GROUP BY s.poster_transaction_id, s.store_id, l.name
        ORDER BY max(s.sold_at) DESC, s.poster_transaction_id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );

    if (receipts.length === 0) {
      res.status(200).json({ items: [], total, limit, offset });
      return;
    }

    // 3) Top-N products per receipt — one query, partitioned by
    //    (transaction, store), keeping the heaviest lines.
    const txnIds = receipts.map((r) => r.poster_transaction_id);
    const storeIds = receipts.map((r) => r.store_id);
    const { rows: productRows } = await query<{
      poster_transaction_id: string;
      store_id: string;
      product_id: string;
      product_name: string;
      qty: string;
      price: string;
    }>(
      `WITH lines AS (
         SELECT s.poster_transaction_id,
                s.store_id,
                s.product_id,
                p.name AS product_name,
                sum(s.qty)              AS qty,
                max(s.price)            AS price,
                row_number() OVER (
                  PARTITION BY s.poster_transaction_id, s.store_id
                  ORDER BY sum(s.qty) DESC, s.product_id
                ) AS rn
           FROM sales s
           JOIN products p ON p.id = s.product_id
          WHERE s.poster_transaction_id = ANY($1::bigint[])
            AND s.store_id = ANY($2::bigint[])
          GROUP BY s.poster_transaction_id, s.store_id, s.product_id, p.name
       )
       SELECT poster_transaction_id, store_id, product_id, product_name, qty, price
         FROM lines
        WHERE rn <= $3`,
      [txnIds, storeIds, TOP_PRODUCTS_PER_RECEIPT],
    );

    // Group product rows by (transaction, store).
    const productMap = new Map<string, ReceiptProduct[]>();
    for (const r of productRows) {
      const key = `${r.poster_transaction_id}:${r.store_id}`;
      const arr = productMap.get(key) ?? [];
      arr.push({
        product_id: Number(r.product_id),
        product_name: r.product_name,
        qty: Number(r.qty),
        price: Number(r.price),
      });
      productMap.set(key, arr);
    }

    const items: ReceiptItem[] = receipts.map((r) => {
      const key = `${r.poster_transaction_id}:${r.store_id}`;
      return {
        poster_transaction_id: Number(r.poster_transaction_id),
        store_id: Number(r.store_id),
        store_name: r.store_name,
        sold_at: r.sold_at.toISOString(),
        total_qty: Number(r.total_qty),
        total_revenue: Number(r.total_revenue),
        line_count: Number(r.line_count),
        products: productMap.get(key) ?? [],
      };
    });

    res.status(200).json({ items, total, limit, offset });
  }),
);

// =============================================================================
// EPIC 8.2 / 8.3 — GET /api/sales/receipts/stock
// =============================================================================
//
// Per-check (chek) stock reconciliation: for each sold product on a check we
// surface (ost − sotildi − qoldi) = (opening − sold − remaining), exactly the
// "Ост 10 − sotildi 5 − itogo 5 qoldi" view the owner asked for (spec §8.2).
// When the cash register rang up MORE than ADIA had on hand the remainder goes
// negative — the "noto'g'ri urilgan" / fors-major signal (§8.3). Stock itself
// never went negative (invariant 3 — salesSync clamps + raises an alert); this
// endpoint is a READ-ONLY reporting view, it mutates nothing.
//
// OPENING DERIVATION (no per-check stock snapshot exists): we reconstruct the
// opening on-hand at each check by RUNNING BACKWARD from the current `stock`
// qty. For a (store, product) the opening before a check C =
//   current_on_hand + Σ sold on C-and-every-LATER check in the window.
// Visiting checks newest→oldest and stepping the cursor down by each check's
// sold qty reconciles to the live stock at the head of the window. (Non-sales
// movements between checks are not modelled here; the authoritative shortfall
// signal is the persisted `wrong_keyed_check` notification raised in salesSync.)
//
// RBAC + pagination mirror `GET /api/sales/receipts`.
// -----------------------------------------------------------------------------

type ReceiptStockLine = {
  product_id: number;
  product_name: string;
  product_unit: string;
  opening_qty: number;
  sold_qty: number;
  remaining_qty: number;
};

type ReceiptWithStock = {
  poster_transaction_id: number;
  store_id: number;
  store_name: string;
  sold_at: string;
  total_qty: number;
  total_revenue: number;
  line_count: number;
  lines: ReceiptStockLine[];
  has_force_majeure: boolean;
};

salesRouter.get(
  '/receipts/stock',
  authenticate,
  authorize(
    'pm',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range: DateRange = parseDateRange(req.query);
    const storeIdParam = parseOptionalIdParam(
      typeof req.query.store_id === 'string' ? req.query.store_id : undefined,
      'store_id',
    );
    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // RBAC scoping (parity with GET /api/sales/receipts).
    let storeFilter: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeFilter = storeIdParam === undefined ? null : [storeIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [], total: 0, limit, offset });
        return;
      }
      if (storeIdParam !== undefined) {
        if (!principal.locationIds.includes(storeIdParam)) {
          throw AppError.forbidden('You may only view receipts for your own location.');
        }
        storeFilter = [storeIdParam];
      } else {
        storeFilter = principal.locationIds;
      }
    }

    const conditions: string[] = ['s.sold_at >= $1', 's.sold_at < $2'];
    const params: SqlParam[] = [range.from, range.to];
    if (storeFilter !== null) {
      params.push(storeFilter);
      conditions.push(`s.store_id = ANY($${params.length}::bigint[])`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    // 1) Total — distinct checks in range.
    const countRes = await query<{ total: string }>(
      `SELECT count(DISTINCT (s.poster_transaction_id, s.store_id)) AS total
         FROM sales s
         ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    // 2) Page of receipt headers (newest first).
    const pageParams: SqlParam[] = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows: receipts } = await query<{
      poster_transaction_id: string;
      store_id: string;
      store_name: string;
      sold_at: Date;
      total_qty: string;
      total_revenue: string;
      line_count: string;
    }>(
      `SELECT s.poster_transaction_id,
              s.store_id,
              l.name                AS store_name,
              max(s.sold_at)        AS sold_at,
              sum(s.qty)            AS total_qty,
              sum(s.qty * s.price)  AS total_revenue,
              count(*)              AS line_count
         FROM sales s
         JOIN locations l ON l.id = s.store_id
         ${where}
        GROUP BY s.poster_transaction_id, s.store_id, l.name
        ORDER BY max(s.sold_at) DESC, s.poster_transaction_id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );

    if (receipts.length === 0) {
      res.status(200).json({ items: [], total, limit, offset });
      return;
    }

    // 3) Per-(check, product) sold qty for this page of checks.
    const txnIds = receipts.map((r) => r.poster_transaction_id);
    const storeIds = receipts.map((r) => r.store_id);
    const { rows: lineRows } = await query<{
      poster_transaction_id: string;
      store_id: string;
      product_id: string;
      product_name: string;
      product_unit: string;
      sold_qty: string;
    }>(
      `SELECT s.poster_transaction_id,
              s.store_id,
              s.product_id,
              p.name        AS product_name,
              p.unit        AS product_unit,
              sum(s.qty)    AS sold_qty
         FROM sales s
         JOIN products p ON p.id = s.product_id
        WHERE s.poster_transaction_id = ANY($1::bigint[])
          AND s.store_id = ANY($2::bigint[])
        GROUP BY s.poster_transaction_id, s.store_id, s.product_id, p.name, p.unit`,
      [txnIds, storeIds],
    );

    // 4) Current on-hand for every (store, product) we report — the anchor for
    //    the backward reconciliation. A missing stock row = 0.
    const reportStoreIds = [...new Set(lineRows.map((r) => Number(r.store_id)))];
    const reportProductIds = [...new Set(lineRows.map((r) => Number(r.product_id)))];
    const { rows: stockRows } = await query<{
      location_id: string;
      product_id: string;
      qty: string;
    }>(
      `SELECT location_id, product_id, qty
         FROM stock
        WHERE location_id = ANY($1::bigint[])
          AND product_id  = ANY($2::bigint[])`,
      [reportStoreIds, reportProductIds],
    );
    const currentStock = new Map<string, number>();
    for (const r of stockRows) {
      currentStock.set(`${r.location_id}:${r.product_id}`, Number(r.qty));
    }

    // 5) Total sold per (store, product) across the ENTIRE window — seeds the
    //    backward walk from the live stock head (so the newest check in the
    //    window opens at the window head: live_stock + Σ window sales).
    const { rows: windowSoldRows } = await query<{
      store_id: string;
      product_id: string;
      sold_qty: string;
    }>(
      `SELECT s.store_id, s.product_id, sum(s.qty) AS sold_qty
         FROM sales s
         ${where}
          AND s.store_id  = ANY($${params.length + 1}::bigint[])
          AND s.product_id = ANY($${params.length + 2}::bigint[])
        GROUP BY s.store_id, s.product_id`,
      [...params, reportStoreIds, reportProductIds],
    );
    const openingCursor = new Map<string, number>();
    for (const r of windowSoldRows) {
      const key = `${r.store_id}:${r.product_id}`;
      const cur = currentStock.get(key) ?? 0;
      openingCursor.set(key, cur + Number(r.sold_qty));
    }

    // 5b) Pagination correction. The window-head seed (step 5) is the opening
    //     of the NEWEST check in the window, but this page may start `offset`
    //     checks deep. Every check newer than this page's first row has already
    //     drawn its sold qty down from the head, so step the cursor down by the
    //     sales of those `offset` preceding checks before walking the page.
    //     Without this, opening/remaining are overstated and `has_force_majeure`
    //     misfires whenever offset > 0. (offset === 0 → page starts at the head,
    //     nothing to subtract.)
    if (offset > 0) {
      const precedingParams: SqlParam[] = [
        ...params,
        reportStoreIds,
        reportProductIds,
        offset,
      ];
      const precedingLimitIdx = precedingParams.length;
      const { rows: precedingSoldRows } = await query<{
        store_id: string;
        product_id: string;
        sold_qty: string;
      }>(
        // The `offset` checks that sort BEFORE this page (same ORDER BY as the
        // header page), then their per-(store,product) sold totals.
        `WITH preceding_checks AS (
           SELECT s.poster_transaction_id, s.store_id
             FROM sales s
             ${where}
              AND s.store_id  = ANY($${params.length + 1}::bigint[])
              AND s.product_id = ANY($${params.length + 2}::bigint[])
            GROUP BY s.poster_transaction_id, s.store_id
            ORDER BY max(s.sold_at) DESC, s.poster_transaction_id DESC
            LIMIT $${precedingLimitIdx}
         )
         SELECT s.store_id, s.product_id, sum(s.qty) AS sold_qty
           FROM sales s
           JOIN preceding_checks pc
             ON pc.poster_transaction_id = s.poster_transaction_id
            AND pc.store_id = s.store_id
          WHERE s.product_id = ANY($${params.length + 2}::bigint[])
          GROUP BY s.store_id, s.product_id`,
        precedingParams,
      );
      for (const r of precedingSoldRows) {
        const key = `${r.store_id}:${r.product_id}`;
        const cur = openingCursor.get(key) ?? 0;
        openingCursor.set(key, cur - Number(r.sold_qty));
      }
    }

    // 6) Group lines by check, then walk checks NEWEST→OLDEST (header order),
    //    stepping the opening cursor down by each check's sold qty.
    const linesByReceipt = new Map<string, typeof lineRows>();
    for (const r of lineRows) {
      const key = `${r.poster_transaction_id}:${r.store_id}`;
      const arr = linesByReceipt.get(key) ?? [];
      arr.push(r);
      linesByReceipt.set(key, arr);
    }
    const receiptLines = new Map<string, ReceiptStockLine[]>();
    const receiptForceMajeure = new Map<string, boolean>();
    for (const header of receipts) {
      const rKey = `${header.poster_transaction_id}:${header.store_id}`;
      const lines = linesByReceipt.get(rKey) ?? [];
      const out: ReceiptStockLine[] = [];
      let fm = false;
      for (const l of lines) {
        const spKey = `${l.store_id}:${l.product_id}`;
        const opening = openingCursor.get(spKey) ?? 0;
        const sold = Number(l.sold_qty);
        const remaining = round4(opening - sold);
        if (remaining < 0) fm = true;
        out.push({
          product_id: Number(l.product_id),
          product_name: l.product_name,
          product_unit: l.product_unit,
          opening_qty: round4(opening),
          sold_qty: round4(sold),
          remaining_qty: remaining,
        });
        openingCursor.set(spKey, opening - sold);
      }
      out.sort((a, b) => b.sold_qty - a.sold_qty || a.product_id - b.product_id);
      receiptLines.set(rKey, out);
      receiptForceMajeure.set(rKey, fm);
    }

    const items: ReceiptWithStock[] = receipts.map((r) => {
      const rKey = `${r.poster_transaction_id}:${r.store_id}`;
      return {
        poster_transaction_id: Number(r.poster_transaction_id),
        store_id: Number(r.store_id),
        store_name: r.store_name,
        sold_at: r.sold_at.toISOString(),
        total_qty: Number(r.total_qty),
        total_revenue: Number(r.total_revenue),
        line_count: Number(r.line_count),
        lines: receiptLines.get(rKey) ?? [],
        has_force_majeure: receiptForceMajeure.get(rKey) ?? false,
      };
    });

    res.status(200).json({ items, total, limit, offset });
  }),
);

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
