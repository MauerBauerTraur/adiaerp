import { describe, it, expect } from 'vitest';
import {
  deriveCategory,
  effectiveType,
  hasReadyPrefix,
  PRODUCT_CATEGORY_STYLE,
} from './productCategory';
import type { Product } from './types';

function product(overrides: Partial<Product>): Product {
  return {
    id: 1,
    name: 'X',
    type: 'finished',
    unit: 'pcs',
    sku: null,
    poster_ingredient_id: null,
    poster_product_id: null,
    is_active: true,
    ...overrides,
  };
}

describe('productCategory — hasReadyPrefix (EPIC 1.3)', () => {
  it('detects the Г/П ready-product prefix in several forms', () => {
    expect(hasReadyPrefix('Г/П Шоколадный торт')).toBe(true);
    expect(hasReadyPrefix('г\\п эклер')).toBe(true);
    expect(hasReadyPrefix('  Г/П  наполеон')).toBe(true);
  });

  it('does not fire on names that merely start with Г or П', () => {
    expect(hasReadyPrefix('Горький шоколад')).toBe(false);
    expect(hasReadyPrefix('Печенье')).toBe(false);
  });
});

describe('productCategory — effectiveType', () => {
  it('upgrades a Г/П-prefixed semi product to finished', () => {
    const p = product({ type: 'semi', name: 'Г/П Тортик' });
    expect(effectiveType(p)).toBe('finished');
  });

  it('keeps the stored type when there is no prefix', () => {
    expect(effectiveType(product({ type: 'raw', name: 'Мука' }))).toBe('raw');
  });
});

describe('productCategory — deriveCategory (EPIC 1.3 / 1.4)', () => {
  it('classifies drinks by name', () => {
    expect(deriveCategory(product({ name: 'Coca Cola 0.5' }))).toBe('drink');
    expect(deriveCategory(product({ name: 'Flavis апельсин' }))).toBe('drink');
  });

  it('classifies cake decorations by name', () => {
    expect(deriveCategory(product({ name: 'Number Candles 5' }))).toBe(
      'decoration',
    );
    expect(deriveCategory(product({ name: 'Свечи для торта' }))).toBe(
      'decoration',
    );
  });

  it('classifies cakes and pastries', () => {
    expect(deriveCategory(product({ name: 'Шоколадный торт' }))).toBe('cake');
    expect(deriveCategory(product({ name: 'Наполеон' }))).toBe('pastry');
  });

  it('falls back to the coarse type when no name rule fires', () => {
    expect(deriveCategory(product({ type: 'raw', name: 'Сахар' }))).toBe('raw');
    expect(deriveCategory(product({ type: 'semi', name: 'Заготовка' }))).toBe(
      'semi',
    );
  });

  it('every category has a defined visual style', () => {
    const categories = [
      'drink',
      'decoration',
      'cake',
      'pastry',
      'bread',
      'semi',
      'raw',
      'finished',
    ] as const;
    for (const c of categories) {
      expect(PRODUCT_CATEGORY_STYLE[c]).toBeDefined();
      expect(PRODUCT_CATEGORY_STYLE[c].accent).toMatch(/^border-l-/);
    }
  });
});
