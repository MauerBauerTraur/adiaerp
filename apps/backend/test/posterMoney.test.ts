/**
 * EPIC 0.3 — Poster money-unit helper.
 *
 * Live diagnostic (2026-05-29, account `adia`) proved the two revenue
 * endpoints use DIFFERENT units:
 *   - dash.getAnalytics   -> already in so'm   ("19553300.0000" for one day)
 *   - dash.getPaymentsReport `payed_*_sum` -> TIYIN, exactly 100× larger
 *     (same day: payed_sum_sum = 1955330000 == 19553300 * 100).
 * So `getPaymentsReport` totals must be divided by 100 before they reconcile
 * with the headline revenue. These tests pin that contract.
 */
import { describe, expect, it } from 'vitest';
import {
  tiyinToSom,
  paymentReportToBuckets,
  analyticsToDailySom,
} from '../src/integrations/poster/posterMoney.js';

describe('tiyinToSom', () => {
  it('divides tiyin by 100 to get so\'m', () => {
    expect(tiyinToSom('1955330000')).toBe(19_553_300);
    expect(tiyinToSom(6_666_172_000)).toBe(66_661_720);
  });

  it('returns 0 for empty / non-numeric input', () => {
    expect(tiyinToSom(undefined)).toBe(0);
    expect(tiyinToSom('')).toBe(0);
    expect(tiyinToSom('abc')).toBe(0);
    expect(tiyinToSom(null as unknown as string)).toBe(0);
  });
});

describe('paymentReportToBuckets', () => {
  it('maps the real {total} aggregate to so\'m buckets that reconcile', () => {
    // Verified-against-live payload (2026-05-29 day total).
    const report = {
      days: [],
      total: {
        payed_cash_sum: 870_577_000,
        payed_card_sum: 1_084_753_000,
        payed_ewallet_sum: 0,
        payed_cert_in_sum: 0,
        payed_cert_out_sum: 0,
        payed_bonus_sum: 0,
        payed_sum_sum: 1_955_330_000,
        transactions_count: 84,
      },
    };
    const { byMethod, total } = paymentReportToBuckets(report);
    // tiyin -> so'm
    expect(byMethod.cash).toBe(8_705_770);
    expect(byMethod.card).toBe(10_847_530);
    expect(total).toBe(19_553_300);
    // Buckets reconcile to the reported total.
    const sum =
      byMethod.cash + byMethod.card + byMethod.payme + byMethod.click + byMethod.other;
    expect(sum).toBe(total);
  });

  it('routes ewallet/third-party into a dedicated bucket so total still reconciles', () => {
    const report = {
      total: {
        payed_cash_sum: 100_000, // 1000 so'm
        payed_card_sum: 0,
        payed_ewallet_sum: 50_000, // 500 so'm -> "other" (Payme/Click not split by this endpoint)
        payed_sum_sum: 150_000,
      },
    };
    const { byMethod, total } = paymentReportToBuckets(report);
    expect(byMethod.cash).toBe(1000);
    expect(byMethod.other).toBe(500);
    expect(total).toBe(1500);
    const sum =
      byMethod.cash + byMethod.card + byMethod.payme + byMethod.click + byMethod.other;
    expect(sum).toBe(total);
  });

  it('falls back to summing components when payed_sum_sum is absent', () => {
    const report = {
      total: {
        payed_cash_sum: 200_000,
        payed_card_sum: 300_000,
      },
    };
    const { total } = paymentReportToBuckets(report);
    expect(total).toBe(5000); // (200000 + 300000) / 100
  });

  it('handles a row-array legacy shape by classifying titles', () => {
    const legacy = [
      { payment_id: 1, payment_title: 'Наличные', payment_sum: '100000' },
      { payment_id: 2, payment_title: 'Карта', payment_sum: '200000' },
      { payment_id: 5, payment_title: 'Payme', payment_sum: '50000' },
    ];
    const { byMethod, total } = paymentReportToBuckets(legacy);
    expect(byMethod.cash).toBe(1000);
    expect(byMethod.card).toBe(2000);
    expect(byMethod.payme).toBe(500);
    expect(total).toBe(3500);
  });
});

describe('analyticsToDailySom', () => {
  it('aligns the data series day-by-day from dateFrom (so\'m, no ÷100)', () => {
    // Tail of the real 2026-05-29 diagnostic series (already so'm).
    const analytics = {
      data: ['31059707.0000', '34788091.0000', '49282950.0000'],
      counters: { revenue: '115130748.0000' },
    };
    const out = analyticsToDailySom(analytics, '2026-04-30');
    expect(out).toEqual([
      { date: '2026-04-30', revenue: 31_059_707 },
      { date: '2026-05-01', revenue: 34_788_091 },
      { date: '2026-05-02', revenue: 49_282_950 },
    ]);
  });

  it('returns [] for an empty or missing series', () => {
    expect(analyticsToDailySom({ data: [] }, '2026-05-01')).toEqual([]);
    expect(analyticsToDailySom(undefined, '2026-05-01')).toEqual([]);
    expect(analyticsToDailySom({ data: ['1'] }, 'bad-date')).toEqual([]);
  });
});
