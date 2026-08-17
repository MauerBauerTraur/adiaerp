import { describe, expect, it } from 'vitest';
import { isKaymakProduct } from './KremKaymokchiPage';

// Names taken from real production data. The Krem kaymokchi screen is scoped to
// the kaymak family; other creams and zagotovka work belong to other screens.
describe('isKaymakProduct', () => {
  it('accepts the kaymak family in both spellings', () => {
    expect(isKaymakProduct('крем каймак')).toBe(true);
    expect(isKaymakProduct('крем каймак (какао)')).toBe(true);
    expect(isKaymakProduct('крем каймок (варёное)')).toBe(true);
    expect(isKaymakProduct('крем каймок с ичной')).toBe(true);
  });

  it('rejects other creams', () => {
    expect(isKaymakProduct('крем масляный')).toBe(false);
    expect(isKaymakProduct('крем творожный')).toBe(false);
    expect(isKaymakProduct('баунти крем')).toBe(false);
  });

  it('rejects zagotovka products', () => {
    expect(isKaymakProduct('бисквит черный')).toBe(false);
    expect(isKaymakProduct('з/г баунти (пирожное)')).toBe(false);
    expect(isKaymakProduct('зувала наполеон')).toBe(false);
  });

  it('is case-insensitive and accepts the Latin spelling', () => {
    expect(isKaymakProduct('КРЕМ КАЙМАК')).toBe(true);
    expect(isKaymakProduct('Krem kaymok')).toBe(true);
  });
});
