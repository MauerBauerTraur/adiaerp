/**
 * `authenticate` middleware — verifies the `Authorization: Bearer <JWT>`
 * header and attaches the principal to `req.auth`.
 *
 * F4.1 / ADR-0012 — multi-location extension:
 *   1. Verify the access JWT (sync, stateless) -> `JwtPrincipal`.
 *   2. Load every `user_locations` row for that user (DB lookup, one query)
 *      -> `locationIds`. Chain-wide roles (pm, ai_assistant) get `[]`.
 *   3. Read the optional `X-Active-Location` header. If present, it MUST
 *      be in `locationIds` for non-chain-wide users — otherwise 403
 *      `ACTIVE_LOCATION_NOT_ALLOWED`. If absent, fall back to the
 *      primary `locationId` from the JWT.
 *
 * Wired onto every M1-M3 business endpoint; later modules reuse it as-is.
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthPrincipal } from '../auth/jwt.js';
import { verifyToken } from '../auth/jwt.js';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { SUPER_ADMIN_ROLES } from '../auth/roles.js';
import './types.js';

const BEARER_PREFIX = 'Bearer ';
const ACTIVE_LOCATION_HEADER = 'x-active-location';

/**
 * Require a valid JWT. On success, `req.auth` is populated and control
 * passes on; on failure, a 401 `UNAUTHENTICATED` error is forwarded.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization');
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    next(AppError.unauthenticated('Missing or malformed Authorization header.'));
    return;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token === '') {
    next(AppError.unauthenticated('Empty bearer token.'));
    return;
  }

  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    // Do not leak verification internals (expired vs. malformed) to clients.
    next(AppError.unauthenticated('Invalid or expired token.'));
    return;
  }

  try {
    // M:N — load every assigned location. Chain-wide roles (pm) have no
    // rows in `user_locations` (and shouldn't), so `locationIds = []` —
    // `isSuperAdmin` is the gate for them.
    const { rows } = await query<{ location_id: string }>(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [claims.userId],
    );
    const locationIds = rows.map((r) => Number(r.location_id));

    // Resolve the active location: header (validated) > primary > null.
    const headerRaw = req.header(ACTIVE_LOCATION_HEADER);
    let activeLocationId: number | null = claims.locationId;
    if (headerRaw !== undefined && headerRaw.trim() !== '') {
      const headerNum = Number(headerRaw);
      if (!Number.isInteger(headerNum) || headerNum <= 0) {
        next(
          new AppError(
            'VALIDATION_ERROR',
            'X-Active-Location header must be a positive integer.',
          ),
        );
        return;
      }
      // Chain-wide roles may pick any active location (PM-level access);
      // scoped roles must have it in their assigned set.
      if (!SUPER_ADMIN_ROLES.has(claims.role) && !locationIds.includes(headerNum)) {
        next(
          new AppError(
            'FORBIDDEN',
            'X-Active-Location is not assigned to this user.',
          ),
        );
        return;
      }
      activeLocationId = headerNum;
    }

    const principal: AuthPrincipal = {
      userId: claims.userId,
      role: claims.role,
      locationId: claims.locationId,
      locationIds,
      activeLocationId,
    };
    req.auth = principal;
    next();
  } catch (err) {
    next(err);
  }
}
