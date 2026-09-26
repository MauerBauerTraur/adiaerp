/**
 * Shared Poster recipe (BOM) logic.
 *
 * ONE implementation used by every path that turns a Poster tech card into an
 * ERP `recipes` BOM, so they can never disagree (or flap between each other):
 *
 *   - the hourly sync (`syncPrepacks` / `syncMenuProducts` in seedSync.ts);
 *   - the preview endpoint  GET  /api/integrations/poster/product-recipe/:id;
 *   - the re-sync endpoint  POST /api/integrations/poster/product-recipe/:id/apply.
 *
 * Pieces:
 *   - normaliseQty / normaliseName / prepackYieldKg — pure normalisation;
 *   - resolveComponentProduct — Poster component -> ERP product: an id binding
 *     verified by name across both Poster id spaces, one rule everywhere;
 *   - buildComponents         — BRUTTO-based qty per unit of yield;
 *   - findPosterRecipe        — locate the Poster tech card of an ERP product;
 *   - writePosterRecipe       — replace a recipe inside the caller's
 *                               transaction; stages survive only an unchanged
 *                               composition.
 */
import { query, type Runner, type TxClient } from '../../db/index.js';
import type {
  PosterClient,
  PosterMenuProductFull,
  PosterPrepack,
} from './client.js';
import { redactUrl } from './syncLog.js';

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * Convert a Poster recipe quantity to a quantity in the component's unit:
 *   - structure_unit "g"  + ingredient_unit "kg" -> divide by 1000
 *   - structure_unit "ml" + ingredient_unit "l"  -> divide by 1000
 *   - the reverse pairs                          -> multiply by 1000
 *   - same unit                                  -> as-is
 *
 * Anything else falls back to "as-is". Missing, non-numeric and non-positive
 * values normalise to 0 (the caller skips them).
 */
export function normaliseQty(
  structureUnit: string,
  ingredientUnit: string,
  raw: number | string | null | undefined,
): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? Number.NaN);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const su = structureUnit.toLowerCase();
  const iu = ingredientUnit.toLowerCase();
  if (su === iu) return n;
  if ((su === 'g' && iu === 'kg') || (su === 'ml' && iu === 'l')) return n / 1000;
  if ((su === 'kg' && iu === 'g') || (su === 'l' && iu === 'ml')) return n * 1000;
  return n;
}

/**
 * A prepack's batch yield in kg. Poster reports `out` in grams for every
 * weight-based prepack (ERP prepacks are kg); piece-based prepacks come back
 * with out=0 / missing -> treated as a 1-unit batch.
 */
export function prepackYieldKg(out: unknown): number {
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n / 1000 : 1;
}

/** Trailing semi-finished marker: "(п/ф)" (optionally glued) or " п/ф". */
const SEMI_MARKER = /\s*\(\s*п\s*\/\s*ф\s*\)$|(?:^|\s)п\s*\/\s*ф$/u;

/**
 * Canonical form used to compare a Poster name with an ERP product name:
 * lowercase, trimmed, ё→е, whitespace collapsed, trailing "п/ф" marker removed.
 */
export function normaliseName(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  const base = String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  return base.replace(SEMI_MARKER, '').trim();
}

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// -----------------------------------------------------------------------------
// Component resolution
// -----------------------------------------------------------------------------

type ProductCandidate = {
  id: number;
  name: string;
  unit: string;
  type: string;
};

type IdCandidateRow = ProductCandidate & {
  poster_product_id: number | null;
  poster_ingredient_id: number | null;
};

const CANDIDATE_COLUMNS = 'id, name, unit::text AS unit, type::text AS type';

/**
 * Which Poster id space an ambiguous component id is tried in FIRST when the
 * name decides nothing. It depends on where the tech card came from:
 *
 *   - 'by-structure-type' (prepack tech cards, `menu.getPrepacks`) — a
 *     structure_type=2 line is tried as a product_id first, a type-1 line as
 *     an ingredient_id first (syncPrepacks' historical order);
 *   - 'ingredient-first'  (menu tech cards, `menu.getProduct`) — always the
 *     ingredient_id first (resolveBomComponents' historical order).
 *
 * Preview, apply and the hourly sync all derive the order from the SOURCE via
 * `fallbackOrderFor`, so the same tech card binds the same rows everywhere.
 */
export type FallbackOrder = 'by-structure-type' | 'ingredient-first';

export function fallbackOrderFor(source: 'prepack' | 'menu'): FallbackOrder {
  return source === 'menu' ? 'ingredient-first' : 'by-structure-type';
}

/**
 * Product types a line may bind BY NAME: a prepack line (structure_type 2)
 * only a semi-finished product; an ingredient line a raw or semi product.
 * Never finished / gp goods.
 */
function compatibleTypes(isPrepackLine: boolean): readonly string[] {
  return isPrepackLine ? ['semi'] : ['raw', 'semi'];
}

/**
 * Normalised-name -> ACTIVE products lookup, loaded once and reused.
 *
 * Name normalisation (ё→е, п/ф marker) cannot be expressed reliably in SQL
 * without depending on the database locale for Cyrillic case folding, so the
 * names are normalised in JS. Loading the product list once per sync run keeps
 * the name lookup O(1) per component. The index is only a pre-filter: every
 * hit is re-read by id so a rename during a long sync run is never trusted.
 */
export class ProductNameIndex {
  private byName: Map<string, ProductCandidate[]> | undefined;

  async find(normName: string): Promise<ProductCandidate[]> {
    if (normName === '') return [];
    if (this.byName === undefined) {
      const { rows } = await query<ProductCandidate>(
        `SELECT ${CANDIDATE_COLUMNS} FROM products WHERE is_active = TRUE`,
      );
      const map = new Map<string, ProductCandidate[]>();
      for (const r of rows) {
        const key = normaliseName(r.name);
        if (key === '') continue;
        const list = map.get(key);
        if (list === undefined) map.set(key, [r]);
        else list.push(r);
      }
      this.byName = map;
    }
    const hits = this.byName.get(normName) ?? [];
    if (hits.length === 0) return [];
    const { rows } = await query<ProductCandidate>(
      `SELECT ${CANDIDATE_COLUMNS} FROM products
        WHERE id = ANY($1::bigint[]) AND is_active = TRUE
        ORDER BY id`,
      [hits.map((h) => h.id)],
    );
    return rows.filter((r) => normaliseName(r.name) === normName);
  }
}

type ComponentMatch = 'id+name' | 'name' | 'id';

type NameCandidate = { readonly id: number; readonly name: string };

type ResolvedComponent = {
  readonly id: number;
  readonly name: string;
  readonly unit: string;
  readonly type: string;
  readonly matchedBy: ComponentMatch;
  /** Bound by id although the ERP name differs from Poster's ingredient_name. */
  readonly nameMismatch: boolean;
  /** For a mismatch: the product the NAME alone points at (not used). */
  readonly nameCandidate: NameCandidate | null;
};

type ResolveOptions = {
  readonly order: FallbackOrder;
  readonly nameIndex?: ProductNameIndex;
};

/**
 * The single type-compatible product a name points at, or undefined when
 * there is none or it is ambiguous (several: prefer 'semi' for a prepack line,
 * 'raw' for an ingredient line; still several -> undefined).
 */
async function uniqueByName(
  nameIndex: ProductNameIndex,
  normName: string,
  isPrepackLine: boolean,
): Promise<ProductCandidate | undefined> {
  const allowed = compatibleTypes(isPrepackLine);
  const hits = (await nameIndex.find(normName)).filter((c) => allowed.includes(c.type));
  if (hits.length <= 1) return hits[0];
  const preferred = hits.filter((c) => c.type === (isPrepackLine ? 'semi' : 'raw'));
  return preferred.length === 1 ? preferred[0] : undefined;
}

/**
 * Resolve one Poster recipe component to an ERP product.
 *
 * Poster's product_id and ingredient_id are SEPARATE number spaces that
 * overlap (e.g. a prepack with product_id=978 has ingredient_id=2402), so the
 * same number can point at two unrelated ERP rows. The rule, identical for
 * the hourly sync, the preview and the apply endpoint:
 *
 *   1. id candidates, tried in `opts.order` (see FallbackOrder). If any of
 *      them has the Poster name -> that one ('id+name'); when several do, a
 *      type-compatible one wins.
 *   2. id candidates exist but none has the Poster name -> the first in
 *      order ('id', the pre-name-check behaviour), flagged `nameMismatch`.
 *      A product the name alone points at is only REPORTED (`nameCandidate`),
 *      never bound — a name must not override a valid id binding.
 *   3. no id candidate at all -> a unique, type-compatible, active product
 *      with the Poster name ('name').
 *   4. null.
 */
export async function resolveComponentProduct(
  posterId: number,
  ingredientName: string | null | undefined,
  structureType: string | number | null | undefined,
  opts: ResolveOptions,
): Promise<ResolvedComponent | null> {
  const isPrepackLine = String(structureType ?? '1') === '2';
  const nameIndex = opts.nameIndex ?? new ProductNameIndex();
  const ordered: IdCandidateRow[] = [];
  if (positiveInt(posterId) !== null) {
    const { rows } = await query<IdCandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}, poster_product_id, poster_ingredient_id
         FROM products
        WHERE poster_product_id = $1 OR poster_ingredient_id = $1`,
      [posterId],
    );
    const byProduct = rows.find((r) => Number(r.poster_product_id) === posterId);
    const byIngredient = rows.find((r) => Number(r.poster_ingredient_id) === posterId);
    const productFirst = opts.order === 'by-structure-type' && isPrepackLine;
    for (const c of productFirst ? [byProduct, byIngredient] : [byIngredient, byProduct]) {
      if (c !== undefined && !ordered.some((o) => o.id === c.id)) ordered.push(c);
    }
  }

  const target = normaliseName(ingredientName);
  const result = (
    c: ProductCandidate,
    matchedBy: ComponentMatch,
    nameMismatch = false,
    nameCandidate: NameCandidate | null = null,
  ): ResolvedComponent => ({
    id: Number(c.id),
    name: c.name,
    unit: c.unit,
    type: c.type,
    matchedBy,
    nameMismatch,
    nameCandidate,
  });

  if (ordered.length > 0) {
    if (target !== '') {
      const named = ordered.filter((c) => normaliseName(c.name) === target);
      const allowed = compatibleTypes(isPrepackLine);
      const pick = named.find((c) => allowed.includes(c.type)) ?? named[0];
      if (pick !== undefined) return result(pick, 'id+name');
    }
    const first = ordered[0]!;
    if (target === '') return result(first, 'id');
    const other = await uniqueByName(nameIndex, target, isPrepackLine);
    return result(
      first,
      'id',
      true,
      other !== undefined && Number(other.id) !== Number(first.id)
        ? { id: Number(other.id), name: other.name }
        : null,
    );
  }

  if (target === '') return null;
  const byName = await uniqueByName(nameIndex, target, isPrepackLine);
  return byName === undefined ? null : result(byName, 'name');
}

// -----------------------------------------------------------------------------
// BOM building
// -----------------------------------------------------------------------------

/** One Poster tech-card line, as loosely typed as Poster sends it. */
type PosterRecipeLineInput = {
  readonly ingredient_id: string | number;
  readonly structure_unit?: string;
  readonly ingredient_unit?: string;
  readonly structure_type?: string | number;
  readonly structure_brutto?: number | string;
  readonly structure_netto?: number | string;
  readonly ingredient_name?: string;
};

export type BuiltComponent = {
  readonly componentProductId: number;
  /** Component qty (in its ERP unit) per 1 unit of the parent's yield. */
  readonly qtyPerUnit: number;
  readonly brutto: number;
  /** ERP product name / unit / type of the bound component. */
  readonly name: string;
  readonly unit: string;
  readonly type: string;
  readonly nameMismatch: boolean;
  readonly matchedBy: ComponentMatch;
  /** Poster's ingredient_name and ingredient_id (first line if merged). */
  readonly posterName: string;
  readonly posterIngredientId: number;
  /** Binding notes for this component (name mismatch / name-only), Uzbek. */
  readonly notes: readonly string[];
};

type BuildOptions = ResolveOptions & {
  /** The recipe owner — a line that resolves to it is dropped (no self-BOM). */
  readonly parentProductId?: number;
};

type BuildResult = {
  readonly components: BuiltComponent[];
  /** Poster names of lines that resolved to no ERP product. */
  readonly notFound: string[];
  /** The same unresolved lines with their quantity (for side-by-side reports). */
  readonly unresolved: { posterName: string; posterIngredientId: number; qtyPerUnit: number }[];
  /** Human-readable (Uzbek) notes, in order: binding, zero-qty, self, merges. */
  readonly warnings: string[];
  /** Components that appeared on several Poster lines (quantities summed). */
  readonly duplicates: { componentProductId: number; name: string; lines: number }[];
};

function nameMismatchWarning(posterName: string, erpName: string, candidate: NameCandidate | null): string {
  const hint = candidate === null ? '' : `; nom bo'yicha nomzod: '${candidate.name}'`;
  return `Poster: '${posterName}' → ERP: '${erpName}' (nomi mos emas${hint})`;
}

function nameOnlyWarning(posterName: string, posterId: number, erpName: string): string {
  return `Poster: '${posterName}' → ERP: '${erpName}' (faqat nomi bo'yicha bog'landi — Poster ID ${posterId} ERP'da yo'q)`;
}

/**
 * Turn Poster tech-card lines into ERP recipe components.
 *
 * Quantity is BRUTTO — the gross amount actually taken from stock, which is
 * what Poster charges to себестоимость. Netto is unreliable in this account
 * (sometimes the batch yield, e.g. 1000 g, which inflated qty to 1.0; sometimes
 * a rounded net weight below brutto), so it is only a fallback when brutto is
 * missing or zero. The unit is converted structure_unit -> ingredient_unit and
 * divided by the parent's batch yield (kg for prepacks, 1 for menu products).
 *
 * Lines with ingredient_id <= 0 are skipped, as is a line that resolves to the
 * parent itself. A component that appears on several lines is merged
 * (quantities summed — Poster writes off every line) and reported.
 */
export async function buildComponents(
  posterLines: readonly PosterRecipeLineInput[],
  batchYieldKg: number,
  opts: BuildOptions,
): Promise<BuildResult> {
  const safeYield = Number.isFinite(batchYieldKg) && batchYieldKg > 0 ? batchYieldKg : 1;
  const nameIndex = opts.nameIndex ?? new ProductNameIndex();
  const merged = new Map<number, BuiltComponent>();
  const lineCount = new Map<number, number>();
  const notFound: string[] = [];
  const unresolved: BuildResult['unresolved'] = [];
  const warnings: string[] = [];
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  for (const line of posterLines) {
    const posterId = positiveInt(line.ingredient_id);
    if (posterId === null) continue;
    const posterName = String(line.ingredient_name ?? '').trim();
    const label = posterName !== '' ? posterName : `Poster #${posterId}`;
    const su = String(line.structure_unit ?? '');
    const iu = String(line.ingredient_unit ?? '');
    const brutto = normaliseQty(su, iu, line.structure_brutto);
    const netto = normaliseQty(su, iu, line.structure_netto ?? line.structure_brutto);
    const qty = brutto > 0 ? brutto : netto;
    const perUnit = qty / safeYield;
    const bruttoPerUnit = brutto / safeYield;
    if (!(perUnit > 0) || !Number.isFinite(perUnit)) {
      warn(`Poster: '${label}' — miqdori 0, o'tkazib yuborildi`);
      continue;
    }

    const comp = await resolveComponentProduct(posterId, posterName, line.structure_type, {
      order: opts.order,
      nameIndex,
    });
    if (comp === null) {
      if (!notFound.includes(label)) notFound.push(label);
      unresolved.push({ posterName: label, posterIngredientId: posterId, qtyPerUnit: perUnit });
      continue;
    }
    if (opts.parentProductId !== undefined && comp.id === opts.parentProductId) {
      warn(`Poster: '${label}' — mahsulotning o'zi, o'tkazib yuborildi`);
      continue;
    }

    const note = comp.nameMismatch
      ? nameMismatchWarning(label, comp.name, comp.nameCandidate)
      : comp.matchedBy === 'name'
        ? nameOnlyWarning(label, posterId, comp.name)
        : null;
    if (note !== null) warn(note);

    const lineBrutto = bruttoPerUnit > 0 ? bruttoPerUnit : perUnit;
    lineCount.set(comp.id, (lineCount.get(comp.id) ?? 0) + 1);
    const prev = merged.get(comp.id);
    if (prev === undefined) {
      merged.set(comp.id, {
        componentProductId: comp.id,
        qtyPerUnit: perUnit,
        brutto: lineBrutto,
        name: comp.name,
        unit: comp.unit,
        type: comp.type,
        nameMismatch: comp.nameMismatch,
        matchedBy: comp.matchedBy,
        posterName: label,
        posterIngredientId: posterId,
        notes: note === null ? [] : [note],
      });
    } else {
      merged.set(comp.id, {
        ...prev,
        qtyPerUnit: prev.qtyPerUnit + perUnit,
        brutto: prev.brutto + lineBrutto,
        nameMismatch: prev.nameMismatch || comp.nameMismatch,
        notes: note === null || prev.notes.includes(note) ? prev.notes : [...prev.notes, note],
      });
    }
  }

  const components = [...merged.values()];
  const duplicates = components
    .filter((c) => (lineCount.get(c.componentProductId) ?? 0) > 1)
    .map((c) => ({ componentProductId: c.componentProductId, name: c.name, lines: lineCount.get(c.componentProductId)! }));
  for (const d of duplicates) {
    warn(`ERP: '${d.name}' Poster'da ${d.lines} ta qatorda keldi — miqdorlar qo'shildi`);
  }
  return { components, notFound, unresolved, warnings, duplicates };
}

// -----------------------------------------------------------------------------
// Locating the Poster tech card of an ERP product
// -----------------------------------------------------------------------------

export type ErpProductRef = {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly batch_yield: number | string | null;
  readonly poster_product_id: number | null;
  readonly poster_ingredient_id: number | null;
};

type PosterRecipeFound = {
  readonly found: true;
  readonly source: 'prepack' | 'menu';
  readonly matchedBy: 'product_id' | 'ingredient_id' | 'name';
  readonly posterProductId: number;
  readonly posterName: string;
  /** Divisor for the Poster quantities (kg per batch for prepacks). */
  readonly batchYieldKg: number;
  readonly lines: readonly PosterRecipeLineInput[];
};

type PosterRecipeMissing = {
  readonly found: false;
  /** Uzbek explanation, shown to the user. */
  readonly reason: string;
};

export type PosterRecipeLookup = PosterRecipeFound | PosterRecipeMissing;

/** The read-only Poster calls the recipe lookup needs. */
export type PosterRecipeReader = Pick<PosterClient, 'getPrepacks' | 'getProducts' | 'getProduct'>;

/**
 * A reader that fetches each Poster list ONCE and each menu tech card
 * (`menu.getProduct`) once per product id, then serves repeats from memory.
 * `findPosterRecipe` over this reader is the preloaded-catalog variant used
 * by the bulk recipe audit: ~1400 lookups cost 2 list calls plus one call per
 * menu product actually needed (the client's serial gate rate-limits those).
 * A failed call is memoised too, so an outage is not retried per product.
 */
export function cachedRecipeReader(reader: PosterRecipeReader): PosterRecipeReader {
  let prepacks: ReturnType<PosterRecipeReader['getPrepacks']> | undefined;
  let products: ReturnType<PosterRecipeReader['getProducts']> | undefined;
  const full = new Map<number, ReturnType<PosterRecipeReader['getProduct']>>();
  return {
    getPrepacks: () => (prepacks ??= reader.getPrepacks()),
    getProducts: () => (products ??= reader.getProducts()),
    getProduct: (id: number) => {
      let p = full.get(id);
      if (p === undefined) {
        p = reader.getProduct(id);
        full.set(id, p);
      }
      return p;
    },
  };
}

function fromPrepack(p: PosterPrepack, matchedBy: PosterRecipeFound['matchedBy']): PosterRecipeFound {
  return {
    found: true,
    source: 'prepack',
    matchedBy,
    posterProductId: Number(p.product_id),
    posterName: String(p.product_name ?? '').trim(),
    batchYieldKg: prepackYieldKg(p.out),
    lines: p.ingredients ?? [],
  };
}

function fromMenu(
  m: PosterMenuProductFull,
  erp: ErpProductRef,
  matchedBy: PosterRecipeFound['matchedBy'],
): PosterRecipeFound {
  // A menu product's lines are per unit (divisor 1). A prepack that has
  // dropped out of getPrepacks can reach this branch too, and its lines are
  // per BATCH — keep the yield stored on the row for a semi product.
  const storedYield = Number(erp.batch_yield ?? 0);
  return {
    found: true,
    source: 'menu',
    matchedBy,
    posterProductId: Number(m.product_id),
    posterName: String(m.product_name ?? '').trim(),
    batchYieldKg: erp.type === 'semi' && Number.isFinite(storedYield) && storedYield > 0 ? storedYield : 1,
    lines: m.ingredients ?? [],
  };
}

function hasLines(m: PosterMenuProductFull): boolean {
  return Array.isArray(m.ingredients) && m.ingredients.length > 0;
}

/**
 * Find the Poster tech card of an ERP product. Ids first, names last:
 *
 *   1. prepack whose product_id    = erp.poster_product_id
 *   2. prepack whose ingredient_id = erp.poster_ingredient_id
 *   3. menu.getProduct(erp.poster_product_id)
 *   4. by unique normalised name, TYPE-AWARE: an ERP semi (or gp — the "Г/П"
 *      goods are Poster prepacks in this account) only against prepacks, an
 *      ERP finished product only against menu products (type 2). A raw
 *      product never matches by name.
 *
 * The name step runs only when no id identified a Poster item: once Poster
 * confirms the id is a menu product (even one with an empty tech card), a
 * same-named prepack is a DIFFERENT item and must not be borrowed.
 */
export async function findPosterRecipe(
  client: PosterRecipeReader,
  erp: ErpProductRef,
): Promise<PosterRecipeLookup> {
  const ppid = positiveInt(erp.poster_product_id);
  const ping = positiveInt(erp.poster_ingredient_id);
  const prepacks = await client.getPrepacks();

  if (ppid !== null) {
    const pp = prepacks.find((p) => Number(p.product_id) === ppid);
    if (pp !== undefined) return fromPrepack(pp, 'product_id');
  }
  if (ping !== null) {
    const pp = prepacks.find((p) => Number(p.ingredient_id) === ping);
    if (pp !== undefined) return fromPrepack(pp, 'ingredient_id');
  }
  if (ppid !== null) {
    const mp = await client.getProduct(ppid);
    if (mp !== null && hasLines(mp)) return fromMenu(mp, erp, 'product_id');
    if (mp !== null) {
      return {
        found: false,
        reason: `Poster menyusidagi "${String(mp.product_name ?? '').trim()}" (product_id=${ppid}) tex-kartasi bo'sh`,
      };
    }
  }

  const target = normaliseName(erp.name);
  if (target !== '' && (erp.type === 'semi' || erp.type === 'gp')) {
    const byName = prepacks.filter((p) => normaliseName(p.product_name) === target);
    if (byName.length === 1) return fromPrepack(byName[0]!, 'name');
  }
  if (target !== '' && erp.type === 'finished') {
    const menu = await client.getProducts();
    const byName = menu.filter((m) => String(m.type) === '2' && normaliseName(m.product_name) === target);
    const only = byName.length === 1 ? positiveInt(byName[0]!.product_id) : null;
    if (only !== null) {
      const full = await client.getProduct(only);
      if (full !== null && hasLines(full)) return fromMenu(full, erp, 'name');
    }
  }

  const ids: string[] = [];
  if (ppid !== null) ids.push(`product_id=${ppid}`);
  if (ping !== null) ids.push(`ingredient_id=${ping}`);
  return {
    found: false,
    reason:
      ids.length === 0
        ? "mahsulot Poster bilan bog'lanmagan — poster_ingredient_id va poster_product_id yo'q, nomi bo'yicha ham topilmadi"
        : `Poster yarim tayyorlari va menyusida ${ids.join(', ')} bo'yicha ham, nomi bo'yicha ham topilmadi`,
  };
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export type RecipeComponentInput = {
  readonly componentProductId: number;
  readonly qtyPerUnit: number;
  readonly brutto?: number;
};

/** One stored recipe line (before or after a write). */
export type RecipeLineSnapshot = {
  readonly component_product_id: number;
  readonly qty_per_unit: number;
  readonly brutto: number;
  readonly stage: string;
};

/** Shown/recorded when a Poster refresh had to drop the Hamir/Krem/Bezak split. */
export const STAGES_RESET_WARNING =
  "Poster tarkibi o'zgargani uchun Hamir/Krem/Bezak bosqichlari tiklanmadi — kerak bo'lsa qayta belgilang.";

/**
 * Round to the column's 4 decimals EXACTLY as PostgreSQL stores it.
 *
 * node-pg sends a JS number as String(n) and NUMERIC(14,4) rounds that decimal
 * string half away from zero. Float arithmetic disagrees on real quantities:
 * `Math.round(n * 1e4) / 1e4` turns 1.45 g/kg ("0.00145") into 0.0014 where PG
 * stores 0.0015, and a toPrecision() fix turns 3.55 g/kg
 * ("0.0035499999999999998") into 0.0036 where PG stores 0.0035. So this rounds
 * the very decimal string PG receives. (Review R1: a mismatch made a product
 * 'differs' forever and re-applied it on every run.)
 */
export function round4(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : n;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(n)));
  if (m === null) return Math.round(n * 1e4) / 1e4; // not reachable for finite numbers
  const digits = m[1]! + (m[2] ?? '');
  const point = m[1]!.length + Number(m[3] ?? 0); // decimal point position within `digits`
  let intPart: string;
  let frac: string;
  if (point <= 0) {
    intPart = '0';
    frac = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    intPart = digits + '0'.repeat(point - digits.length);
    frac = '';
  } else {
    intPart = digits.slice(0, point);
    frac = digits.slice(point);
  }
  const frac5 = (frac + '00000').slice(0, 5);
  let scaled = Number(intPart + frac5.slice(0, 4)); // units of 0.0001 (< 2^53 for NUMERIC(14,4))
  if (frac5[4]! >= '5') scaled += 1;
  const out = scaled / 1e4;
  return n < 0 ? -out : out;
}

/** The smallest value a split part may take (the column's scale). */
const MIN_PART = 0.0001;

/**
 * Stages that carry real stage information. 'base', 'dough' and 'other' all
 * land in the hamir section and are read in full by a flat recipe, so a
 * recipe made only of them is flat: flattening it to 'base' loses nothing.
 * 'decoration' (what readFinalBom / the zagatovka flow key on), 'cream' and
 * 'assembly' (their own nakladnoy sections) are a real split.
 */
const SPLIT_STAGES: ReadonlySet<string> = new Set(['decoration', 'cream', 'assembly']);

type PlannedRow = {
  readonly component_product_id: number;
  readonly stage: string;
  readonly qty_per_unit: number;
  readonly brutto: number;
};

type RoundingChange = { readonly componentProductId: number; readonly from: number; readonly to: number };

type RecipePlan = {
  /** Rows to write, qty/brutto ALREADY rounded exactly as PG would store them. */
  readonly rows: PlannedRow[];
  /** A real Hamir/Krem/Bezak split existed and cannot be kept (composition changed). */
  readonly stagesReset: boolean;
  /** Values the 4-decimal column changes by more than 10% (review Y6). */
  readonly roundingChanges: RoundingChange[];
};

/**
 * Split `total` over `weights` proportionally, rounded to 4 decimals with the
 * rounding remainder on the largest part so the parts add up to round4(total).
 * Returns the unrounded parts too (for the rounding report), or null when a
 * part would fall below `min`.
 */
function splitProportionally(
  total: number,
  weights: readonly number[],
  min: number,
): { parts: number[]; raw: number[] } | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const raw = weights.map((w) => (total * w) / sum);
  if (raw.some((p) => p < min)) return null;
  const parts = raw.map(round4);
  const remainder = round4(round4(total) - parts.reduce((a, b) => a + b, 0));
  if (remainder !== 0) {
    const iMax = raw.indexOf(Math.max(...raw));
    parts[iMax] = round4(parts[iMax]! + remainder);
  }
  return parts.some((p) => p < min) ? null : { parts, raw };
}

/**
 * Decide the rows a Poster refresh writes — a PURE function, so the audit can
 * predict exactly what apply/sync will do (`stages_will_reset`).
 *
 * Stages. Poster has no stage concept; the ERP splits a cake's BOM into
 * base / decoration / assembly and production reads that split
 * (`readFinalBom` consumes ONLY the decoration lines once any exists; the
 * zagatovka, the dialog and the nakladnoy sections follow the same rule).
 *
 *   - The component SET is unchanged -> every component keeps its stage(s).
 *     A component split across several stage rows gets Poster's new total
 *     distributed over those rows in proportion to their old quantities; if a
 *     part would fall below 0.0001 the whole recipe falls back to a reset.
 *   - Components added or removed -> every line is written as 'base' (a flat
 *     recipe, which every consumer reads in full). Keeping old stages next to
 *     a changed set would park a new Poster component in 'base' beside
 *     'decoration' lines, and the final order would silently never consume it.
 *
 * `stagesReset` is true only when real stage information (SPLIT_STAGES) is
 * lost — an all-base / dough / other recipe is never reported (nor blocked).
 * Every returned qty/brutto is already `round4`-ed, so the database stores
 * exactly what the audit compares.
 */
export function planRecipeRows(
  previous: readonly RecipeLineSnapshot[],
  components: readonly RecipeComponentInput[],
  productId: number,
): RecipePlan {
  const toWrite = components.filter((c) => c.componentProductId !== productId && c.qtyPerUnit > 0);
  const before = new Map<number, RecipeLineSnapshot[]>();
  for (const p of previous) {
    const list = before.get(p.component_product_id);
    if (list === undefined) before.set(p.component_product_id, [p]);
    else list.push(p);
  }
  const after = new Set(toWrite.map((c) => c.componentProductId));
  const sameSet = before.size === after.size && [...after].every((id) => before.has(id));
  const bruttoOf = (c: RecipeComponentInput): number =>
    c.brutto !== undefined && c.brutto > 0 ? c.brutto : c.qtyPerUnit;

  type Draft = { readonly row: PlannedRow; readonly rawQty: number };
  const exact = (componentProductId: number, stage: string, qty: number, brutto: number): Draft => ({
    row: { component_product_id: componentProductId, stage, qty_per_unit: round4(qty), brutto: round4(brutto) },
    rawQty: qty,
  });

  let kept: Draft[] | null = sameSet ? [] : null;
  for (const c of sameSet ? toWrite : []) {
    const old = before.get(c.componentProductId)!;
    if (old.length === 1) {
      kept!.push(exact(c.componentProductId, old[0]!.stage, c.qtyPerUnit, bruttoOf(c)));
      continue;
    }
    const weights = old.map((o) => o.qty_per_unit);
    const qtySplit = splitProportionally(c.qtyPerUnit, weights, MIN_PART);
    const bruttoSplit = splitProportionally(bruttoOf(c), weights, 0);
    if (qtySplit === null || bruttoSplit === null) {
      kept = null;
      break;
    }
    old.forEach((o, i) => {
      kept!.push({
        row: { component_product_id: c.componentProductId, stage: o.stage, qty_per_unit: qtySplit.parts[i]!, brutto: bruttoSplit.parts[i]! },
        rawQty: qtySplit.raw[i]!,
      });
    });
  }

  const drafts = kept ?? toWrite.map((c) => exact(c.componentProductId, 'base', c.qtyPerUnit, bruttoOf(c)));
  const roundingChanges: RoundingChange[] = [];
  for (const d of drafts) {
    const to = d.row.qty_per_unit;
    if (to >= MIN_PART && Math.abs(to - d.rawQty) / d.rawQty > 0.1) {
      roundingChanges.push({ componentProductId: d.row.component_product_id, from: d.rawQty, to });
    }
  }
  return {
    rows: drafts.map((d) => d.row),
    stagesReset: kept === null && previous.some((p) => SPLIT_STAGES.has(p.stage)),
    roundingChanges,
  };
}

/** Uzbek note for a value the 4-decimal storage changes by more than 10%. */
export function roundingWarning(name: string, from: number, to: number): string {
  const show = (n: number): string => String(Number(n.toFixed(6)));
  return `ERP: '${name}' miqdori 4 xonaga yaxlitlanganda 10% dan ko'p o'zgardi: ${show(from)} → ${show(to)}`;
}

/** The stored recipe rows of a product, in insertion order. */
export async function readRecipeSnapshot(runner: Runner, productId: number): Promise<RecipeLineSnapshot[]> {
  const { rows } = await runner.query<RecipeLineSnapshot>(
    `SELECT component_product_id, qty_per_unit, brutto, stage::text AS stage
       FROM recipes WHERE product_id = $1 ORDER BY id`,
    [productId],
  );
  return rows.map(snapshot);
}

/** Same rows regardless of order (component, stage, qty, brutto at 4 decimals). */
export function sameRecipeRows(a: readonly RecipeLineSnapshot[], b: readonly RecipeLineSnapshot[]): boolean {
  const key = (r: RecipeLineSnapshot): string =>
    `${r.component_product_id}|${r.stage}|${round4(r.qty_per_unit)}|${round4(r.brutto)}`;
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

type WriteRecipeResult = {
  /** `refuseStageReset` was set and the write would have lost a split. */
  readonly refused: boolean;
  readonly applied: number;
  readonly written: RecipeLineSnapshot[];
  readonly previous: RecipeLineSnapshot[];
  /** Rows the database rejected (each rolled back on its own SAVEPOINT). */
  readonly skipped: { componentProductId: number; code: string | null; message: string }[];
  readonly stagesReset: boolean;
  readonly roundingChanges: RoundingChange[];
};

/**
 * Replace the recipe of `productId` with `components` inside the CALLER's
 * transaction, following `planRecipeRows`. Does not check `recipe_locked` and
 * does not write audit — the caller decides both (the hourly sync honours the
 * lock, the explicit re-sync endpoint deliberately overrides it).
 *
 * `refuseStageReset`: when the plan would drop a Hamir/Krem/Bezak split,
 * write nothing and return `refused: true` (the bulk apply's default).
 *
 * Each INSERT runs under its own SAVEPOINT so one bad row (e.g. a qty below
 * the NUMERIC(14,4) scale -> CHECK violation) is rolled back alone and the
 * transaction stays usable; the caller decides what a skipped row means.
 */
export async function writePosterRecipe(
  tx: TxClient,
  productId: number,
  components: readonly RecipeComponentInput[],
  opts: { readonly refuseStageReset?: boolean } = {},
): Promise<WriteRecipeResult> {
  const previous = await readRecipeSnapshot(tx, productId);
  const plan = planRecipeRows(previous, components, productId);
  const base = { previous, stagesReset: plan.stagesReset, roundingChanges: plan.roundingChanges };
  if (opts.refuseStageReset === true && plan.stagesReset) {
    return { ...base, refused: true, applied: 0, written: [], skipped: [] };
  }

  await tx.query('DELETE FROM recipes WHERE product_id = $1', [productId]);

  const written: RecipeLineSnapshot[] = [];
  const skipped: WriteRecipeResult['skipped'] = [];
  for (const [i, r] of plan.rows.entries()) {
    // Identifier built from integers only — never from user input.
    const sp = `sp_recipe_${Math.trunc(productId)}_${i}`;
    try {
      await tx.query(`SAVEPOINT ${sp}`);
      const { rows } = await tx.query<RecipeLineSnapshot>(
        `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, stage)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, component_product_id, stage) DO UPDATE
           SET qty_per_unit = EXCLUDED.qty_per_unit,
               brutto = EXCLUDED.brutto
         RETURNING component_product_id, qty_per_unit, brutto, stage::text AS stage`,
        [productId, r.component_product_id, r.qty_per_unit, r.brutto, r.stage],
      );
      await tx.query(`RELEASE SAVEPOINT ${sp}`);
      const row = rows[0];
      if (row !== undefined) written.push(snapshot(row));
    } catch (err) {
      try {
        await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await tx.query(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // savepoint already gone — nothing else to undo
      }
      const e = err as { message?: string; code?: string };
      const message = redactUrl(e.message ?? '');
      skipped.push({ componentProductId: r.component_product_id, code: e.code ?? null, message });
      console.error(
        `[poster] recipe row skipped product=${productId} component=${r.component_product_id} code=${e.code ?? '-'} msg=${message}`,
      );
    }
  }
  return { ...base, refused: false, applied: written.length, written, skipped };
}

function snapshot(r: RecipeLineSnapshot): RecipeLineSnapshot {
  return {
    component_product_id: Number(r.component_product_id),
    qty_per_unit: Number(r.qty_per_unit),
    brutto: Number(r.brutto),
    stage: r.stage,
  };
}
