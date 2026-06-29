/**
 * M10 — Poster Поставки (supply deliveries) sync service.
 *
 * Fetches supply headers + ingredient lines from Poster and UPSERTs them
 * into `poster_supplies` + `poster_supply_items`.
 *
 * Flow:
 *   1. `storage.getSupplies(dateFrom, dateTo)` → list of supply headers
 *      (supply_sum is in TIYIN in this endpoint — we divide by 100)
 *   2. For each supply (respecting the 200ms rate-limit gap via client):
 *      `storage.getSupply(id)` → detail with ingredients
 *      (supply_sum / supply_ingredient_sum are in SO'M here)
 *   3. UPSERT header then delete+reinsert items inside one transaction per supply
 */
import { getPool } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import { createPosterClientFromConfig } from './client.js';
import type { PosterSupplyDetail } from './client.js';

export interface SuppliesSyncResult {
  upserted: number;
  skipped: number;
  errors: number;
}

/**
 * Sync supplies for the given date range.
 * `dateFrom` / `dateTo` are `YYYYMMDD` strings (Poster convention).
 */
export async function syncPosterSupplies(
  dateFrom: string,
  dateTo: string,
): Promise<SuppliesSyncResult> {
  const client = createPosterClientFromConfig();
  const pool = getPool();

  const rows = await client.getSupplies({ dateFrom, dateTo });

  let upserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    // Skip soft-deleted supplies
    if (String(row.delete) === '1') {
      skipped++;
      continue;
    }

    const supplyId = Number(row.supply_id);
    if (!Number.isFinite(supplyId)) {
      skipped++;
      continue;
    }

    let detail: PosterSupplyDetail | null = null;
    try {
      detail = await client.getSupply(supplyId);
    } catch {
      // If detail fetch fails, still upsert header from list data
    }

    const dbClient: PoolClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // supply_sum from the list is in TIYIN → convert to so'm
      // supply_sum from the detail is already in so'm
      const supplySum = detail
        ? parseFloat(String(detail.supply_sum)) || 0
        : (parseFloat(String(row.supply_sum)) || 0) / 100;

      await dbClient.query(
        `INSERT INTO poster_supplies
           (id, storage_id, storage_name, supplier_id, supplier_name,
            supply_date, supply_sum, comment, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (id) DO UPDATE SET
           storage_id    = EXCLUDED.storage_id,
           storage_name  = EXCLUDED.storage_name,
           supplier_id   = EXCLUDED.supplier_id,
           supplier_name = EXCLUDED.supplier_name,
           supply_date   = EXCLUDED.supply_date,
           supply_sum    = EXCLUDED.supply_sum,
           comment       = EXCLUDED.comment,
           synced_at     = NOW()`,
        [
          supplyId,
          Number(row.storage_id),
          row.storage_name ?? null,
          row.supplier_id ? Number(row.supplier_id) : null,
          row.supplier_name ?? detail?.supplier_name ?? null,
          row.date,
          supplySum,
          row.supply_comment ?? detail?.supply_comment ?? null,
        ],
      );

      // Replace items if we have detail
      if (detail?.ingredients && detail.ingredients.length > 0) {
        await dbClient.query('DELETE FROM poster_supply_items WHERE supply_id = $1', [supplyId]);
        for (const ing of detail.ingredients) {
          if (Number(ing.ing_delete) === 1) continue;
          await dbClient.query(
            `INSERT INTO poster_supply_items
               (supply_id, ingredient_id, ingredient_name, ingredient_unit, qty, item_sum)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              supplyId,
              Number(ing.ingredient_id),
              ing.ingredient_name,
              ing.ingredient_unit || 'kg',
              parseFloat(String(ing.supply_ingredient_num)) || 0,
              parseFloat(String(ing.supply_ingredient_sum)) || 0,
            ],
          );
        }
      }

      await dbClient.query('COMMIT');
      upserted++;
    } catch (err) {
      await dbClient.query('ROLLBACK');
      errors++;
      console.error(`[suppliesSync] supply_id=${supplyId} failed:`, (err as Error).message);
    } finally {
      dbClient.release();
    }
  }

  return { upserted, skipped, errors };
}
