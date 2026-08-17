import { describe, expect, it } from 'vitest';
import { isKaymakProduct } from '../src/lib/productCategory.js';

// Drives the "always raise a sub-order" branch in POST /api/production-orders:
// a kaymak component is ordered regardless of stock, everything else keeps the
// shortfall rule. Names are taken from real production data.
describe('isKaymakProduct', () => {
  it('accepts the kaymak family in both Cyrillic spellings', () => {
    expect(isKaymakProduct('крем каймак')).toBe(true);
    expect(isKaymakProduct('крем каймак (какао)')).toBe(true);
    expect(isKaymakProduct('крем каймок (варёное)')).toBe(true);
    expect(isKaymakProduct('крем каймок с ичной')).toBe(true);
  });

  it('rejects other semi-finished components', () => {
    expect(isKaymakProduct('крем масляный')).toBe(false);
    expect(isKaymakProduct('крем творожный')).toBe(false);
    expect(isKaymakProduct('баунти крем')).toBe(false);
    expect(isKaymakProduct('бисквит творожный')).toBe(false);
    expect(isKaymakProduct('з/г творожный')).toBe(false);
  });

  it('is case-insensitive and accepts the Latin spelling', () => {
    expect(isKaymakProduct('КРЕМ КАЙМАК')).toBe(true);
    expect(isKaymakProduct('Krem kaymok')).toBe(true);
  });
});
