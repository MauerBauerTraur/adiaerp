/**
 * `src/lib/navPaths.ts` is a hand-maintained mirror of the frontend
 * navigation model. If the two drift, `PUT /api/users/:id/pages` starts
 * rejecting a screen that exists (or accepting one that doesn't), and the
 * failure is invisible until an admin tries to grant it.
 *
 * This test reads the frontend source directly and fails on any difference.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAV_PATHS } from '../src/lib/navPaths.js';

const NAV_SOURCE = fileURLToPath(
  new URL('../../frontend/src/lib/navigation.ts', import.meta.url),
);

describe('NAV_PATHS', () => {
  it('matches every path in the frontend navigation model', () => {
    const source = readFileSync(NAV_SOURCE, 'utf8');
    const frontendPaths = [
      ...source.matchAll(/^\s*path: '([^']+)',$/gm),
    ].map((m) => m[1]!);

    // Guard against the regex silently matching nothing after a refactor.
    expect(frontendPaths.length).toBeGreaterThan(10);

    expect([...frontendPaths].sort()).toEqual([...NAV_PATHS].sort());
  });

  it('has no duplicates', () => {
    expect(new Set(NAV_PATHS).size).toBe(NAV_PATHS.length);
  });
});
