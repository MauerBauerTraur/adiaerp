/**
 * EPIC 1.2 — translit-aware search for the products module.
 *
 * Poster sources product names in Russian / Cyrillic ("шоколад", "Сахар"),
 * but ADIA staff type in either Latin ("shokolad") or Cyrillic. The backend
 * `GET /api/products` does not (yet) accept a `search` param, so we filter
 * client-side: normalise BOTH the query and every product name to a single
 * canonical Latin form, then substring-match.
 *
 * The canonical form is intentionally lossy and phonetic, not a reversible
 * transliteration: we want "shokolad", "шоколад", "shakar" and "шакар" to
 * collapse onto overlapping keys so a forgiving substring search just works.
 * Digraphs (sh/ch/ya/yo/yu/ts/zh) are mapped to the matching single Cyrillic
 * letter on the way in, and diacritic / soft-sign noise is dropped.
 */

/** Cyrillic letter → canonical Latin token (lower-case). */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
  // Uzbek-Cyrillic extras occasionally present in Poster data.
  ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/**
 * Latin multi-char sequences → canonical token, applied longest-first so
 * "sh" wins over "s"+"h". These mirror the Cyrillic digraph outputs above
 * so a Latin query lands on the same canonical key as its Cyrillic source.
 */
const LATIN_DIGRAPHS: ReadonlyArray<[string, string]> = [
  ['shch', 'sh'],
  ['sh', 'sh'],
  ['ch', 'ch'],
  ['ya', 'ya'],
  ['yo', 'yo'],
  ['yu', 'yu'],
  ['ts', 'ts'],
  ['zh', 'j'],
  ['kh', 'h'],
  ['ph', 'f'],
];

/** Single Latin-letter folds (after digraphs) — collapse near-homophones. */
const LATIN_FOLDS: Record<string, string> = {
  c: 'k', // "coca" ↔ "кока"
  w: 'v',
  x: 'h',
  q: 'k',
  y: 'i', // standalone y (not part of a digraph) reads as и
};

/**
 * Reduce a string to its canonical phonetic Latin key:
 * lower-cased, Cyrillic transliterated, Latin digraphs folded, then every
 * non `[a-z0-9]` character stripped.
 */
export function normalizeSearch(input: string): string {
  let s = input.toLowerCase().trim();

  // 1. Transliterate Cyrillic letter-by-letter.
  let out = '';
  for (const ch of s) {
    out += ch in CYRILLIC_TO_LATIN ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  s = out;

  // 2. Fold Latin digraphs (longest-first via the ordered table).
  for (const [from, to] of LATIN_DIGRAPHS) {
    if (from !== to) {
      s = s.split(from).join(to);
    }
  }

  // 3. Fold single Latin near-homophones.
  out = '';
  for (const ch of s) {
    out += ch in LATIN_FOLDS ? LATIN_FOLDS[ch] : ch;
  }
  s = out;

  // 4. Strip everything that is not a latin letter or digit.
  return s.replace(/[^a-z0-9]/g, '');
}

/**
 * True when `query` matches `text` after both are reduced to their
 * canonical phonetic key. An empty / whitespace-only query matches all.
 */
export function matchesSearch(text: string, query: string): boolean {
  const q = normalizeSearch(query);
  if (q === '') return true;
  return normalizeSearch(text).includes(q);
}
