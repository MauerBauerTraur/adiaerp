/**
 * F4.7 — Tests for the executive dashboard formatters.
 *
 * Covers `formatCurrencyCompact`, `formatDateLong`, and `getGreeting`.
 * The existing `formatQty` / `formatDateTime` / `formatRelative` helpers
 * are exercised indirectly via component tests; this file pins the new
 * boshliq-dashboard surface.
 */
import { describe, it, expect } from 'vitest';
import {
  formatCurrencyCompact,
  formatDateLong,
  getGreeting,
} from './format';

describe('formatCurrencyCompact', () => {
  it('abbreviates millions with an M suffix', () => {
    expect(formatCurrencyCompact(2_400_000)).toBe('2,4M');
    expect(formatCurrencyCompact(12_500_000)).toBe('12,5M');
  });

  it('abbreviates billions with mlrd', () => {
    expect(formatCurrencyCompact(1_250_000_000)).toBe('1,25mlrd');
  });

  it('abbreviates 10K+ with K', () => {
    expect(formatCurrencyCompact(980_000)).toBe('980K');
    expect(formatCurrencyCompact(15_500)).toBe('16K');
  });

  it('renders small values with locale grouping', () => {
    expect(formatCurrencyCompact(0)).toBe('0');
    // The uz-UZ locale uses a NO-BREAK SPACE (U+00A0) as the
    // grouping separator, so the assertion must use the exact codepoint.
    expect(formatCurrencyCompact(1500)).toBe('1 500');
  });

  it('handles negative values', () => {
    expect(formatCurrencyCompact(-2_400_000)).toBe('-2,4M');
  });

  it('returns em-dash for non-finite', () => {
    expect(formatCurrencyCompact(Number.NaN)).toBe('—');
    expect(formatCurrencyCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDateLong', () => {
  it('formats an ISO date as "D-month YYYY, weekday"', () => {
    // 2026-05-24 is a Sunday → "yakshanba".
    expect(formatDateLong('2026-05-24')).toBe('24-may 2026, yakshanba');
  });

  it('handles full ISO timestamps', () => {
    expect(formatDateLong('2026-01-05T08:30:00.000Z')).toMatch(
      /5-yanvar 2026, /,
    );
  });

  it('echoes the raw input on invalid date', () => {
    expect(formatDateLong('not-a-date')).toBe('not-a-date');
  });
});

describe('getGreeting', () => {
  function at(hour: number): Date {
    const d = new Date(2026, 4, 24, hour, 0, 0);
    return d;
  }

  it('returns "Xayrli tong" between 04:00 and 11:59', () => {
    expect(getGreeting(at(4))).toBe('Xayrli tong');
    expect(getGreeting(at(11))).toBe('Xayrli tong');
  });

  it('returns "Xayrli kun" between 12:00 and 17:59', () => {
    expect(getGreeting(at(12))).toBe('Xayrli kun');
    expect(getGreeting(at(17))).toBe('Xayrli kun');
  });

  it('returns "Xayrli kech" between 18:00 and 22:59', () => {
    expect(getGreeting(at(18))).toBe('Xayrli kech');
    expect(getGreeting(at(22))).toBe('Xayrli kech');
  });

  it('returns "Xayrli tun" between 23:00 and 03:59', () => {
    expect(getGreeting(at(23))).toBe('Xayrli tun');
    expect(getGreeting(at(0))).toBe('Xayrli tun');
    expect(getGreeting(at(3))).toBe('Xayrli tun');
  });
});
