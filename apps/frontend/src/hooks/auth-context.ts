import { createContext } from 'react';
import type { MeLocation, User } from '@/lib/types';

export interface AuthContextValue {
  user: User | null;
  /** Current access token (the one sent as `Authorization: Bearer`). */
  token: string | null;
  isAuthenticated: boolean;
  /** True while a stored token is being verified via GET /api/auth/me. */
  isHydrating: boolean;
  /**
   * F4.1 / ADR-0012 — every location the signed-in user is assigned to
   * (M:N). Empty for fresh sessions before hydration completes, and for
   * chain-wide roles that have no assignments yet.
   */
  locations: MeLocation[];
  /**
   * F4.1 / ADR-0012 — the location currently scoping the user's RBAC
   * view. `null` when no choice has been made; the backend then falls
   * back to the user's primary location.
   */
  activeLocationId: number | null;
  /** Persists the access+refresh pair and updates context state. */
  login: (
    tokens: { accessToken: string; refreshToken: string },
    user: User,
  ) => void;
  /**
   * Revokes the refresh token on the backend (best-effort, idempotent)
   * and clears the local session — including the active-location.
   */
  logout: () => Promise<void>;
  /**
   * Switch the active bo'g'in. Calls `PATCH /api/auth/active-location`
   * for validation + audit; on success the new id is persisted to
   * storage and mirrored into context. Rejects on backend error so the
   * caller can toast and roll back any optimistic UI.
   */
  setActiveLocation: (id: number) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
