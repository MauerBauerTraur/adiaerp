/**
 * EPIC 0.3 / P3 — Poster money-unit normalisation.
 *
 * THE UNIT TRAP (verified live against account `adia`, 2026-05-29):
 *
 *   dash.getAnalytics       revenue for 2026-05-29 = "19553300.0000"  (so'm)
 *   dash.getPaymentsReport  payed_sum_sum same day = 1955330000        (tiyin)
 *
 *   1955330000 / 19553300 = 100  (exactly)
 *
 * So Poster is INCONSISTENT across endpoints:
 *   - `dash.getAnalytics` / `dash.getTransactions` are already in so'm
 *     (the doc §8 "to'g'ri so'm" note describes THESE endpoints);
 *   - `dash.getPaymentsReport.total.payed_*_sum` is in TIYIN — it must be
 *     divided by 100 before it reconciles with the headline revenue.
 *
 * That mismatch is exactly why the revenue breakdown showed 0%/0 against an
 * 11M headline: the breakdown was synthesised from the LOCAL `sales` table
 * (demo mode) while the headline came from a different (corrupted) source,
 * and any attempt to read getPaymentsReport without the ÷100 over-stated the
 * total 100×. This module is the single place that converts and aggregates.
 */
import {
  classifyPosterPayment,
  emptyPaymentBuckets,
  type PaymentMethodKey,
} from './paymentMethods.js';
import type { PosterAnalytics, PosterPaymentReport } from './client.js';

/** 1 so'm = 100 tiyin. getPaymentsReport sums are in tiyin (see file header). */
export const TIYIN_PER_SOM = 100;

/**
 * Convert a Poster `payed_*_sum` (tiyin, string or number) to so'm. Empty or
 * non-numeric input yields 0 (never NaN — a NaN bucket would silently break
 * the breakdown total).
 */
export function tiyinToSom(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / TIYIN_PER_SOM;
}

/** Legacy per-method row shape (older tests / hypothetical Poster variant). */
type LegacyPaymentRow = {
  payment_id?: string | number;
  payment_title?: string;
  payment_sum?: string | number;
};

export type PaymentBreakdown = {
  byMethod: Record<PaymentMethodKey, number>;
  /** Grand total in so'm — always equals the sum of `byMethod`. */
  total: number;
};

/**
 * Aggregate a `dash.getPaymentsReport` response into so'm buckets that always
 * reconcile (sum of buckets === total).
 *
 * Accepts BOTH shapes Poster has been seen to emit:
 *   1. the real `{days?, total}` aggregate (production) — read `total.payed_*`;
 *   2. a legacy `[{payment_id, payment_title, payment_sum}]` row array — classify
 *      each row by id/title.
 *
 * In the aggregate shape, getPaymentsReport does NOT split Payme/Click — it only
 * exposes cash / card / ewallet / cert / bonus. We route cash->cash, card->card,
 * and everything else (ewallet, third-party, bonus, cert) into `other` so the
 * total still reconciles. A finer Payme/Click split needs a per-transaction or
 * per-method endpoint and is handled elsewhere when required.
 */
export function paymentReportToBuckets(
  report: PosterPaymentReport | LegacyPaymentRow[] | null | undefined,
): PaymentBreakdown {
  const byMethod = emptyPaymentBuckets();

  if (report === null || report === undefined) {
    return { byMethod, total: 0 };
  }

  // ---- Legacy per-method row array ----
  if (Array.isArray(report)) {
    for (const row of report) {
      const key = classifyPosterPayment(
        row.payment_id === undefined ? undefined : Number(row.payment_id),
        row.payment_title,
      );
      byMethod[key] += tiyinToSom(row.payment_sum);
    }
    const total = sumBuckets(byMethod);
    return { byMethod, total };
  }

  // ---- Real `{days, total}` aggregate ----
  const t = report.total ?? {};
  byMethod.cash = tiyinToSom(t.payed_cash_sum);
  byMethod.card = tiyinToSom(t.payed_card_sum);
  // Payme/Click are not separated by this endpoint -> bundle the rest in
  // `other` so the breakdown reconciles. (Cert in/out net to ~0; bonus and
  // ewallet/third-party land here.)
  byMethod.other =
    tiyinToSom(t.payed_ewallet_sum) +
    tiyinToSom(t.payed_third_party_sum) +
    tiyinToSom(t.payed_bonus_sum) +
    tiyinToSom(t.payed_cert_in_sum);

  // Prefer Poster's own grand total when present; else sum the components we
  // mapped. Either way, normalise `other` so buckets always equal `total`.
  const reportedTotal = tiyinToSom(t.payed_sum_sum);
  const mapped = sumBuckets(byMethod);
  let total: number;
  if (reportedTotal > 0) {
    total = reportedTotal;
    // Reconcile rounding / any sum not captured above into `other`.
    const drift = round2(reportedTotal - mapped);
    if (Math.abs(drift) > 0.005) {
      byMethod.other = round2(byMethod.other + drift);
    }
  } else {
    total = mapped;
  }

  // Round every bucket to 2 dp for clean money output.
  byMethod.cash = round2(byMethod.cash);
  byMethod.card = round2(byMethod.card);
  byMethod.payme = round2(byMethod.payme);
  byMethod.click = round2(byMethod.click);
  byMethod.other = round2(byMethod.other);
  return { byMethod, total: round2(total) };
}

function sumBuckets(b: Record<PaymentMethodKey, number>): number {
  return b.cash + b.card + b.payme + b.click + b.other;
}

export type DailyRevenue = { date: string; revenue: number };

/**
 * EPIC 0.2 — turn a `dash.getAnalytics?interpolate=day` response into a dated
 * daily revenue series in so'm. The `data` array is aligned day-by-day from
 * `dateFrom` (inclusive). Analytics values are ALREADY in so'm (see
 * `PosterAnalytics`) — no ÷100 here.
 *
 * @param analytics the raw getAnalytics response.
 * @param dateFrom  the `YYYY-MM-DD` of the FIRST `data` entry.
 * @returns one `{date, revenue}` per `data` entry, dates incrementing by a day.
 */
export function analyticsToDailySom(
  analytics: PosterAnalytics | null | undefined,
  dateFrom: string,
): DailyRevenue[] {
  const data = analytics?.data;
  if (!Array.isArray(data) || data.length === 0) return [];
  const start = parseIsoDate(dateFrom);
  if (start === null) return [];
  return data.map((v, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const n = typeof v === 'number' ? v : Number(v);
    return { date: toIsoDate(d), revenue: Number.isFinite(n) ? round2(n) : 0 };
  });
}

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
