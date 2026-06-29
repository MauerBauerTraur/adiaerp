/**
 * ADR-0016 §2.2 / R3 — stage-aware BOM reading.
 *
 * The zagatovka -> ukrasheniye flow splits a finished cake's recipe into
 * stages (`recipes.stage`, migration 0029):
 *
 *   * 'base'       — hamir/asos that becomes the zagatovka (the 70%-done cake).
 *   * 'decoration' — krem/bezak + the zagatovka (semi) component itself; this
 *                    is the ukrasheniye pass that produces the FINISHED cake.
 *   * 'assembly'   — optional bake/fill step.
 *
 * The production-input check + the "done" flow for a FINAL (finished) order
 * must read ONLY the `decoration` lines — the `base` (hamir) is produced
 * separately as a zagatovka sub-order and consumed FROM sex_storage as the
 * semi component. If the `base` lines were also read here, the hamir
 * components would be transferred / consumed TWICE (R3 — the bug ADR-0016
 * §7 warns about).
 *
 * BACKWARD COMPATIBILITY (R1 / 0029 default): Poster-synced recipes are flat
 * and entirely `base` (the default). A recipe with NO `decoration` line is a
 * legacy single-pass product — we read EVERY line, exactly like the old flow.
 * Only once a recipe has been curated into base/decoration (EPIC 1.3/1.5)
 * does the two-pass behaviour kick in.
 *
 * `readFinalBom` returns the lines the FINAL order consumes:
 *   - if the recipe has any `decoration` line  -> only the `decoration` lines;
 *   - otherwise (legacy / all-base)            -> all lines.
 *
 * `readBaseBom` returns the `base` lines a zagatovka sub-order consumes.
 */
import type { TxClient } from '../db/index.js';

export type BomLine = {
  readonly component_product_id: number;
  readonly qty_per_unit: number;
};

/** A queryable client — the pool runner or an open transaction. */
type Runner = Pick<TxClient, 'query'>;

/**
 * The BOM lines a FINAL (finished) production order consumes. When the recipe
 * has been split (any `decoration` line exists) we return ONLY the decoration
 * lines — the base/hamir is handled by a separate zagatovka sub-order. A
 * legacy flat recipe (no decoration) returns every line unchanged.
 */
export async function readFinalBom(
  runner: Runner,
  productId: number,
): Promise<BomLine[]> {
  const { rows: deco } = await runner.query<BomLine>(
    `SELECT component_product_id, qty_per_unit
       FROM recipes WHERE product_id = $1 AND stage = 'decoration'`,
    [productId],
  );
  if (deco.length > 0) {
    return deco.map(normalize);
  }
  // Legacy / all-base recipe — read every line (old single-pass behaviour).
  const { rows: all } = await runner.query<BomLine>(
    `SELECT component_product_id, qty_per_unit FROM recipes WHERE product_id = $1`,
    [productId],
  );
  return all.map(normalize);
}

/**
 * The `base` (hamir/asos) BOM lines for a product — what a zagatovka
 * sub-order consumes to MAKE the zagatovka. Returns the explicit `base`
 * rows; for a legacy flat recipe these are simply all of them.
 */
export async function readBaseBom(
  runner: Runner,
  productId: number,
): Promise<BomLine[]> {
  const { rows } = await runner.query<BomLine>(
    `SELECT component_product_id, qty_per_unit
       FROM recipes WHERE product_id = $1 AND stage = 'base'`,
    [productId],
  );
  return rows.map(normalize);
}

/**
 * The decoration component that is itself a `semi` product (the zagatovka).
 * Used by the dialog engine to find which component is the half-finished cake
 * whose on-hand sex_storage qty decides "tayyordan or 0dan". Returns null when
 * the decoration BOM has no semi component (e.g. a legacy product).
 */
export async function findZagatovkaComponent(
  runner: Runner,
  productId: number,
): Promise<BomLine | null> {
  const { rows } = await runner.query<BomLine>(
    `SELECT r.component_product_id, r.qty_per_unit
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
      WHERE r.product_id = $1 AND r.stage = 'decoration' AND p.type = 'semi'
      ORDER BY r.component_product_id
      LIMIT 1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined ? null : normalize(row);
}

function normalize(line: BomLine): BomLine {
  return {
    component_product_id: Number(line.component_product_id),
    qty_per_unit: Number(line.qty_per_unit),
  };
}
