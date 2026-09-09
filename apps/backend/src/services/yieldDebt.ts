/**
 * Yield-debt ledger (migration 0060).
 *
 * When a production order finishes with `actual_qty` different from the
 * ordered `qty`, the (product, location) pair owes or is owed a difference:
 *   - actual_qty < qty  -> shortfall  -> open a new debt row.
 *   - actual_qty > qty  -> surplus    -> settle open debts FIFO (oldest first).
 *
 * Raw-material consumption is untouched by this ledger — the BOM is always
 * consumed at the ordered `qty` because that is what was actually dispatched
 * to the department, regardless of how much finished product came back.
 */
import type { TxClient } from '../db/index.js';

export type YieldDebtRow = {
  id: number;
  product_id: number;
  location_id: number;
  qty_owed: number;
  status: string;
  source_production_order_id: number | null;
  created_at: Date;
};

/**
 * Apply a produced-vs-ordered delta to the yield-debt ledger for one
 * (product, location) pair. Must run inside the same transaction as the
 * production order's "done" flip so the ledger never drifts from reality.
 */
export async function applyYieldDelta(
  tx: TxClient,
  productId: number,
  locationId: number,
  delta: number,
  productionOrderId: number,
): Promise<void> {
  if (delta === 0) return;

  if (delta < 0) {
    // Shortfall — open a new debt for the missing quantity.
    await tx.query(
      `INSERT INTO production_yield_debts (product_id, location_id, qty_owed, source_production_order_id)
       VALUES ($1, $2, $3, $4)`,
      [productId, locationId, Math.abs(delta), productionOrderId],
    );
    return;
  }

  // Surplus — settle open debts oldest-first until the surplus runs out.
  let remaining = delta;
  const { rows: openDebts } = await tx.query<{ id: number; qty_owed: number }>(
    `SELECT id, qty_owed::float AS qty_owed FROM production_yield_debts
      WHERE product_id = $1 AND location_id = $2 AND status = 'open'
      ORDER BY created_at ASC
      FOR UPDATE`,
    [productId, locationId],
  );
  for (const debt of openDebts) {
    if (remaining <= 0) break;
    const owed = Number(debt.qty_owed);
    if (remaining >= owed) {
      await tx.query(
        `UPDATE production_yield_debts
            SET status = 'resolved', resolved_at = now(), resolved_by_order_id = $2
          WHERE id = $1`,
        [debt.id, productionOrderId],
      );
      remaining -= owed;
    } else {
      await tx.query(
        `UPDATE production_yield_debts SET qty_owed = qty_owed - $2 WHERE id = $1`,
        [debt.id, remaining],
      );
      remaining = 0;
    }
  }
  // Any leftover surplus beyond outstanding debts is simply extra output —
  // not tracked as a "credit"; the ledger only ever tracks what is owed.
}

/** Open debts, newest-created-debt-per-(product,location) — for dashboards. */
export async function listOpenYieldDebts(
  tx: TxClient,
  locationId?: number,
): Promise<Array<YieldDebtRow & { product_name: string; product_unit: string; location_name: string }>> {
  const params: number[] = [];
  let where = `WHERE d.status = 'open'`;
  if (locationId !== undefined) {
    params.push(locationId);
    where += ` AND d.location_id = $${params.length}`;
  }
  const { rows } = await tx.query<
    YieldDebtRow & { product_name: string; product_unit: string; location_name: string }
  >(
    `SELECT d.id, d.product_id, d.location_id, d.qty_owed::float AS qty_owed,
            d.status, d.source_production_order_id, d.created_at,
            p.name AS product_name, p.unit::text AS product_unit,
            l.name AS location_name
       FROM production_yield_debts d
       JOIN products p ON p.id = d.product_id
       JOIN locations l ON l.id = d.location_id
       ${where}
      ORDER BY d.created_at ASC`,
    params,
  );
  return rows;
}
