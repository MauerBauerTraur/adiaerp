/**
 * EPIC 1.3 — server-side smart category unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveCategory,
  effectiveType,
  hasReadyPrefix,
} from '../src/lib/productCategory.js';

describe('hasReadyPrefix (Г/П)', () => {
  it('detects the ready-product prefix in several separator forms', () => {
    expect(hasReadyPrefix('Г/П Торт Наполеон')).toBe(true);
    expect(hasReadyPrefix('Г\\П Эклер')).toBe(true);
    expect(hasReadyPrefix('ГП Бисквит')).toBe(true);
    expect(hasReadyPrefix('Г П Круассан')).toBe(true);
  });

  it('does not false-match a name that merely starts with Г', () => {
    expect(hasReadyPrefix('Газировка')).toBe(false);
    expect(hasReadyPrefix('Шоколад')).toBe(false);
  });
});

describe('effectiveType', () => {
  it('upgrades a Г/П-prefixed semi/raw to finished', () => {
    expect(effectiveType('Г/П Торт', 'semi')).toBe('finished');
    expect(effectiveType('Г/П Хлеб', 'raw')).toBe('finished');
  });

  it('keeps the stored type when there is no prefix', () => {
    expect(effectiveType('Мука', 'raw')).toBe('raw');
    expect(effectiveType('Крем', 'semi')).toBe('semi');
  });
});

describe('deriveCategory', () => {
  it('classifies drinks', () => {
    expect(deriveCategory('Coca Cola 0.5', 'finished')).toBe('drink');
    expect(deriveCategory('Flavis апельсин', 'finished')).toBe('drink');
  });

  it('classifies decorations', () => {
    expect(deriveCategory('Number Candles', 'finished')).toBe('decoration');
    expect(deriveCategory('Декор посыпка', 'finished')).toBe('decoration');
  });

  it('classifies cakes and pastries', () => {
    expect(deriveCategory('Торт Медовик', 'finished')).toBe('cake');
    expect(deriveCategory('Наполеон', 'finished')).toBe('pastry');
  });

  it('falls back to the coarse type when no name hint fires', () => {
    expect(deriveCategory('Мука', 'raw')).toBe('raw');
    expect(deriveCategory('Крем заварной', 'semi')).toBe('semi');
  });
});
