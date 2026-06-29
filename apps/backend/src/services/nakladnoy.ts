/**
 * EPIC 8.4 — nakladnoy (material requisition) generation service.
 *
 * Owner scenario (changes-2026-05-owner-feedback.md §8.4):
 *   "10 Napoleon sotildi" -> bitta nakladnoy:
 *     • krem uchun (un, shakar, ...)
 *     • hamir uchun (un, shakar, ...)
 *     • ITOGO umumiy un/shakar kg
 *
 * ALGORITHM
 *   Given a finished product P and a demand of N units we read P's recipe by
 *   STAGE (recipes.stage, migration 0029):
 *     - 'base'       -> the HAMIR section (the zagatovka dough/biscuit);
 *     - 'decoration' -> the KREM/BEZAK section (cream + decor + the semi
 *                       zagatovka component itself);
 *     - 'assembly'   -> folded into bezak (optional bake/fill step).
 *
 *   Each stage line is recursively EXPANDED to raw materials: a `semi`
 *   component (a prepack: cream, dough, half-finished cake) is replaced by its
 *   own recipe, multiplied through. Expansion stops at `raw` / `finished`
 *   leaves (a leaf with no recipe). A depth cap guards against a cyclic BOM.
 *
 *   The decoration section's zagatovka (the `base`-derived semi) is NOT
 *   double-counted: the hamir section already carries the base materials, so
 *   when we expand the decoration BOM we SKIP the semi component that is the
 *   zagatovka itself (it would otherwise re-add the same flour/sugar). The
 *   `itogo` section then sums each leaf raw across hamir + krem + bezak.
 *
 * INVARIANTS
 *   - This service NEVER mutates stock and NEVER calls Poster (egasi qarori:
 *     nakladnoy faqat ADIA ichida). It only INSERTs the document + lines and
 *     writes ONE audit row, all inside the caller's transaction.
 *   - Numbers stay finite: a non-numeric qty_per_unit is treated as 0.
 *
 * The pure expansion (`expandToNakladnoy`) is separated from persistence
 * (`createNakladnoy`) so it is unit-testable without a DB.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { AppError } from '../errors/index.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type NakladnoySection = 'hamir' | 'krem' | 'bezak' | 'itogo';
export type NakladnoySource =
  | 'sale'
  | 'manual'
  | 'voice'
  | 'cash_shift'
  | 'safe_expense'
  | 'production_order';

/** A computed nakladnoy line, pre-persistence. */
export type NakladnoyLine = {
  readonly section: NakladnoySection;
  readonly component_product_id: number | null;
  readonly label: string;
  readonly qty: number;
  readonly unit: string;
};

/** A recipe row joined with its component's identity, used for expansion. */
type RecipeRow = {
  readonly product_id: number;
  readonly component_product_id: number;
  readonly qty_per_unit: number;
  readonly stage: 'base' | 'decoration' | 'assembly';
  readonly component_type: 'raw' | 'semi' | 'finished';
  readonly component_name: string;
  readonly component_unit: string;
};

const MAX_EXPANSION_DEPTH = 8;

// -----------------------------------------------------------------------------
// Recipe loading
// -----------------------------------------------------------------------------

type Runner = Pick<TxClient, 'query'>;

/**
 * Load every recipe row for `productId` AND, transitively, for any `semi`
 * component it references — in one pass per level, capped by depth. Returns a
 * map keyed by product_id so the in-memory expansion never re-queries.
 */
async function loadRecipeTree(
  runner: Runner,
  rootProductId: number,
): Promise<Map<number, RecipeRow[]>> {
  const byProduct = new Map<number, RecipeRow[]>();
  let frontier: number[] = [rootProductId];
  let depth = 0;
  while (frontier.length > 0 && depth < MAX_EXPANSION_DEPTH) {
    const pending = frontier.filter((id) => !byProduct.has(id));
    if (pending.length === 0) break;
    const { rows } = await runner.query<RecipeRow>(
      `SELECT r.product_id, r.component_product_id, r.qty_per_unit, r.stage,
              p.type::text  AS component_type,
              p.name        AS component_name,
              p.unit::text  AS component_unit
         FROM recipes r
         JOIN products p ON p.id = r.component_product_id
        WHERE r.product_id = ANY($1::bigint[])`,
      [pending],
    );
    for (const id of pending) {
      if (!byProduct.has(id)) byProduct.set(id, []);
    }
    const nextSemi: number[] = [];
    for (const row of rows) {
      const norm: RecipeRow = {
        product_id: Number(row.product_id),
        component_product_id: Number(row.component_product_id),
        qty_per_unit: toFinite(row.qty_per_unit),
        stage: row.stage,
        component_type: row.component_type,
        component_name: row.component_name,
        component_unit: row.component_unit,
      };
      byProduct.get(norm.product_id)!.push(norm);
      if (norm.component_type === 'semi') nextSemi.push(norm.component_product_id);
    }
    frontier = nextSemi;
    depth += 1;
  }
  return byProduct;
}

// -----------------------------------------------------------------------------
// Pure expansion
// -----------------------------------------------------------------------------

type RawAccumulator = Map<
  number,
  { qty: number; label: string; unit: string }
>;

/**
 * Recursively expand one component into raw/finished leaves, accumulating qty
 * into `acc` keyed by leaf product id. A `semi` with its own recipe is
 * replaced by its components; a `semi` with NO recipe (or hit depth cap) is
 * treated as a leaf so nothing is silently dropped.
 */
function expandComponent(
  tree: Map<number, RecipeRow[]>,
  productId: number,
  multiplier: number,
  leaf: { name: string; unit: string },
  acc: RawAccumulator,
  depth: number,
): void {
  const sub = tree.get(productId);
  const isSemiWithRecipe =
    sub !== undefined && sub.length > 0 && depth < MAX_EXPANSION_DEPTH;
  if (!isSemiWithRecipe) {
    const prev = acc.get(productId);
    if (prev === undefined) {
      acc.set(productId, { qty: multiplier, label: leaf.name, unit: leaf.unit });
    } else {
      prev.qty += multiplier;
    }
    return;
  }
  for (const row of sub) {
    expandComponent(
      tree,
      row.component_product_id,
      multiplier * row.qty_per_unit,
      { name: row.component_name, unit: row.component_unit },
      acc,
      depth + 1,
    );
  }
}

/**
 * Build the sectioned nakladnoy lines for `qty` units of `rootProductId`.
 * Pure — takes the pre-loaded recipe tree, returns lines (no DB, no IO).
 *
 * Sectioning (ADR-0016 OQ3 — each finished cake points at its OWN semi
 * zagatovka via its decoration BOM):
 *   - hamir = expansion of the `base` stage lines AND the zagatovka semi (the
 *             FIRST semi component in the decoration BOM) — both represent the
 *             dough/biscuit of the half-finished cake.
 *   - krem  = expansion of the `decoration` stage lines that are NOT the
 *             zagatovka semi (cream + any other decoration component).
 *   - bezak = expansion of the `assembly` stage lines (optional bake/fill).
 *   - itogo = per-leaf grand total across hamir + krem + bezak.
 *
 * The zagatovka semi appears in the hamir section ONLY — never in krem — so
 * its flour/sugar is counted once (no double-count, the R3 bug ADR-0016 warns
 * of). Non-zagatovka decoration semis (cream) expand into krem normally.
 *
 * Backward compat: a legacy flat recipe (every line `base`, no decoration)
 * yields a single `hamir` section + `itogo` — exactly the materials the old
 * single-pass flow consumes.
 */
export function expandToNakladnoy(
  tree: Map<number, RecipeRow[]>,
  rootProductId: number,
  qty: number,
): NakladnoyLine[] {
  const root = tree.get(rootProductId) ?? [];
  const baseLines = root.filter((r) => r.stage === 'base');
  const decoLines = root.filter((r) => r.stage === 'decoration');
  const asmLines = root.filter((r) => r.stage === 'assembly');

  // The zagatovka = the FIRST `semi` component in the decoration BOM (matches
  // `findZagatovkaComponent` in bom.ts; ADR-0016 OQ3). It belongs to the hamir
  // section. Any OTHER decoration component (cream, decor) stays in krem.
  const zagatovka =
    decoLines
      .filter((r) => r.component_type === 'semi')
      .sort((a, b) => a.component_product_id - b.component_product_id)[0] ?? null;
  const zagatovkaId = zagatovka?.component_product_id ?? null;

  const hamirAcc: RawAccumulator = new Map();
  for (const r of baseLines) {
    expandComponent(
      tree,
      r.component_product_id,
      qty * r.qty_per_unit,
      { name: r.component_name, unit: r.component_unit },
      hamirAcc,
      1,
    );
  }
  // The zagatovka semi's own dough also feeds the hamir section.
  if (zagatovka !== null) {
    expandComponent(
      tree,
      zagatovka.component_product_id,
      qty * zagatovka.qty_per_unit,
      { name: zagatovka.component_name, unit: zagatovka.component_unit },
      hamirAcc,
      1,
    );
  }

  const kremAcc: RawAccumulator = new Map();
  for (const r of decoLines) {
    if (zagatovkaId !== null && r.component_product_id === zagatovkaId) continue;
    expandComponent(
      tree,
      r.component_product_id,
      qty * r.qty_per_unit,
      { name: r.component_name, unit: r.component_unit },
      kremAcc,
      1,
    );
  }

  const bezakAcc: RawAccumulator = new Map();
  for (const r of asmLines) {
    expandComponent(
      tree,
      r.component_product_id,
      qty * r.qty_per_unit,
      { name: r.component_name, unit: r.component_unit },
      bezakAcc,
      1,
    );
  }

  const lines: NakladnoyLine[] = [];
  pushSection(lines, 'hamir', hamirAcc);
  pushSection(lines, 'krem', kremAcc);
  pushSection(lines, 'bezak', bezakAcc);

  // ITOGO — sum each leaf across all sections.
  const itogo: RawAccumulator = new Map();
  for (const acc of [hamirAcc, kremAcc, bezakAcc]) {
    for (const [pid, v] of acc) {
      const prev = itogo.get(pid);
      if (prev === undefined) {
        itogo.set(pid, { qty: v.qty, label: v.label, unit: v.unit });
      } else {
        prev.qty += v.qty;
      }
    }
  }
  pushSection(lines, 'itogo', itogo);
  return lines;
}

function pushSection(
  out: NakladnoyLine[],
  section: NakladnoySection,
  acc: RawAccumulator,
): void {
  // Deterministic order — by component id ascending.
  const entries = [...acc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [pid, v] of entries) {
    if (v.qty <= 0) continue;
    out.push({
      section,
      component_product_id: pid,
      label: v.label,
      qty: round4(v.qty),
      unit: v.unit,
    });
  }
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

export type NakladnoyHeader = {
  readonly id: number;
  readonly source: NakladnoySource;
  readonly source_ref: string | null;
  readonly product_id: number | null;
  readonly qty: number;
  readonly location_id: number | null;
  readonly total_amount: number;
  readonly created_by: number | null;
  readonly created_at: string;
};

export type CreateNakladnoyInput = {
  readonly source: NakladnoySource;
  readonly sourceRef?: string | null;
  readonly productId: number;
  readonly qty: number;
  readonly locationId?: number | null;
  readonly note?: string | null;
  readonly actorUserId: number | null;
};

export type NakladnoyResult = {
  readonly header: NakladnoyHeader;
  readonly lines: NakladnoyLine[];
};

/**
 * Generate AND persist a material nakladnoy for `qty` units of a finished
 * product. Runs in its own transaction (or a supplied one) — header + lines +
 * audit commit together. No stock mutation, no Poster call.
 */
export async function createNakladnoy(
  input: CreateNakladnoyInput,
  tx?: TxClient,
): Promise<NakladnoyResult> {
  if (!Number.isInteger(input.productId) || input.productId <= 0) {
    throw AppError.validation('nakladnoy: product_id is invalid.');
  }
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw AppError.validation('nakladnoy: qty must be a positive number.');
  }
  const run = async (txc: TxClient): Promise<NakladnoyResult> => {
    const tree = await loadRecipeTree(txc, input.productId);
    const lines = expandToNakladnoy(tree, input.productId, input.qty);

    const { rows } = await txc.query<NakladnoyHeaderRow>(
      `INSERT INTO nakladnoy
         (source, source_ref, product_id, qty, location_id, total_amount, note, created_by)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
       RETURNING id, source::text AS source, source_ref, product_id, qty,
                 location_id, total_amount, created_by, created_at`,
      [
        input.source,
        input.sourceRef ?? null,
        input.productId,
        input.qty,
        input.locationId ?? null,
        input.note ?? null,
        input.actorUserId,
      ],
    );
    const headerRow = rows[0];
    if (headerRow === undefined) {
      throw AppError.internal('nakladnoy insert returned no row.');
    }
    const nakladnoyId = Number(headerRow.id);

    for (const line of lines) {
      await txc.query(
        `INSERT INTO nakladnoy_lines
           (nakladnoy_id, section, component_product_id, label, qty, unit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          nakladnoyId,
          line.section,
          line.component_product_id,
          line.label,
          line.qty,
          line.unit,
        ],
      );
    }

    await writeAudit(txc, {
      actorUserId: input.actorUserId,
      action: 'nakladnoy.create',
      entity: 'nakladnoy',
      entityId: nakladnoyId,
      payload: {
        source: input.source,
        source_ref: input.sourceRef ?? null,
        product_id: input.productId,
        qty: input.qty,
        location_id: input.locationId ?? null,
        line_count: lines.length,
      },
    });

    return { header: normalizeHeader(headerRow), lines };
  };
  return tx === undefined ? withTransaction(run) : run(tx);
}

/** Read one nakladnoy header + its lines. Returns null when not found. */
export async function getNakladnoy(
  id: number,
  runner: Runner,
): Promise<NakladnoyResult | null> {
  const { rows } = await runner.query<NakladnoyHeaderRow>(
    `SELECT id, source::text AS source, source_ref, product_id, qty,
            location_id, total_amount, created_by, created_at
       FROM nakladnoy WHERE id = $1`,
    [id],
  );
  const headerRow = rows[0];
  if (headerRow === undefined) return null;
  const { rows: lineRows } = await runner.query<{
    section: NakladnoySection;
    component_product_id: number | null;
    label: string;
    qty: string;
    unit: string;
  }>(
    `SELECT section::text AS section, component_product_id, label, qty, unit
       FROM nakladnoy_lines WHERE nakladnoy_id = $1
      ORDER BY id`,
    [id],
  );
  const lines: NakladnoyLine[] = lineRows.map((r) => ({
    section: r.section,
    component_product_id:
      r.component_product_id === null ? null : Number(r.component_product_id),
    label: r.label,
    qty: Number(r.qty),
    unit: r.unit,
  }));
  return { header: normalizeHeader(headerRow), lines };
}

// -----------------------------------------------------------------------------
// Frontend contract serialization (EPIC 8 — types.ts `Nakladnoy`)
// -----------------------------------------------------------------------------
//
// The persisted model uses the document vocabulary (hamir/krem/bezak/itogo).
// The frontend `Nakladnoy` contract groups lines by the BOM `RecipeStage`
// (dough/cream/decoration/other) with a separate `totals` roll-up. This maps
// the two without leaking the storage enum across the boundary.

/** Frontend `RecipeStage` (apps/frontend/src/lib/types.ts). */
type RecipeStage = 'dough' | 'cream' | 'decoration' | 'other';

const SECTION_TO_STAGE: Record<Exclude<NakladnoySection, 'itogo'>, RecipeStage> = {
  hamir: 'dough',
  krem: 'cream',
  bezak: 'decoration',
};

export type NakladnoyMaterialLineDto = {
  readonly product_id: number;
  readonly product_name: string;
  readonly unit: string;
  readonly qty: number;
};

export type NakladnoySectionDto = {
  readonly stage: RecipeStage;
  readonly lines: NakladnoyMaterialLineDto[];
};

export type NakladnoyDto = {
  readonly id: number;
  readonly product_id: number;
  readonly product_name: string;
  readonly order_qty: number;
  readonly store_id: number | null;
  readonly store_name: string | null;
  readonly created_at: string;
  readonly sections: NakladnoySectionDto[];
  readonly totals: NakladnoyMaterialLineDto[];
};

/**
 * Map one persisted nakladnoy (header + lines + resolved names) into the
 * frontend `Nakladnoy` contract: hamir/krem/bezak lines become per-stage
 * `sections`, the `itogo` lines become the `totals` roll-up.
 */
export function toNakladnoyDto(args: {
  readonly header: NakladnoyHeader;
  readonly lines: NakladnoyLine[];
  readonly productName: string;
  readonly storeName: string | null;
}): NakladnoyDto {
  const sectionMap = new Map<RecipeStage, NakladnoyMaterialLineDto[]>();
  const totals: NakladnoyMaterialLineDto[] = [];
  for (const l of args.lines) {
    const dto: NakladnoyMaterialLineDto = {
      product_id: l.component_product_id ?? 0,
      product_name: l.label,
      unit: l.unit,
      qty: l.qty,
    };
    if (l.section === 'itogo') {
      totals.push(dto);
      continue;
    }
    const stage = SECTION_TO_STAGE[l.section];
    const arr = sectionMap.get(stage) ?? [];
    arr.push(dto);
    sectionMap.set(stage, arr);
  }
  // Stable section order: dough, cream, decoration, other.
  const stageOrder: RecipeStage[] = ['dough', 'cream', 'decoration', 'other'];
  const sections: NakladnoySectionDto[] = stageOrder
    .filter((s) => sectionMap.has(s))
    .map((stage) => ({ stage, lines: sectionMap.get(stage)! }));

  return {
    id: args.header.id,
    product_id: args.header.product_id ?? 0,
    product_name: args.productName,
    order_qty: args.header.qty,
    store_id: args.header.location_id,
    store_name: args.storeName,
    created_at: args.header.created_at,
    sections,
    totals,
  };
}

type NakladnoyHeaderRow = {
  id: number | string;
  source: NakladnoySource;
  source_ref: string | null;
  product_id: number | string | null;
  qty: string;
  location_id: number | string | null;
  total_amount: string;
  created_by: number | string | null;
  created_at: string | Date;
};

function normalizeHeader(r: NakladnoyHeaderRow): NakladnoyHeader {
  return {
    id: Number(r.id),
    source: r.source,
    source_ref: r.source_ref,
    product_id: r.product_id === null ? null : Number(r.product_id),
    qty: Number(r.qty),
    location_id: r.location_id === null ? null : Number(r.location_id),
    total_amount: Number(r.total_amount),
    created_by: r.created_by === null ? null : Number(r.created_by),
    created_at:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function toFinite(v: number | string): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
