/**
 * The hourly Poster recipe worker:
 *   - runs its passes SEQUENTIALLY: ingredients -> prepacks -> menu products.
 *     Prepacks and menu products resolve components that the earlier passes
 *     create or rename, so running them in parallel (the old Promise.all)
 *     raced and could bind stale/missing rows;
 *   - shares ONE advisory lock with the bulk recipe audit/apply/restore job
 *     and skips the cycle while that job holds it (review Y3).
 *
 * Pure unit test: the sync functions and the lock are mocked, no database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import {
  syncIngredients,
  syncMenuProducts,
  syncPrepacks,
} from '../src/integrations/poster/seedSync.js';
import {
  PosterClient,
  resetPosterClientCache,
  setPosterClientForTests,
} from '../src/integrations/poster/client.js';
import { acquirePosterRecipeLock } from '../src/integrations/poster/recipeLock.js';
import { runRecipeSyncCycle } from '../src/workers/posterRecipeSync.js';

vi.mock('../src/integrations/poster/seedSync.js', () => ({
  syncIngredients: vi.fn(),
  syncPrepacks: vi.fn(),
  syncMenuProducts: vi.fn(),
}));

vi.mock('../src/integrations/poster/modificationSync.js', () => ({
  syncModifications: vi.fn(() => Promise.resolve({ productsScanned: 0, modificationsUpserted: 0 })),
}));

vi.mock('../src/integrations/poster/recipeLock.js', () => ({
  acquirePosterRecipeLock: vi.fn(),
}));

const release = vi.fn(() => Promise.resolve());

beforeAll(async () => {
  process.env.POSTER_TOKEN = 'acc:test';
  const { resetConfigCache } = await import('../src/config/index.js');
  resetConfigCache();
  setPosterClientForTests(new PosterClient({ token: 'acc:test', minIntervalMs: 0 }));
});

beforeEach(() => {
  vi.mocked(syncIngredients).mockReset();
  vi.mocked(syncPrepacks).mockReset();
  vi.mocked(syncMenuProducts).mockReset();
  release.mockClear();
  vi.mocked(acquirePosterRecipeLock).mockReset();
  vi.mocked(acquirePosterRecipeLock).mockResolvedValue({ release });
});

afterAll(() => {
  setPosterClientForTests(undefined);
  resetPosterClientCache();
});

describe('runRecipeSyncCycle', () => {
  it('runs ingredients -> prepacks -> menu one after another, then releases the lock', async () => {
    const events: string[] = [];
    const pass = (name: string) => async () => {
      events.push(`${name}:start`);
      await delay(5);
      events.push(`${name}:end`);
      return { entity: 'products' as const, status: 'ok' as const, recordsIn: 0, recordsApplied: 0 };
    };
    vi.mocked(syncIngredients).mockImplementation(pass('ingredients'));
    vi.mocked(syncPrepacks).mockImplementation(pass('prepacks'));
    vi.mocked(syncMenuProducts).mockImplementation(pass('menu'));

    await runRecipeSyncCycle();

    expect(events).toEqual([
      'ingredients:start',
      'ingredients:end',
      'prepacks:start',
      'prepacks:end',
      'menu:start',
      'menu:end',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips the cycle (with a log) while the bulk recipe job holds the lock', async () => {
    vi.mocked(acquirePosterRecipeLock).mockResolvedValue(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runRecipeSyncCycle();
      expect(syncIngredients).not.toHaveBeenCalled();
      expect(syncPrepacks).not.toHaveBeenCalled();
      expect(syncMenuProducts).not.toHaveBeenCalled();
      expect(log.mock.calls.some((c) => String(c[0]).includes('lock'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('releases the lock even when a pass throws', async () => {
    vi.mocked(syncIngredients).mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runRecipeSyncCycle();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
