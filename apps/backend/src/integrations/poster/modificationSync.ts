/**
 * Poster modification sync (weight-based product variants).
 *
 * Two Poster systems need syncing:
 *   - type=3 products: per-modification brutto weights via `menu.getProduct`.
 *     The `modificator_id` in those responses matches the `modification_id`
 *     that appears in Poster sales transactions.
 *   - type=2 products with `group_modifications`: size variants (ЦЕЛЫЙ/ПОЛОВИНА/КУСОК)
 *     defined in `dish_modification_id` fields. NOTE: these IDs do NOT match the
 *     `modification_id` in transactions for type=2 products — Poster uses a separate
 *     ID space for transaction-level modifications of type=2 items.
 *
 * This module:
 *   - `syncModifications(client)` — upserts both type=3 and type=2 variants into
 *     `poster_product_modifications`. Run hourly (piggybacking on recipe sync).
 *   - `getModificationQtyFactor(posterProductId, modificationId)` — returns
 *     the fraction of 1 full unit that a given modification represents:
 *       factor = mod_weight_g / max_weight_g_for_product
 *     E.g., КУСОК 55.55g / ЦЕЛЫЙ 1000g = 0.05555. Returns 1.0 on cache miss.
 */
import { query } from '../../db/index.js';
import type { PosterClient } from './client.js';

export async function syncModifications(client: PosterClient): Promise<{
  productsScanned: number;
  modificationsUpserted: number;
}> {
  const products = await client.getProducts();

  let modificationsUpserted = 0;

  // --- type=3 products: use their own modificator_id system ---
  const type3 = products.filter((p) => String(p.type) === '3');
  for (const prod of type3) {
    const posterProductId = Number(prod.product_id);
    if (!Number.isFinite(posterProductId) || posterProductId <= 0) continue;

    let full;
    try {
      full = await client.getProduct(posterProductId);
    } catch {
      continue;
    }
    if (!full?.modifications?.length) continue;

    // Prefer 'finished' type ERP product when multiple products share the
    // same poster_product_id (e.g. both "ТВОРОЖНЫЙ" and "Г/П ТВОРОЖНЫЙ (ЦЕЛЫЙ)"
    // are linked to the same Poster product — the finished one is canonical).
    const { rows: pidRows } = await query<{ id: number }>(
      `SELECT id FROM products
       WHERE poster_product_id = $1
       ORDER BY (type = 'finished') DESC, id
       LIMIT 1`,
      [posterProductId],
    );
    const productId = pidRows[0]?.id ?? null;

    for (const mod of full.modifications) {
      const modId = Number(mod.modificator_id);
      if (!Number.isFinite(modId) || modId <= 0) continue;

      const rawWeight = mod.product_weight;
      const weightG =
        rawWeight != null && rawWeight !== '' && Number(rawWeight) > 0
          ? Number(rawWeight)
          : null;

      await query(
        `INSERT INTO poster_product_modifications
           (modification_id, poster_product_id, product_id, name, weight_g, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (modification_id, poster_product_id) DO UPDATE
           SET product_id        = EXCLUDED.product_id,
               name              = EXCLUDED.name,
               weight_g          = EXCLUDED.weight_g,
               synced_at         = EXCLUDED.synced_at`,
        [modId, posterProductId, productId, mod.modificator_name ?? '', weightG],
      );
      modificationsUpserted += 1;
    }
  }

  // --- type=2 products with group_modifications: use dish_modification_id ---
  // NOTE: dish_modification_id values do NOT match the modification_id seen in
  // Poster transactions for type=2 products — they come from different ID systems.
  // We upsert them here so the weights are available if the ID systems ever align,
  // and to keep a record of the configured size variants. Manually inserted rows
  // for the actual transaction modification_ids take precedence (ON CONFLICT keeps
  // an existing row's weight_g when synced_at does not change).
  const type2WithGroups = products.filter(
    (p) => String(p.type) === '2' && p.group_modifications?.length,
  );
  for (const prod of type2WithGroups) {
    const posterProductId = Number(prod.product_id);
    if (!Number.isFinite(posterProductId) || posterProductId <= 0) continue;

    const { rows: pidRows } = await query<{ id: number }>(
      `SELECT id FROM products
       WHERE poster_product_id = $1
       ORDER BY (type = 'finished') DESC, id
       LIMIT 1`,
      [posterProductId],
    );
    const productId = pidRows[0]?.id ?? null;

    for (const group of prod.group_modifications ?? []) {
      for (const mod of group.modifications ?? []) {
        const modId = Number(mod.dish_modification_id);
        if (!Number.isFinite(modId) || modId <= 0) continue;

        const weightG =
          mod.brutto != null && mod.brutto !== '' && Number(mod.brutto) > 0
            ? Number(mod.brutto)
            : null;

        const name = mod.name ?? '';

        await query(
          `INSERT INTO poster_product_modifications
             (modification_id, poster_product_id, product_id, name, weight_g, synced_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (modification_id, poster_product_id) DO UPDATE
             SET product_id        = EXCLUDED.product_id,
                 name              = COALESCE(NULLIF(EXCLUDED.name, ''), poster_product_modifications.name),
                 weight_g          = EXCLUDED.weight_g,
                 synced_at         = EXCLUDED.synced_at`,
          [modId, posterProductId, productId, name, weightG],
        );
        modificationsUpserted += 1;
      }
    }
  }

  return { productsScanned: type3.length + type2WithGroups.length, modificationsUpserted };
}

/**
 * Returns what fraction of 1 full unit the given modification represents.
 * The "full unit" is derived as the heaviest modification for the product.
 * Returns 1.0 when the modification has no weight or is not in our DB yet.
 */
export async function getModificationQtyFactor(
  posterProductId: number,
  modificationId: number,
): Promise<number> {
  const info = await resolveModificationInfo(posterProductId, modificationId);
  return info.factor;
}

/**
 * Returns the ERP product ID override and qty factor for a given modification.
 * When `product_id` is set in `poster_product_modifications`, that ERP product
 * takes priority over the direct `poster_product_id → products` lookup — this
 * is the canonical way to route modifier-based sales to the correct finished
 * product (e.g. ЦЕЛЫЙ/ПОЛОВИНА/КУСОК all deduct from "Г/П ТВОРОЖНЫЙ (ЦЕЛЫЙ)").
 */
export async function resolveModificationInfo(
  posterProductId: number,
  modificationId: number,
): Promise<{ productId: number | null; factor: number }> {
  const { rows } = await query<{
    weight_g: string | null;
    max_weight_g: string | null;
    product_id: number | null;
  }>(
    `SELECT
       weight_g,
       product_id,
       (SELECT MAX(weight_g)
          FROM poster_product_modifications
         WHERE poster_product_id = $1) AS max_weight_g
     FROM poster_product_modifications
     WHERE poster_product_id = $1 AND modification_id = $2`,
    [posterProductId, modificationId],
  );
  const row = rows[0];
  const w = Number(row?.weight_g ?? 0);
  const base = Number(row?.max_weight_g ?? 0);
  const factor = w > 0 && base > 0 ? w / base : 1.0;
  return { productId: row?.product_id ?? null, factor };
}
