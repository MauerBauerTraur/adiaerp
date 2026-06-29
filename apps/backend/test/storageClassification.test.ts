/**
 * Unit tests for the ADR-0017 Poster storage -> ADIA location_type mapping.
 *
 * Pure table assertions — no DB. Guards the 25-storage classification so a
 * future edit cannot silently re-introduce the P1 "everything is
 * central_warehouse" bug or move a storage to the wrong link.
 */
import { describe, expect, it } from 'vitest';
import {
  STORAGE_TYPE_BY_ID,
  STORE_BACKING_STORAGE,
  DEFAULT_STORAGE_TYPE,
  classifyStorage,
  isStoreBackingStorage,
} from '../src/integrations/poster/storageClassification.js';

describe('storageClassification — STORAGE_TYPE_BY_ID', () => {
  it('maps the three singleton links to their exact types', () => {
    expect(STORAGE_TYPE_BY_ID[2]).toBe('raw_warehouse');
    expect(STORAGE_TYPE_BY_ID[8]).toBe('central_warehouse');
    expect(STORAGE_TYPE_BY_ID[20]).toBe('production');
  });

  it('classifies exactly ONE central_warehouse (the dashboard fix)', () => {
    const central = Object.values(STORAGE_TYPE_BY_ID).filter((t) => t === 'central_warehouse');
    expect(central).toHaveLength(1);
  });

  it('classifies exactly ONE raw_warehouse and ONE production', () => {
    const types = Object.values(STORAGE_TYPE_BY_ID);
    expect(types.filter((t) => t === 'raw_warehouse')).toHaveLength(1);
    expect(types.filter((t) => t === 'production')).toHaveLength(1);
  });

  it('maps the remaining 19 classified storages to sex_storage', () => {
    const sex = Object.values(STORAGE_TYPE_BY_ID).filter((t) => t === 'sex_storage');
    expect(sex).toHaveLength(19);
  });

  it('does NOT include store-backing storages 3/4/5 (they merge into spots)', () => {
    expect(STORAGE_TYPE_BY_ID[3]).toBeUndefined();
    expect(STORAGE_TYPE_BY_ID[4]).toBeUndefined();
    expect(STORAGE_TYPE_BY_ID[5]).toBeUndefined();
  });

  it('covers 22 classified storages (25 live minus 3 store-backing)', () => {
    expect(Object.keys(STORAGE_TYPE_BY_ID)).toHaveLength(22);
  });
});

describe('storageClassification — STORE_BACKING_STORAGE', () => {
  it('maps the 3 store-backing storages to their POS spots', () => {
    expect(STORE_BACKING_STORAGE).toEqual({ 3: 1, 4: 2, 5: 3 });
  });
});

describe('storageClassification — helpers', () => {
  it('classifyStorage returns the mapped type for a known id', () => {
    expect(classifyStorage(8)).toBe('central_warehouse');
    expect(classifyStorage(19)).toBe('sex_storage');
  });

  it('classifyStorage falls back to the safe default for an unknown id', () => {
    expect(classifyStorage(999)).toBe(DEFAULT_STORAGE_TYPE);
    expect(DEFAULT_STORAGE_TYPE).toBe('sex_storage');
  });

  it('isStoreBackingStorage is true only for 3/4/5', () => {
    expect(isStoreBackingStorage(3)).toBe(true);
    expect(isStoreBackingStorage(4)).toBe(true);
    expect(isStoreBackingStorage(5)).toBe(true);
    expect(isStoreBackingStorage(8)).toBe(false);
    expect(isStoreBackingStorage(999)).toBe(false);
  });
});
