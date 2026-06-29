import { useAuth } from './useAuth';
import type { Role } from '@/lib/types';

/**
 * Roles with chain-wide super-admin write access — can act on any location
 * without a location assignment. These bypass `canActOn` location checks.
 */
const SUPER_ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['super_admin', 'pm']);

/**
 * Roles that can only read — no business write access.
 * `ai_assistant` is read-only; PM and super_admin are now full-write (2026-06-25).
 */
const READ_ONLY_ROLES: ReadonlyArray<Role> = ['ai_assistant'];

export interface UseCanActResult {
  /**
   * True when the signed-in user can ONLY read the chain — every write
   * button must be hidden. Mirrors backend `authorizeWrite()` which
   * returns 403 for these roles on every business endpoint.
   */
  isReadOnly: boolean;
  /**
   * True when the signed-in user is a location operator (any role that
   * the backend lets through `authorizeWrite()`). Convenient negation
   * of `isReadOnly` for callers that prefer the positive phrasing.
   */
  isOperator: boolean;
  /**
   * Decides whether the current user may act on a resource attached to
   * a given `location_id`. Mirrors the backend guard
   * `requireLocationOperator()` (apps/backend/src/auth/rbac.ts) so the
   * UI hides a button whenever the API would reject the call with 403.
   *
   * Rules (in order):
   *   1. No signed-in user                → false.
   *   2. Read-only role (ai_assistant)    → false.
   *   3. super_admin or pm               → true (chain-wide, no location check).
   *   4. `resourceLocationId` is nullish  → false.
   *   5. The user is assigned to that location (M:N — ADR-0012) → true.
   *   6. Otherwise (foreign location)     → false.
   *
   * NOTE — the assignment check reads from `auth.locations`
   * (the M:N set hydrated by `/api/auth/me`). It does NOT fall back to
   * `user.location_id` because the primary is already inside
   * `locations` whenever it exists.
   */
  canActOn: (resourceLocationId: number | null | undefined) => boolean;
}

/**
 * Single source of truth for "may this user click this button?" on the
 * frontend. Pages should derive every write-action visibility from
 * `canActOn(resource.location_id)` instead of inline `role === 'pm'`
 * checks — otherwise the UI shows a button that the backend will 403
 * the moment the user clicks it (bad UX + audit-log noise).
 *
 * Example usage:
 * ```tsx
 * const { isReadOnly, canActOn } = useCanAct();
 * return (
 *   <>
 *     {isReadOnly && <Badge>Faqat o'qish</Badge>}
 *     {canActOn(order.location_id) && (
 *       <Button onClick={finish}>Yakunlash</Button>
 *     )}
 *   </>
 * );
 * ```
 */
export function useCanAct(): UseCanActResult {
  const { user, locations } = useAuth();

  const isReadOnly =
    user !== null && READ_ONLY_ROLES.includes(user.role);
  const isOperator = user !== null && !isReadOnly;

  const canActOn = (
    resourceLocationId: number | null | undefined,
  ): boolean => {
    if (user === null) return false;
    if (isReadOnly) return false;
    // super_admin and pm can act on any location without an explicit assignment.
    if (SUPER_ADMIN_ROLES.has(user.role)) return true;
    if (resourceLocationId === null || resourceLocationId === undefined) {
      return false;
    }
    return locations.some((loc) => loc.id === resourceLocationId);
  };

  return { isReadOnly, isOperator, canActOn };
}
