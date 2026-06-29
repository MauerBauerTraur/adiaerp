import { describe, it, expect } from 'vitest';
import { normalizeSearch, matchesSearch } from './translit';

describe('translit — normalizeSearch', () => {
  it('folds a Cyrillic and Latin spelling onto the same key', () => {
    // "шоколад" and "shokolad" must collapse to the same canonical form.
    expect(normalizeSearch('шоколад')).toBe(normalizeSearch('shokolad'));
  });

  it('handles the Latin "sh" digraph as the Cyrillic ш', () => {
    expect(normalizeSearch('shakar')).toBe(normalizeSearch('шакар'));
  });

  it('folds c → k so "coca" matches "кока"', () => {
    expect(normalizeSearch('coca')).toBe(normalizeSearch('кока'));
  });

  it('strips spaces, punctuation and case', () => {
    expect(normalizeSearch('  Coca-Cola!  ')).toBe(normalizeSearch('кока кола'));
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeSearch('   ')).toBe('');
  });
});

describe('translit — matchesSearch', () => {
  it('matches a Latin query against a Cyrillic product name', () => {
    expect(matchesSearch('Шоколад горький', 'shokolad')).toBe(true);
  });

  it('matches a Cyrillic query against a Latin product name', () => {
    expect(matchesSearch('Shokoladli tort', 'шоколад')).toBe(true);
  });

  it('is a substring match, not exact', () => {
    expect(matchesSearch('Сахарная пудра', 'sahar')).toBe(true);
  });

  it('returns true for an empty query (match-all)', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '   ')).toBe(true);
  });

  it('returns false when there is no overlap', () => {
    expect(matchesSearch('Un (oliy nav)', 'shokolad')).toBe(false);
  });
});
