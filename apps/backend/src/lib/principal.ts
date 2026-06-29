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
 * Hardened RBAC guard for **write** actions (owner-approved 2026-05-28).
 *
 * Two enforcement axes — both must pass for the operator to proceed:
 *
 *   1. PM (super-admin) is **never** allowed to perform a business write
 *      action. The owner's rule: PM is read-and-recommend across the chain;
 *      every "do" must be the responsible location's operator. Even though
 *      PM has chain-wide visibility, it must NOT bypass `(product,location)`
 *      ownership for stock movements, replenishment cancels, production
 *      orders, purchase approvals, etc. Configuration endpoints (users,
 *      locations, products, admin, stock minmax) are explicitly exempt and
 *      gated by `authorize('pm', ...)` elsewhere.
 *
 *   2. A scoped operator must own the target location — i.e.
 *      `targetLocationId` must be one of `principal.locationIds`. The M:N
 *      assignment from F4.1 / ADR-0012 still applies: a manager assigned to
 *      multiple stores may act on any of them.
 *
 * Both 403s are best-effort audit-logged so a downstream reviewer can spot
 * misconfigured operators (or attempted privilege escalation) in the audit
 * trail. Audit failures must not turn into 5xx, so the write is wrapped in
 * a catch-all.
 */
export async function requireLocationOperator(
  principal: AuthPrincipal,
  targetLocationId: number,
): Promise<void> {
  if (isSuperAdmin(principal)) {
    await safeAudit({
      actorUserId: principal.userId,
      action: 'auth.forbidden.pm_write_blocked',
      entity: 'principal',
      entityId: principal.userId,
      payload: { reason: 'pm_write_blocked', target_location_id: targetLocationId },
      activeLocationId: principal.activeLocationId,
    });
    throw AppError.forbidden(
      'PM has read-only access; write actions require an operator role for the responsible location.',
    );
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
