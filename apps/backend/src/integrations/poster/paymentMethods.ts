/**
 * Sub-task #7 — Poster payment-method mapping.
 *
 * Poster's `dash.getPaymentsReport` returns one row per payment method per
 * day (`payment_id`, `payment_title`, `payment_count`, `payment_sum`). The
 * built-in Poster methods are stable across accounts:
 *
 *   payment_id = 1 -> cash    (Naqd)
 *   payment_id = 2 -> card    (Karta)
 *
 * Uzbek "online" payment methods (Payme, Click) are custom payment methods
 * the operator configures inside Poster — their `payment_id` is account-
 * specific (Poster assigns the next free integer). We therefore match by
 * the `payment_title` STRING when the numeric id is unknown, so the
 * mapping stays correct after a Poster admin renames or re-creates a
 * method. Anything we can't classify lands in the `other` bucket so the
 * total still reconciles.
 *
 * The mapping is intentionally permissive — Poster localises titles in
 * Russian/Uzbek so we match case-insensitively against substring patterns.
 * Add new pattern lists here (and only here) when the operator wires up
 * another e-wallet.
 */

export type PaymentMethodKey = 'cash' | 'card' | 'payme' | 'click' | 'other';

/** Numeric Poster payment_id -> our canonical method key. */
const ID_MAP: Readonly<Record<number, PaymentMethodKey>> = {
  1: 'cash',
  2: 'card',
};

/**
 * Title -> key pattern lists. Match is case-insensitive substring; first
 * match wins. Keep specific patterns (Payme/Click) BEFORE generic ones
 * (card / cash) so a method titled "Payme Karta" still resolves to payme.
 */
const TITLE_PATTERNS: ReadonlyArray<{ key: PaymentMethodKey; needles: string[] }> = [
  { key: 'payme', needles: ['payme', 'пайме'] },
  { key: 'click', needles: ['click', 'клик'] },
  { key: 'card', needles: ['card', 'карта', 'karta', 'visa', 'humo', 'uzcard'] },
  { key: 'cash', needles: ['cash', 'нал', 'naqd', 'наличн'] },
];

/**
 * Resolve a Poster payment method to our canonical key.
 *
 * @param paymentId    Numeric `payment_id` from Poster (parsed to number).
 *                     Pass `undefined` when only the title is known.
 * @param paymentTitle Free-text title from Poster (`payment_title` or the
 *                     transaction's `payed_*` field name). Optional.
 * @returns A canonical key. Unknown methods become 'other' so the total
 *          reconciles against the sum-of-all-buckets in the dashboard.
 */
export function classifyPosterPayment(
  paymentId: number | undefined,
  paymentTitle: string | undefined,
): PaymentMethodKey {
  if (paymentId !== undefined && Number.isFinite(paymentId)) {
    const hit = ID_MAP[paymentId];
    if (hit !== undefined) return hit;
  }
  if (typeof paymentTitle === 'string' && paymentTitle.trim() !== '') {
    const haystack = paymentTitle.toLowerCase();
    for (const { key, needles } of TITLE_PATTERNS) {
      if (needles.some((n) => haystack.includes(n))) return key;
    }
  }
  return 'other';
}

/** Empty bucket map — caller seeds this then accumulates each Poster row. */
export function emptyPaymentBuckets(): Record<PaymentMethodKey, number> {
  return { cash: 0, card: 0, payme: 0, click: 0, other: 0 };
}
