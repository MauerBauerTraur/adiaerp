/**
 * Sub-task #6 — Unit-aware quantity formatting.
 *
 * Every stock / sales / movement row carries a `unit` (kg / l / pcs) on its
 * joined `products` row. The DB stores `qty` as a unit-agnostic NUMERIC; the
 * display layer must format it per unit so the operator reads "12 dona" /
 * "3.50 kg" / "1.25 l" instead of a context-free "12".
 *
 * The helper lives in `lib/` so anywhere on the server side that builds a
 * human-readable string (Telegram notifications, AI assistant replies, audit
 * log messages, error messages) can produce a consistent format. The
 * frontend has its own mirror of this function (no shared package yet —
 * Phase-2 `packages/` will host the shared type).
 *
 * Format rules (owner-approved 2026-05-28):
 *   - `pcs` -> integer count + Uzbek noun "dona" (e.g. "12 dona").
 *   - `kg`  -> 2-decimal weight + "kg" (e.g. "3.50 kg").
 *   - `l`   -> 2-decimal volume + "l" (e.g. "1.25 l").
 *
 * The helper is intentionally pure (no i18n machinery, no locale). The
 * thousand-separator decision is deferred — backend output is consumed by
 * UI components that do their own locale formatting.
 */

export type ProductUnit = 'pcs' | 'kg' | 'l';

const UNIT_VALUES = new Set<string>(['pcs', 'kg', 'l']);

/**
 * Format a quantity for human display.
 *
 * @param qty   The numeric quantity (DB NUMERIC, parsed to JS number).
 * @param unit  The product unit. Unknown units fall back to the raw number
 *              string + the unit token — so a forgotten enum extension
 *              never throws, just looks slightly less polished.
 * @returns     Formatted string suitable for notifications / UI strings.
 */
export function formatQty(qty: number, unit: ProductUnit | string): string {
  if (!Number.isFinite(qty)) {
    // Defensive: garbage in, garbage out -- but never throw because this
    // helper runs in the hot path of every notification render.
    return `${qty} ${unit}`;
  }
  if (unit === 'pcs') {
    // `dona` = Uzbek "piece" / count noun. Round-half-to-even via toFixed(0)
    // to avoid surfacing fractional pieces ("12.5 dona" is meaningless).
    return `${qty.toFixed(0)} dona`;
  }
  if (unit === 'kg') {
    return `${qty.toFixed(2)} kg`;
  }
  if (unit === 'l') {
    return `${qty.toFixed(2)} l`;
  }
  // Unknown unit — surface verbatim so a future enum value still renders.
  return `${qty} ${unit}`;
}

/** Type guard — narrow an unknown `unit` string into the `ProductUnit` union. */
export function isProductUnit(value: unknown): value is ProductUnit {
  return typeof value === 'string' && UNIT_VALUES.has(value);
}
