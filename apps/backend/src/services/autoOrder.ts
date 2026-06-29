/**
 * Auto-production-order service.
 *
 * After today's sales are synced from Poster, this service checks every sold
 * product: if its stock at the designated storage location has fallen below
 * `products.min_qty`, a production order is automatically created.
 *
 * Flow per sold product:
 *   1. Resolve stock at `products.storage_location_id`.
 *   2. If `stock.qty < min_qty` → compute qty to produce (fill to max_qty or to
 *      2×min_qty when max_qty is not set).
 *   3. Dedup: skip when an open (new|in_progress) order for the same product
 *      already exists today.
 *   4. INSERT production_orders with `created_by = NULL` (system).
 *   5. BOM-expand → create sub-orders for semi-finished components.
 *   6. Create dispatch records for direct raw materials.
 *   7. Notify pm + production_manager roles.
 */

import { query, withTransaction } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import {
  createNotificationsForRecipients,
  getUsersByRole,
} from './notify.js';
import { PRODUCTION_ORDER_COLUMNS, type ProductionOrderRow } from './productionOrder.js';

export type AutoOrderResult = {
  readonly checked: number;   // products evaluated
  readonly created: number;   // production orders created
  readonly skipped: number;   // already had an open order today
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type CandidateProduct = {
  product_id: number;
  product_name: string;
  unit: string;
  min_qty: number;
  max_qty: number | null;
  production_location_id: number;
  storage_location_id: number | null;
  current_stock: number;
};

type BomNode = {
  component_product_id: number;
  component_name: string;
  component_type: string;
  component_unit: string;
  qty: number;
  brutto: number | null;
};

// ---------------------------------------------------------------------------
// BOM expansion (standalone — mirrors route handler's expandBom)
// ---------------------------------------------------------------------------

async function expandBom(
  productId: number,
  scale: number,
  depth: number,
  maxDepth = 6,
): Promise<BomNode[]> {
  if (depth >= maxDepth) return [];
  const { rows } = await query<{
    component_product_id: number;
    component_name: string;
    component_type: string;
    component_unit: string;
    qty_per_unit: number;
    brutto: number | null;
  }>(
    `SELECT r.component_product_id,
            p.name   AS component_name,
            p.type   AS component_type,
            p.unit   AS component_unit,
            r.qty_per_unit::float8 AS qty_per_unit,
            r.brutto::float8       AS brutto
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
      WHERE r.product_id = $1
      ORDER BY r.id`,
    [productId],
  );
  const nodes: BomNode[] = [];
  for (const r of rows) {
    const qty = r.qty_per_unit * scale;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const brutto = r.brutto !== null ? r.brutto * scale : null;
    nodes.push({ ...r, qty, brutto });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Single production order insert (system context: created_by=null)
// ---------------------------------------------------------------------------

async function insertOrder(params: {
  productId: number;
  qty: number;
  locationId: number;
  targetLocationId: number | null;
  note: string;
  parentOrderId: number | null;
  stageRole: string | null;
}): Promise<ProductionOrderRow> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<ProductionOrderRow>(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, note,
          stage_role, parent_production_order_id, deadline, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, NULL)
       RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      [
        params.productId,
        params.qty,
        params.locationId,
        params.targetLocationId,
        params.note,
        params.stageRole,
        params.parentOrderId,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('auto-order: INSERT returned no row');

    await writeAudit(tx, {
      actorUserId: null,
      action: 'production_order.auto_create',
      entity: 'production_orders',
      entityId: row.id,
      payload: {
        product_id: params.productId,
        qty: params.qty,
        location_id: params.locationId,
        parent_production_order_id: params.parentOrderId,
        trigger: 'sales_below_min',
      },
    });

    // Notify production managers + PMs.
    const productionManagers = await getUsersByRole(tx, 'production_manager');
    const pms = await getUsersByRole(tx, 'pm');
    const recipients = [...productionManagers, ...pms];
    if (recipients.length > 0) {
      const { rows: ctx } = await tx.query<{ product_name: string; product_unit: string }>(
        `SELECT name AS product_name, unit AS product_unit FROM products WHERE id = $1`,
        [params.productId],
      );
      const productName = ctx[0]?.product_name ?? `#${params.productId}`;
      const productUnit = ctx[0]?.product_unit ?? '';
      await createNotificationsForRecipients(tx, recipients, {
        type: 'production_order_created',
        title: `Avtomatik zayafka #${row.id}`,
        body:
          `Zayafka #${row.id}: ${params.qty} ${productUnit} ${productName} — ` +
          `sotuvdan keyin min stock past qoldi, avtomat yaratildi.`,
        payload: {
          production_order_id: row.id,
          product_id: params.productId,
          qty: params.qty,
          location_id: params.locationId,
          auto: true,
        },
        inlineCallback: {
          buttons: [
            [
              { text: '▶️ Boshladim', data: `start:prod:${row.id}` },
              { text: "📋 Ko'rish", data: `view:prod:${row.id}` },
            ],
          ],
        },
      });
    }

    return row;
  });
}

// ---------------------------------------------------------------------------
// Dispatch records for direct raw materials
// ---------------------------------------------------------------------------

async function createDispatchRecords(
  orderId: number,
  bomNodes: BomNode[],
  toLocationId: number,
  rawWarehouseId: number | null,
): Promise<void> {
  const directRawMap = new Map<
    number,
    { product_id: number; name: string; unit: string; qty: number }
  >();

  for (const node of bomNodes) {
    if (node.component_type === 'raw') {
      const dispatchQty = node.brutto != null && node.brutto > 0 ? node.brutto : node.qty;
      const existing = directRawMap.get(node.component_product_id);
      if (existing) {
        existing.qty += dispatchQty;
      } else {
        directRawMap.set(node.component_product_id, {
          product_id: node.component_product_id,
          name: node.component_name,
          unit: node.component_unit,
          qty: dispatchQty,
        });
      }
    } else if (node.component_type === 'semi' || node.component_type === 'finished') {
      const { rows } = await query<{ production_location_id: number | null }>(
        `SELECT production_location_id FROM products WHERE id = $1`,
        [node.component_product_id],
      );
      const fromLocId = rows[0]?.production_location_id ?? null;
      if (fromLocId !== null && fromLocId !== toLocationId) {
        await query(
          `INSERT INTO production_dispatches
             (production_order_id, product_id, product_name, product_unit,
              qty_needed, from_location_id, to_location_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, node.component_product_id, node.component_name,
           node.component_unit, node.qty, fromLocId, toLocationId],
        );
      }
    }
  }

  for (const line of directRawMap.values()) {
    await query(
      `INSERT INTO production_dispatches
         (production_order_id, product_id, product_name, product_unit,
          qty_needed, from_location_id, to_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, line.product_id, line.name, line.unit,
       line.qty, rawWarehouseId, toLocationId],
    );
  }
}

// ---------------------------------------------------------------------------
// Recursive sub-order creation for semi-finished BOM components
// ---------------------------------------------------------------------------

async function createSubOrders(
  bomNodes: BomNode[],
  parentOrderId: number,
  defaultSubLocationId: number,
  rawWarehouseId: number | null,
  depth: number,
): Promise<void> {
  if (depth >= 5) return;
  for (const node of bomNodes) {
    if (node.component_type !== 'semi' && node.component_type !== 'finished') continue;

    const { rows: prodLocRows } = await query<{ production_location_id: number | null }>(
      `SELECT production_location_id FROM products WHERE id = $1`,
      [node.component_product_id],
    );
    const subLocationId = prodLocRows[0]?.production_location_id ?? defaultSubLocationId;

    // Check stock — clamp negative (data anomaly) to zero.
    const { rows: stockRows } = await query<{ qty: string }>(
      `SELECT COALESCE(qty, 0)::text AS qty
         FROM stock WHERE location_id = $1 AND product_id = $2`,
      [subLocationId, node.component_product_id],
    );
    const available = Math.max(0, Number(stockRows[0]?.qty ?? 0));
    // Use brutto: the gross input amount the parent stage requires.
    const neededQty = node.brutto != null && node.brutto > 0 ? node.brutto : node.qty;
    if (available >= neededQty) continue; // enough in stock — skip

    const subQty = neededQty - available;
    const subOrder = await insertOrder({
      productId: node.component_product_id,
      qty: subQty,
      locationId: subLocationId,
      targetLocationId: null,
      note: `Avtomat: #${parentOrderId} uchun (${node.component_name})`,
      parentOrderId,
      stageRole: 'zagatovka',
    });

    const subBom = await expandBom(node.component_product_id, subQty, 0);
    try {
      await createDispatchRecords(subOrder.id, subBom, subLocationId, rawWarehouseId);
    } catch {
      // dispatch failure doesn't abort sub-order
    }
    await createSubOrders(subBom, subOrder.id, defaultSubLocationId, rawWarehouseId, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Check today's sold products against stock minimums and auto-create
 * production orders for any product that has fallen below `min_qty`.
 *
 * Safe to call repeatedly — deduplication skips products that already have
 * an open (new|in_progress) production order created today.
 */
export async function checkSoldProductsAndCreateOrders(): Promise<AutoOrderResult> {
  // 1. Find all products sold today whose stock at storage_location is below min_qty.
  const { rows: candidates } = await query<CandidateProduct>(
    `SELECT DISTINCT ON (p.id)
            p.id                        AS product_id,
            p.name                      AS product_name,
            p.unit,
            p.min_qty::float8           AS min_qty,
            p.max_qty::float8           AS max_qty,
            p.production_location_id,
            p.storage_location_id,
            COALESCE(st.qty, 0)::float8 AS current_stock
       FROM sales sa
       JOIN products p ON p.id = sa.product_id
       LEFT JOIN stock st
         ON st.product_id = p.id
        AND st.location_id = p.storage_location_id
      WHERE sa.sold_at >= CURRENT_DATE - INTERVAL '7 days'
        AND p.min_qty IS NOT NULL
        AND p.min_qty > 0
        AND p.production_location_id IS NOT NULL
        AND COALESCE(st.qty, 0) < p.min_qty
      ORDER BY p.id`,
  );

  if (candidates.length === 0) {
    return { checked: 0, created: 0, skipped: 0 };
  }

  // 2. Resolve raw warehouse location (for dispatch records).
  const { rows: rawWhRows } = await query<{ id: number }>(
    `SELECT id FROM locations WHERE type = 'raw_warehouse' LIMIT 1`,
  );
  const rawWarehouseId = rawWhRows[0]?.id ?? null;

  // 3. Resolve default zagatovka location fallback.
  let defaultSubLocationId: number = candidates[0]!.production_location_id;
  try {
    const { rows: zagRows } = await query<{ id: number }>(
      `SELECT id FROM locations WHERE stage_role = 'zagatovka' LIMIT 1`,
    );
    if (zagRows[0]?.id) defaultSubLocationId = zagRows[0].id;
  } catch {
    // stage_role not available — use first product's production location
  }

  let created = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      // 4. Dedup: skip if open order already exists for this product today.
      const { rows: existing } = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM production_orders
          WHERE product_id = $1
            AND status IN ('new', 'in_progress')
            AND location_id = $2
            AND created_at >= CURRENT_DATE`,
        [candidate.product_id, candidate.production_location_id],
      );
      if (Number(existing[0]?.cnt ?? 0) > 0) {
        skipped += 1;
        continue;
      }

      // 5. Calculate production quantity: fill to max_qty, or to 2×min if no max.
      const target = candidate.max_qty !== null && candidate.max_qty > 0
        ? candidate.max_qty
        : candidate.min_qty * 2;
      const rawQty = Math.max(target - candidate.current_stock, candidate.min_qty - candidate.current_stock);
      // Round to 2 decimal places for weight-based units; for pcs round up.
      const qty = candidate.unit === 'pcs'
        ? Math.ceil(rawQty)
        : Math.round(rawQty * 100) / 100;

      if (qty <= 0) {
        skipped += 1;
        continue;
      }

      // 6. Create main production order.
      const order = await insertOrder({
        productId: candidate.product_id,
        qty,
        locationId: candidate.production_location_id,
        targetLocationId: candidate.storage_location_id ?? null,
        note: `Avtomatik: sotuvdan keyin min saviyasi past qoldi (${candidate.current_stock} < ${candidate.min_qty} ${candidate.unit})`,
        parentOrderId: null,
        stageRole: 'final',
      });

      // 7. Create dispatch records for main order.
      try {
        const mainBom = await expandBom(candidate.product_id, qty, 0);
        await createDispatchRecords(order.id, mainBom, candidate.production_location_id, rawWarehouseId);

        // Finished-product tracking dispatch: production location → storage location.
        // Always created when storage_location_id is set (even same location), for tracking.
        const storageLocId = candidate.storage_location_id;
        if (storageLocId !== null) {
          const { rows: pRows } = await query<{ name: string; unit: string }>(
            `SELECT name, unit FROM products WHERE id = $1`,
            [candidate.product_id],
          );
          const p = pRows[0];
          if (p) {
            await query(
              `INSERT INTO production_dispatches
                 (production_order_id, product_id, product_name, product_unit,
                  qty_needed, from_location_id, to_location_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [order.id, candidate.product_id, p.name, p.unit, qty,
               candidate.production_location_id, storageLocId],
            );
          }
        }

        // 8. Recursively create sub-orders for semi-finished components.
        await createSubOrders(mainBom, order.id, defaultSubLocationId, rawWarehouseId, 0);
      } catch (bomErr) {
        console.error(
          `[auto-order] BOM/dispatch failed for order #${order.id} product=${candidate.product_id}:`,
          (bomErr as Error).message,
        );
        // Main order stands even if BOM expansion fails
      }

      created += 1;
      console.log(
        `[auto-order] created #${order.id} for product=${candidate.product_id} ` +
          `"${candidate.product_name}" qty=${qty} ${candidate.unit} ` +
          `(stock ${candidate.current_stock} < min ${candidate.min_qty})`,
      );
    } catch (err) {
      console.error(
        `[auto-order] failed for product=${candidate.product_id}:`,
        (err as Error).message,
        (err as Error).stack?.split('\n').slice(0, 3).join(' | '),
      );
    }
  }

  return { checked: candidates.length, created, skipped };
}
