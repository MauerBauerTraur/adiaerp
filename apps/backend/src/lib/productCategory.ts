/**
 * EPIC 1.3 — smart product category (server-side heuristic).
 *
 * Two rules from the owner feedback doc:
 *
 *   1. A `Г/П`-prefixed name (Cyrillic "Готовая Продукция" — ready product)
 *      is a fully finished, sale-ready good → its effective type is `finished`
 *      regardless of the stored `type`.
 *   2. Name heuristics give a human sub-category ("drink", "decoration", …) so
 *      the UI can colour-code and badge the item; e.g. "coca cola", "flavis"
 *      → drink; "Number Candles" → cake decoration.
 *
 * This MIRRORS the frontend `apps/frontend/src/lib/productCategory.ts`. The
 * backend now returns `category` + `effective_type` on each product row so the
 * client can prefer the server's classification (EPIC 9 can later swap the
 * heuristic for a Vertex AI call behind the same field). When no heuristic
 * fires we fall back to the product's coarse (possibly upgraded) `type`.
 */

/** Fine-grained semantic category keys (must match the frontend union). */
export type ProductCategory =
  | 'drink'
  | 'decoration'
  | 'cake'
  | 'pastry'
  | 'bread'
  | 'semi'
  | 'raw'
  | 'finished';

export type ProductType = 'raw' | 'semi' | 'finished';

/** Name substrings (lower-cased, Latin + Cyrillic) → category. Order matters. */
const NAME_RULES: ReadonlyArray<[readonly string[], ProductCategory]> = [
  [
    // NB: keep Cyrillic needles specific — a bare "кола" would false-match
    // "шоКОЛАдный". Coca-Cola in Cyrillic is "Кока-Кола" → "кока" suffices.
    ['cola', 'кока', 'flavis', 'флавис', 'pepsi', 'пепси', 'fanta', 'фанта', 'sprite', 'спрайт', 'напиток', 'газиров', 'juice', 'джус'],
    'drink',
  ],
  [
    ['candle', 'свеч', 'svech', 'dekor', 'декор', 'ukrash', 'украш', 'topper', 'топпер', 'bezak', 'posыpka', 'посыпка'],
    'decoration',
  ],
  [['tort', 'торт', 'cake'], 'cake'],
  [['napoleon', 'наполеон', 'ekler', 'эклер', 'pirojn', 'пирожн', 'biskvit', 'бисквит', 'kruassan', 'круассан'], 'pastry'],
  [['non', 'хлеб', 'bread', 'lepyoshka', 'лепёшка', 'somsa', 'самс', 'pirog', 'пирог'], 'bread'],
];

/**
 * True when the product name carries the `Г/П` ready-product prefix (with or
 * without a separator). EPIC 1.3.
 *
 * Г/П, Г\П, ГП, "Г П" at the very start of the trimmed name. JS `\b` is
 * ASCII-only (no boundary between two non-ASCII chars), so we require the
 * prefix to be followed by whitespace, end-of-string, or a separator.
 */
export function hasReadyPrefix(name: string): boolean {
  return /^\s*г\s*[\\/]?\s*п(?=\s|$|[\\/.:,-])/i.test(name.trim());
}

/** The effective product type, upgrading `Г/П`-prefixed names to finished. */
export function effectiveType(name: string, type: ProductType): ProductType {
  if (hasReadyPrefix(name)) return 'finished';
  return type;
}

/** Derive the fine-grained category for a product (EPIC 1.3). */
export function deriveCategory(name: string, type: ProductType): ProductCategory {
  const lower = name.toLowerCase();
  for (const [needles, category] of NAME_RULES) {
    if (needles.some((n) => lower.includes(n))) return category;
  }
  // No name hint — fall back to the coarse (possibly upgraded) type.
  const eff = effectiveType(name, type);
  if (eff === 'raw') return 'raw';
  if (eff === 'semi') return 'semi';
  return 'finished';
}
