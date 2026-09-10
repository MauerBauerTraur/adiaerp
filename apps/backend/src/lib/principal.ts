/**
 * Principal access + location-scope guard helpers.
 *
 * `authenticate` attaches `req.auth`; these helpers read it with a definite
 * (non-undefined) type and enforce the location-scoped half of RBAC
 * (invariant 6 — "a store sees only its own data").
 *
 * F4.1 / ADR-0012 — multi-location (M:N) extension:
 *   - `principal.locationIds` carries every location the user is assigned
 *     to (primary + secondary). PM (chain-wide) gets an empty array — the
 *     `isSuperAdmin` branch handles them.
 *   - `principal.activeLocationId` is the request-scoped context: the
 *     `X-Active-Location` header takes precedence over the primary
 *     `locationId`. The header is validated against `locationIds` —
 *     anything outside the user's assigned set is a 403.
 *   - `assertLocationAccess` now accepts ANY assigned location.
 *   - `getEffectiveLocationIds` is the helper RBAC-scoped SQL uses to
 *     decide which ids to filter by — see callers in `routes/stock.ts`,
 *     `routes/replenishment.ts`, etc.
 */
import type { Request } from 'express';
import type { AuthPrincipal } from '../auth/jwt.js';
import { SUPER_ADMIN_ROLES } from '../auth/roles.js';
import { AppError } from '../errors/index.js';
import { poolRunner, writeAudit } from './audit.js';

/** Read the verified principal; throws if `authenticate` did not run. */
export function getPrincipal(req: Request): AuthPrincipal {
  const principal = req.auth;
  if (principal === undefined) {
    throw AppError.unauthenticated('Authentication must run before this handler.');
  }
  return principal;
}

/** True when the principal is a chain-wide super-admin (`pm` or `super_admin`). */
export function isSuperAdmin(principal: AuthPrincipal): boolean {
  return SUPER_ADMIN_ROLES.has(principal.role);
}

/**
 * Enforce that a location-scoped principal may only touch a location it is
 * assigned to. `pm` (and any chain-wide super-admin) passes for any
 * location. A scoped principal must have `targetLocationId` in its
 * `locationIds` set (M:N — ADR-0012).
 */
export function assertLocationAccess(
  principal: AuthPrincipal,
  targetLocationId: number,
): void {
  if (isSuperAdmin(principal)) {
    return;
  }
  if (!principal.locationIds.includes(targetLocationId)) {
    throw AppError.forbidden('You may only access data for your own location.');
  }
}

/**
 * The set of location ids RBAC-scoped queries should filter by, in order
 * of preference:
 *
 *   1. PM (super-admin) — `null` (caller treats this as "no filter").
 *   2. `activeLocationId` set — narrow scope to that one location (better
 *      UX: "I picked Filial-2 in the header, show me only Filial-2").
 *   3. Otherwise — every assigned `locationIds`.
 *
 * `null` is reserved for chain-wide principals so callers can branch on it
 * unambiguously.
 */
export function getEffectiveLocationIds(
  principal: AuthPrincipal,
): number[] | null {
  if (isSuperAdmin(principal)) {
    return null;
  }
  if (principal.activeLocationId !== null) {
    return [principal.activeLocationId];
  }
  return principal.locationIds;
}

/**
 * Location-ownership guard for **write** actions.
 *
 * A scoped operator must own the target location — `targetLocationId` must be
 * one of `principal.locationIds`. The M:N assignment from F4.1 / ADR-0012
 * applies: a manager assigned to multiple stores may act on any of them.
 *
 * Super-admin roles (`super_admin`, `pm`) pass. The earlier rule
 * (owner-approved 2026-05-28) made PM read-and-recommend and blocked it here;
 * the owner replaced it on 2026-06-25 — PM adds/edits/deletes everything —
 * which `authorizeWrite` already honoured. Leaving this guard on the old rule
 * left the two halves contradicting each other: a PM sailed through
 * `authorizeWrite` only to hit "PM has read-only access" from the handler, so
 * whether a PM write worked came down to which endpoint it hit.
 *
 * A foreign-location 403 is best-effort audit-logged so a downstream reviewer
 * can spot misconfigured operators (or attempted privilege escalation) in the
 * audit trail. Audit failures must not turn into 5xx, so the write is wrapped
 * in a catch-all.
 */
export async function requireLocationOperator(
  principal: AuthPrincipal,
  targetLocationId: number,
): Promise<void> {
  // super_admin / pm act on any location (owner decision 2026-06-25).
  if (isSuperAdmin(principal)) {
    return;
  }
  if (!principal.locationIds.includes(targetLocationId)) {
    await safeAudit({
      actorUserId: principal.userId,
      action: 'auth.forbidden.foreign_location',
      entity: 'principal',
      entityId: principal.userId,
      payload: {
        reason: 'foreign_location',
        target_location_id: targetLocationId,
        assigned_location_ids: principal.locationIds,
      },
      activeLocationId: principal.activeLocationId,
    });
    throw AppError.forbidden('You may only act on data for your own location.');
  }
}

/** Best-effort audit write — swallows DB failures so a 403 path stays 403. */
async function safeAudit(
  entry: Parameters<typeof writeAudit>[1],
): Promise<void> {
  try {
    await writeAudit(poolRunner, entry);
  } catch {
    // Audit table may be missing or DB may be unavailable in dev/tests; the
    // 403 itself is the user-facing signal and must not regress to 500.
  }
}
