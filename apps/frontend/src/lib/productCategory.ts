/**
 * EPIC 1.3 + 1.4 — smart product category + colour coding.
 *
 * The backend does not (yet) ship an AI `category` field, so the frontend
 * derives a lightweight semantic category from the product's `type` and its
 * name. Two rules from the owner feedback doc:
 *
 *   1. A `Г/П`-prefixed name (Cyrillic "Готовая Продукция" — ready product)
 *      is a fully finished, sale-ready good → treated as `finished` regardless
 *      of the stored `type`.
 *   2. Name heuristics give a human sub-category ("ichimlik", "bezak", …) so
 *      the card can colour-code and badge the item; e.g. "coca cola", "flavis"
 *      → drink; "Number Candles" → cake decoration.
 *
 * Everything degrades gracefully: when no heuristic fires we fall back to the
 * product's coarse `type`. When the backend later supplies a real category
 * field this module becomes the single place to prefer it.
 */
import type { Product, ProductType } from './types';

/** Fine-grained semantic category keys. */
export type ProductCategory =
  | 'drink'
  | 'decoration'
  | 'cake'
  | 'pastry'
  | 'bread'
  | 'semi'
  | 'raw'
  | 'finished';

export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  drink: 'Ichimlik',
  decoration: 'Tort bezagi',
  cake: 'Tort',
  pastry: 'Qandolat',
  bread: 'Non mahsuloti',
  semi: 'Yarim tayyor',
  raw: 'Xom-ashyo',
  finished: 'Tayyor mahsulot',
};

/**
 * Per-category visual tokens. `badge` maps to the shared <Badge> variant set;
 * `accent` is a Tailwind border colour used as the card's left rail / ring so
 * categories read at a glance (EPIC 1.4a — "card rangini turkumga qarab").
 */
export const PRODUCT_CATEGORY_STYLE: Record<
  ProductCategory,
  {
    badge: 'default' | 'outline' | 'success' | 'warning' | 'danger' | 'info';
    accent: string;
  }
> = {
  drink: { badge: 'info', accent: 'border-l-sky-500' },
  decoration: { badge: 'warning', accent: 'border-l-fuchsia-500' },
  cake: { badge: 'success', accent: 'border-l-rose-500' },
  pastry: { badge: 'success', accent: 'border-l-amber-500' },
  bread: { badge: 'success', accent: 'border-l-orange-500' },
  semi: { badge: 'default', accent: 'border-l-violet-500' },
  raw: { badge: 'outline', accent: 'border-l-slate-500' },
  finished: { badge: 'success', accent: 'border-l-emerald-500' },
};

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
 * True when the product name carries the `Г/П` ready-product prefix
 * (with or without a separator). EPIC 1.3.
 */
export function hasReadyPrefix(name: string): boolean {
  // Г/П, Г\П, ГП, "Г П" at the very start of the trimmed name. We cannot use
  // `\b` after a Cyrillic "п" (JS `\b` is ASCII-only — there is no boundary
  // between two non-ASCII chars), so we require the prefix to be followed by
  // whitespace, end-of-string, or a separator instead.
  return /^\s*г\s*[\\/]?\s*п(?=\s|$|[\\/.:,-])/i.test(name.trim());
}

/** The effective product type, upgrading `Г/П`-prefixed names to finished. */
export function effectiveType(product: Product): ProductType {
  if (hasReadyPrefix(product.name)) return 'finished';
  return product.type;
}

/** Derive the fine-grained category for a product (EPIC 1.3 / 1.4). */
export function deriveCategory(product: Product): ProductCategory {
  const name = product.name.toLowerCase();
  for (const [needles, category] of NAME_RULES) {
    if (needles.some((n) => name.includes(n))) return category;
  }
  // No name hint — fall back to the coarse (possibly upgraded) type.
  const type = effectiveType(product);
  if (type === 'raw') return 'raw';
  if (type === 'semi') return 'semi';
  return 'finished';
}
