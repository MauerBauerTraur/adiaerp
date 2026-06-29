/**
 * F4.1 — Unit tests for `lib/principal.ts` (ADR-0012).
 *
 * Pure helper behaviour — no Express, no DB. Targets:
 *   - assertLocationAccess: M:N membership, PM bypass, forbidden path.
 *   - getEffectiveLocationIds: PM null; active scoping; full set fallback.
 */
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '../src/auth/jwt.js';
import { AppError } from '../src/errors/index.js';
import {
  assertLocationAccess,
  getEffectiveLocationIds,
  isSuperAdmin,
} from '../src/lib/principal.js';

function principal(over: Partial<AuthPrincipal>): AuthPrincipal {
  return {
    userId: 1,
    role: 'store_manager',
    locationId: 1,
    locationIds: [1],
    activeLocationId: null,
    ...over,
  } as AuthPrincipal;
}

describe('isSuperAdmin', () => {
  it('true for pm, false otherwise', () => {
    expect(isSuperAdmin(principal({ role: 'pm' }))).toBe(true);
    expect(isSuperAdmin(principal({ role: 'store_manager' }))).toBe(false);
  });
});

describe('assertLocationAccess — M:N', () => {
  it('PM passes for any location', () => {
    expect(() => assertLocationAccess(principal({ role: 'pm', locationIds: [] }), 42)).not.toThrow();
  });

  it('a scoped user passes for any id in its assignment set', () => {
    const p = principal({ locationIds: [10, 20, 30] });
    expect(() => assertLocationAccess(p, 10)).not.toThrow();
    expect(() => assertLocationAccess(p, 20)).not.toThrow();
    expect(() => assertLocationAccess(p, 30)).not.toThrow();
  });

  it('a scoped user is forbidden from any id outside its set', () => {
    const p = principal({ locationIds: [10, 20] });
    expect(() => assertLocationAccess(p, 99)).toThrow(AppError);
  });

  it('an empty set forbids every location for a scoped user', () => {
    const p = principal({ locationIds: [], role: 'store_manager' });
    expect(() => assertLocationAccess(p, 1)).toThrow(AppError);
  });
});

describe('getEffectiveLocationIds', () => {
  it('PM returns null (chain-wide)', () => {
    expect(getEffectiveLocationIds(principal({ role: 'pm', locationIds: [] }))).toBeNull();
  });

  it('returns [activeLocationId] when one is set', () => {
    const p = principal({ locationIds: [10, 20, 30], activeLocationId: 20 });
    expect(getEffectiveLocationIds(p)).toEqual([20]);
  });

  it('falls back to the full assignment set when no active is selected', () => {
    const p = principal({ locationIds: [10, 20, 30], activeLocationId: null });
    expect(getEffectiveLocationIds(p)).toEqual([10, 20, 30]);
  });
});
