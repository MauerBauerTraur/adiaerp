/**
 * Regression — AuthProvider hydration must unwrap the `/api/auth/me`
 * envelope.
 *
 * The backend (spec §4.1) returns `{ user: {...} }`. After a page reload
 * the AuthProvider re-hydrates the session by calling
 * `apiRequest<User>('/api/auth/me')` and storing the result. If that
 * stored value is the wrapped envelope, every consumer that reads
 * `user.role` / `user.name` ends up with `undefined`, which silently
 * breaks role-gated routes (`RoleRoute` bounces to /dashboard), hides
 * the sidebar nav (`navSectionsForRole(undefined)` is empty), and
 * disables the cancel button on the replenishment detail page.
 *
 * The Prove-It pattern: this test FAILS today and stays in the suite as
 * the regression guard once AuthProvider is fixed to extract `me.user`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { clearTokens } from '@/lib/auth-storage';
import { jsonResponse } from '@/test/render-helpers';

const ACCESS_KEY = 'adia.access_token';
const REFRESH_KEY = 'adia.refresh_token';

function Probe() {
  const { user, isHydrating, locations, activeLocationId } = useAuth();
  if (isHydrating) return <div>hydrating</div>;
  return (
    <div>
      <span data-testid="role">{user?.role ?? 'NONE'}</span>
      <span data-testid="name">{user?.name ?? 'NONE'}</span>
      <span data-testid="locations-count">{locations.length}</span>
      <span data-testid="active-location">
        {activeLocationId === null ? 'NONE' : String(activeLocationId)}
      </span>
      <span data-testid="primary-location-name">
        {locations.find((l) => l.is_primary)?.name ?? 'NONE'}
      </span>
    </div>
  );
}

describe('AuthProvider — /api/auth/me hydration', () => {
  beforeEach(() => {
    clearTokens(); // reset the auth-storage memory cache too
    localStorage.setItem(ACCESS_KEY, 'fake-access');
    localStorage.setItem(REFRESH_KEY, 'fake-refresh');
  });

  afterEach(() => {
    clearTokens();
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    vi.restoreAllMocks();
  });

  it('extracts user.role from the wrapped `{ user }` envelope after reload', async () => {
    // Backend contract — phase-1-mvp.md §4.1: `GET /api/auth/me`
    // responds with `{ user: PublicUser }`.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        user: {
          id: 1,
          name: 'Loyiha menejeri',
          role: 'pm',
          location_id: null,
          telegram_id: null,
        },
      }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    // After hydration finishes, `user.role` must be the actual role,
    // not undefined (which would render the placeholder "NONE").
    await waitFor(() => {
      expect(screen.getByTestId('role').textContent).toBe('pm');
    });
    expect(screen.getByTestId('name').textContent).toBe('Loyiha menejeri');
  });

  it('exposes me.locations and active_location_id from the F4.1 envelope', async () => {
    // F4.1 — `/api/auth/me` enriches the envelope with the user's M:N
    // assignments and a server-derived `active_location_id`. The
    // AuthProvider mirrors both into context so the header switcher
    // and any RBAC-aware screen can read them without an extra fetch.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        user: {
          id: 9,
          name: 'Filial menejeri',
          role: 'store_manager',
          location_id: 11,
        },
        locations: [
          { id: 11, name: 'Filial-1', type: 'store', is_primary: true },
          { id: 12, name: 'Filial-2', type: 'store', is_primary: false },
        ],
        active_location_id: 12,
      }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('locations-count').textContent).toBe('2');
    });
    expect(screen.getByTestId('primary-location-name').textContent).toBe(
      'Filial-1',
    );
    expect(screen.getByTestId('active-location').textContent).toBe('12');
  });
});
