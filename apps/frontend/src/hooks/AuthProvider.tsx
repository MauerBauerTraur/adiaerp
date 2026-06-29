import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
  getActiveLocation,
  setActiveLocation as persistActiveLocation,
} from '@/lib/auth-storage';
import { apiRequest, ApiError } from '@/lib/api-client';
import { env } from '@/lib/env';
import type { MeLocation, MeResponse, User } from '@/lib/types';
import { AuthContext, type AuthContextValue } from './auth-context';

/**
 * Auth state holder.
 *
 * On mount, if an access token is already stored, the session is
 * re-hydrated via `GET /api/auth/me`. While that request is in flight
 * `isHydrating` is true so the router can hold rendering and avoid a
 * flash of the login screen for an already-valid session. If the
 * stored access token is expired, `apiRequest` will transparently
 * refresh it before failing the hydration call.
 *
 * F4.1 (ADR-0012) — the `/api/auth/me` envelope now also carries the
 * user's M:N locations and the server-derived `active_location_id`.
 * AuthProvider mirrors both into context so the header LocationSwitcher
 * and any RBAC-aware screen can read them without an extra fetch.
 *
 * Token storage tradeoff and rationale: see `lib/auth-storage.ts`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() =>
    getAccessToken(),
  );
  const [user, setUser] = useState<User | null>(null);
  const [locations, setLocations] = useState<MeLocation[]>([]);
  const [activeLocationId, setActiveLocationIdState] = useState<number | null>(
    () => getActiveLocation(),
  );
  // Hydrate whenever EITHER token survives — even if the access token
  // was evicted (e.g. browser cleared localStorage of just that key),
  // a live refresh token can rotate us a fresh access on the very first
  // /api/auth/me call.
  const [isHydrating, setIsHydrating] = useState<boolean>(
    () => getAccessToken() !== null || getRefreshToken() !== null,
  );

  const login = useCallback(
    (
      tokens: { accessToken: string; refreshToken: string },
      nextUser: User,
    ) => {
      setTokens(tokens);
      setTokenState(tokens.accessToken);
      setUser(nextUser);
      setLocations([]);
      // F4.11 Bug-MAJ-01 — the mount-time `/api/auth/me` hydration
      // effect only runs once per <AuthProvider /> mount, so it does
      // NOT re-fire after a fresh login. If we left the active
      // location null here, the very next `apiRequest` (e.g. the
      // dashboard's first call) would go out WITHOUT the
      // `X-Active-Location` header — and any route that 500's on a
      // missing header (e.g. `/api/supply`) would fail until the user
      // refreshes the page.
      //
      // The login response carries the user's primary `location_id`
      // (mirrored from `user_locations.is_primary=TRUE`), so we seed
      // the active-location from it. Chain-wide roles (`pm`,
      // `ai_assistant`) have `location_id === null`; for them we
      // explicitly drop any stale value from a previous session so
      // they start in chain-wide scope.
      if (nextUser.location_id !== null && nextUser.location_id !== undefined) {
        persistActiveLocation(nextUser.location_id);
        setActiveLocationIdState(nextUser.location_id);
      } else {
        persistActiveLocation(null);
        setActiveLocationIdState(null);
      }
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    const refreshToken = getRefreshToken();

    // Best-effort, idempotent revoke. We deliberately use a plain
    // `fetch` (not `apiRequest`) so a 401 here cannot recurse back
    // into the refresh-retry loop. Any failure is swallowed — the
    // local session is cleared regardless.
    if (refreshToken !== null) {
      try {
        await fetch(`${env.apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        /* offline / network — clear local state anyway */
      }
    }

    // `clearTokens()` also drops the active-location selection — see
    // `lib/auth-storage.ts`. Mirror those drops into React state so
    // every consumer (sidebar, header switcher) re-renders cleanly.
    clearTokens();
    setTokenState(null);
    setUser(null);
    setLocations([]);
    setActiveLocationIdState(null);
  }, []);

  /**
   * F4.1 — switch the user's active bo'g'in. Persists to localStorage
   * (so subsequent `apiRequest` calls carry `X-Active-Location`),
   * tells the server (audit row + 403 if the user is not assigned),
   * and updates context state. Rethrows on failure so the caller can
   * toast an error and roll back its optimistic UI.
   */
  const setActiveLocation = useCallback(async (id: number): Promise<void> => {
    await apiRequest<{ active_location_id: number }>(
      '/api/auth/active-location',
      {
        method: 'PATCH',
        body: { location_id: id },
        // Send the NEW id explicitly so the audit row records the
        // user's intent — not the previously-active scope.
        headers: { 'X-Active-Location': String(id) },
      },
    );
    persistActiveLocation(id);
    setActiveLocationIdState(id);
  }, []);

  // Re-hydrate the user from a stored token on first load / reload.
  useEffect(() => {
    // Only bail when *neither* token is present — if only the refresh
    // token survived, apiRequest's 401 handler will rotate a new access
    // before /api/auth/me completes.
    if (token === null && getRefreshToken() === null) {
      setIsHydrating(false);
      return;
    }
    let cancelled = false;

    apiRequest<MeResponse>('/api/auth/me')
      .then((me) => {
        if (cancelled) return;
        // The refresh-and-retry flow may have written a fresh access
        // token to storage; mirror it into local state so the rest of
        // the app sees the current pair.
        const refreshed = getAccessToken();
        if (refreshed !== null && refreshed !== token) {
          setTokenState(refreshed);
        }
        setUser(me.user);
        setLocations(me.locations ?? []);
        // Prefer the server-side `active_location_id` (it knows the
        // user's primary) over the localStorage value, which may be
        // stale if the user was reassigned elsewhere. The server has
        // already validated the choice — mirror it into storage so
        // every later request sends the matching `X-Active-Location`.
        if (me.active_location_id !== null && me.active_location_id !== undefined) {
          persistActiveLocation(me.active_location_id);
          setActiveLocationIdState(me.active_location_id);
        } else {
          persistActiveLocation(null);
          setActiveLocationIdState(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 401 means the stored tokens are dead — drop the session.
        // The api-client already clears tokens on a terminal 401;
        // mirror it here.
        if (err instanceof ApiError && err.status === 401) {
          setTokenState(null);
          setUser(null);
          setLocations([]);
          setActiveLocationIdState(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsHydrating(false);
      });

    return () => {
      cancelled = true;
    };
    // Run once for the token present at mount; login()/logout() manage
    // the user state directly afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: token !== null,
      isHydrating,
      locations,
      activeLocationId,
      login,
      logout,
      setActiveLocation,
    }),
    [
      user,
      token,
      isHydrating,
      locations,
      activeLocationId,
      login,
      logout,
      setActiveLocation,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
