/**
 * Sub-task #6 — Unit tests for `lib/units.ts` (`formatQty`, `isProductUnit`).
 *
 * Pure-function tests — no DB, no fixtures. Covers each unit branch, edge
 * cases (zero, fractional pcs, very-small kg), the unknown-unit fallback,
 * and the type guard.
 */
import { describe, it, expect } from 'vitest';
import { formatQty, isProductUnit } from '../src/lib/units.js';

describe('formatQty', () => {
  it('formats pcs as integer + "dona"', () => {
    expect(formatQty(12, 'pcs')).toBe('12 dona');
    expect(formatQty(0, 'pcs')).toBe('0 dona');
    // Fractional pcs is meaningless — round to integer.
    expect(formatQty(2.6, 'pcs')).toBe('3 dona');
  });

  it('formats kg with 2 decimals', () => {
    expect(formatQty(3.5, 'kg')).toBe('3.50 kg');
    expect(formatQty(0, 'kg')).toBe('0.00 kg');
    expect(formatQty(0.001, 'kg')).toBe('0.00 kg');
    expect(formatQty(100, 'kg')).toBe('100.00 kg');
  });

  it('formats l with 2 decimals', () => {
    expect(formatQty(1.25, 'l')).toBe('1.25 l');
    expect(formatQty(5, 'l')).toBe('5.00 l');
  });

  it('falls back to "<qty> <unit>" for unknown unit tokens', () => {
    expect(formatQty(7, 'm')).toBe('7 m');
    expect(formatQty(2, 'gram')).toBe('2 gram');
  });

  it('does not throw for non-finite qty', () => {
    expect(formatQty(NaN, 'kg')).toMatch(/NaN/);
    expect(formatQty(Infinity, 'pcs')).toMatch(/Infinity/);
  });
});

describe('isProductUnit', () => {
  it('returns true for kg / l / pcs', () => {
    expect(isProductUnit('kg')).toBe(true);
    expect(isProductUnit('l')).toBe(true);
    expect(isProductUnit('pcs')).toBe(true);
  });

  it('returns false for anything else', () => {
    expect(isProductUnit('m')).toBe(false);
    expect(isProductUnit('')).toBe(false);
    expect(isProductUnit(undefined)).toBe(false);
    expect(isProductUnit(123)).toBe(false);
    expect(isProductUnit(null)).toBe(false);
  });
});
