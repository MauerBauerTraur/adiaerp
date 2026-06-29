/**
 * EPIC 1.2 — server-side translit search normalisation unit tests.
 */
import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeSearch } from '../src/lib/translit.js';

describe('normalizeSearch', () => {
  it('collapses Cyrillic and Latin onto the same key', () => {
    expect(normalizeSearch('шоколад')).toBe(normalizeSearch('shokolad'));
    expect(normalizeSearch('Сахар')).toBe(normalizeSearch('sahar'));
  });

  it('strips punctuation and whitespace', () => {
    expect(normalizeSearch('Coca-Cola 0.5 L')).toBe('kokakola05l');
  });
});

describe('matchesSearch', () => {
  it('matches across scripts both ways', () => {
    expect(matchesSearch('Шоколад тёмный', 'shokolad')).toBe(true);
    expect(matchesSearch('Shokolad dark', 'шоколад')).toBe(true);
  });

  it('matches a substring', () => {
    expect(matchesSearch('Тортовая основа', 'tort')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesSearch('Сахар', 'shokolad')).toBe(false);
  });

  it('empty query matches everything', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '   ')).toBe(true);
  });
});
