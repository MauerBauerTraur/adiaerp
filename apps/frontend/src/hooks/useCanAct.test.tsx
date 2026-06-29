/**
 * useCanAct — frontend mirror of the backend `authorizeWrite()` +
 * `requireLocationOperator()` guards (Stage 1/2 of the RBAC hardening).
 *
 * The hook is the single source of truth for write-button visibility:
 * if `canActOn(loc)` returns false, the page MUST NOT render the button
 * — otherwise the backend will 403 the click and produce audit-log
 * noise (`auth.forbidden.pm_write_blocked` /
 *   `auth.forbidden.foreign_location`).
 *
 * Acceptance matrix (covered below):
 *   - PM            → isReadOnly=true, canActOn(anything)=false
 *   - ai_assistant  → isReadOnly=true, canActOn(anything)=false
 *   - operator on own location   → canActOn=true
 *   - operator on foreign loc    → canActOn=false
 *   - operator with null loc arg → canActOn=false (defensive)
 *   - no signed-in user          → everything false
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { AuthContext, type AuthContextValue } from './auth-context';
import { useCanAct } from './useCanAct';
import type { MeLocation, Role, User } from '@/lib/types';

function makeUser(role: Role, locationId: number | null): User {
  return {
    id: 42,
    name: 'Test User',
    username: 'testuser',
    role,
    location_id: locationId,
  };
}

function makeLocation(id: number, isPrimary = false): MeLocation {
  return {
    id,
    name: `Location ${id}`,
    type: 'production',
    is_primary: isPrimary,
  };
}

function wrapWithAuth(ctx: Partial<AuthContextValue>) {
  const base: AuthContextValue = {
    user: null,
    token: null,
    isAuthenticated: false,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    setActiveLocation: vi.fn(async () => undefined),
    ...ctx,
  };
  return ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={base}>{children}</AuthContext.Provider>
  );
}

describe('useCanAct', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PM (read-and-recommend)', () => {
    it('reports isReadOnly=true and refuses every canActOn call', () => {
      const wrapper = wrapWithAuth({
        user: makeUser('pm', null),
        locations: [], // PM is chain-wide; no M:N rows
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.isReadOnly).toBe(true);
      expect(result.current.isOperator).toBe(false);
      expect(result.current.canActOn(1)).toBe(false);
      expect(result.current.canActOn(99)).toBe(false);
      expect(result.current.canActOn(null)).toBe(false);
    });

    it('stays read-only even if a location is somehow assigned', () => {
      // Defensive guard — the policy is role-first, not assignment-first.
      const wrapper = wrapWithAuth({
        user: makeUser('pm', null),
        locations: [makeLocation(7, true)],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.isReadOnly).toBe(true);
      expect(result.current.canActOn(7)).toBe(false);
    });
  });

  describe('ai_assistant (read-and-recommend)', () => {
    it('is read-only and refuses every canActOn call', () => {
      const wrapper = wrapWithAuth({
        user: makeUser('ai_assistant', null),
        locations: [],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.isReadOnly).toBe(true);
      expect(result.current.isOperator).toBe(false);
      expect(result.current.canActOn(1)).toBe(false);
    });
  });

  describe('location operator', () => {
    it('canActOn returns true for an assigned location', () => {
      const wrapper = wrapWithAuth({
        user: makeUser('production_manager', 5),
        locations: [makeLocation(5, true)],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.isReadOnly).toBe(false);
      expect(result.current.isOperator).toBe(true);
      expect(result.current.canActOn(5)).toBe(true);
    });

    it('canActOn returns false for a foreign location', () => {
      const wrapper = wrapWithAuth({
        user: makeUser('production_manager', 5),
        locations: [makeLocation(5, true)],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.canActOn(7)).toBe(false);
    });

    it('respects the full M:N assignment set (ADR-0012)', () => {
      // Operator assigned to two locations — both should pass.
      const wrapper = wrapWithAuth({
        user: makeUser('store_manager', 11),
        locations: [makeLocation(11, true), makeLocation(12)],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.canActOn(11)).toBe(true);
      expect(result.current.canActOn(12)).toBe(true);
      expect(result.current.canActOn(13)).toBe(false);
    });

    it('canActOn returns false when the resource location is nullish', () => {
      // Defensive — a write whose target is unknown can never be safe.
      const wrapper = wrapWithAuth({
        user: makeUser('production_manager', 5),
        locations: [makeLocation(5, true)],
      });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.canActOn(null)).toBe(false);
      expect(result.current.canActOn(undefined)).toBe(false);
    });
  });

  describe('no signed-in user', () => {
    it('reports both flags false and refuses every canActOn call', () => {
      const wrapper = wrapWithAuth({ user: null, locations: [] });
      const { result } = renderHook(() => useCanAct(), { wrapper });

      expect(result.current.isReadOnly).toBe(false);
      expect(result.current.isOperator).toBe(false);
      expect(result.current.canActOn(1)).toBe(false);
      expect(result.current.canActOn(null)).toBe(false);
    });
  });
});
