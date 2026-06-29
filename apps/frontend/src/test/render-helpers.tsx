/**
 * Shared test helpers for component / contract tests.
 *
 * `renderWithProviders` wires up the providers a page needs (router,
 * toast, and a pre-authenticated auth context) so list pages can be
 * rendered in isolation without going through the real login flow.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import type { LocationType, MeLocation, Role, User } from '@/lib/types';

/** A test `User`; override `role`/`location_id` per scenario. */
export function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Test PM',
    username: 'pm',
    role: 'pm',
    location_id: null,
    ...overrides,
  };
}

function fakeAuth(
  user: User,
  locations: MeLocation[] = [],
  activeLocationId: number | null = null,
): AuthContextValue {
  return {
    user,
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    locations,
    activeLocationId,
    login: () => {},
    logout: async () => {},
    setActiveLocation: async () => {},
  };
}

interface RenderOptions {
  /** Role for the injected auth context (defaults to `pm`). */
  role?: Role;
  /** Location id for the injected user (defaults to `null`). */
  locationId?: number | null;
  /**
   * M:N assignment set hydrated by `/api/auth/me` (ADR-0012). When
   * omitted, a single primary row is synthesized from `locationId` so
   * `useCanAct` returns true for that one location. Pass an explicit
   * empty array to simulate a chain-wide role (`pm`, `ai_assistant`).
   */
  locations?: MeLocation[];
  /** Bo'g'in type used when synthesizing the default MeLocation row. */
  locationType?: LocationType;
  /** Override the injected user id (defaults to 1). Useful for the
   *  purchase-order manager step where the backend ties the approval
   *  to `created_by === user.id`. */
  userId?: number;
}

/** Render `ui` inside router + toast + an authenticated auth context. */
export function renderWithProviders(
  ui: ReactElement,
  {
    role = 'pm',
    locationId = null,
    locations,
    locationType = 'production',
    userId,
  }: RenderOptions = {},
) {
  const user = fakeUser({
    role,
    location_id: locationId,
    ...(userId !== undefined ? { id: userId } : {}),
  });
  // If the caller did not pass an explicit M:N set, synthesize one from
  // the primary `locationId` so write-button assertions work without
  // every test having to redeclare the same fixture.
  const meLocations: MeLocation[] =
    locations ??
    (locationId === null
      ? []
      : [
          {
            id: locationId,
            name: `Test location ${locationId}`,
            type: locationType,
            is_primary: true,
          },
        ]);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={fakeAuth(user, meLocations, locationId)}>
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

/** Build a JSON `Response` for a mocked `fetch`. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
