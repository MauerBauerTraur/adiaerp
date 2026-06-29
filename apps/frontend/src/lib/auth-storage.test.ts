/**
 * Unit tests for the token persistence module — Sprint 3 added the
 * refresh-token flow (`docs/specs/phase-1-mvp.md §4.1`). The module
 * now stores TWO tokens (access + refresh) and exposes a different
 * API than the original single-`token` helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
  getActiveLocation,
  setActiveLocation,
} from './auth-storage';

const ACCESS_KEY = 'adia.access_token';
const REFRESH_KEY = 'adia.refresh_token';
const ACTIVE_LOCATION_KEY = 'adia.active_location';

describe('auth-storage', () => {
  beforeEach(() => {
    clearTokens();
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
    window.localStorage.removeItem(ACTIVE_LOCATION_KEY);
  });

  it('returns null when no tokens are stored', () => {
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('persists both tokens to localStorage with the documented keys', () => {
    setTokens({ accessToken: 'A1', refreshToken: 'R1' });
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe('A1');
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('R1');
  });

  it('reads back the stored tokens via the typed getters', () => {
    setTokens({ accessToken: 'A2', refreshToken: 'R2' });
    expect(getAccessToken()).toBe('A2');
    expect(getRefreshToken()).toBe('R2');
  });

  it('overwrites a previous pair on subsequent setTokens()', () => {
    setTokens({ accessToken: 'old-a', refreshToken: 'old-r' });
    setTokens({ accessToken: 'new-a', refreshToken: 'new-r' });
    expect(getAccessToken()).toBe('new-a');
    expect(getRefreshToken()).toBe('new-r');
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe('new-a');
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('new-r');
  });

  it('clearTokens() drops both tokens from memory AND localStorage', () => {
    setTokens({ accessToken: 'A', refreshToken: 'R' });
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(window.localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('hydrates the in-memory cache from localStorage on first read', () => {
    // Simulates a fresh page load: a previous session wrote to
    // localStorage, the in-memory cache was reset by `clearTokens()`,
    // and the next getter must repopulate from storage.
    window.localStorage.setItem(ACCESS_KEY, 'persisted-a');
    window.localStorage.setItem(REFRESH_KEY, 'persisted-r');
    expect(getAccessToken()).toBe('persisted-a');
    expect(getRefreshToken()).toBe('persisted-r');
  });

  // F4.1 / ADR-0012 — active-location selection storage.
  describe('active location (F4.1)', () => {
    it('returns null when nothing is persisted', () => {
      expect(getActiveLocation()).toBeNull();
    });

    it('persists and reads back the active-location id', () => {
      setActiveLocation(42);
      expect(getActiveLocation()).toBe(42);
      expect(window.localStorage.getItem(ACTIVE_LOCATION_KEY)).toBe('42');
    });

    it('setActiveLocation(null) drops the value from storage', () => {
      setActiveLocation(7);
      setActiveLocation(null);
      expect(getActiveLocation()).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_LOCATION_KEY)).toBeNull();
    });

    it('clearTokens() also clears the active-location selection', () => {
      // Logout invariant — the next user must not inherit the previous
      // user's scope.
      setTokens({ accessToken: 'A', refreshToken: 'R' });
      setActiveLocation(123);
      clearTokens();
      expect(getActiveLocation()).toBeNull();
      expect(window.localStorage.getItem(ACTIVE_LOCATION_KEY)).toBeNull();
    });

    it('hydrates the active-location from localStorage on a fresh load', () => {
      // Simulates a page reload: storage already has the value, the
      // in-memory cache was just cleared.
      window.localStorage.setItem(ACTIVE_LOCATION_KEY, '99');
      expect(getActiveLocation()).toBe(99);
    });
  });
});
