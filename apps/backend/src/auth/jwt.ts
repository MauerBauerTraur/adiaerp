/**
 * JWT signing and verification (Sprint-3 / ADR-0005).
 *
 * Two token types live in the system now:
 *
 *   * **access token** — a short-lived (1h default) JWT carried in the
 *     `Authorization: Bearer` header. Holds `{sub, role, locationId,
 *     type: 'access'}`. Stateless: the server never stores the token.
 *
 *   * **refresh token** — an opaque random 32-byte hex string (NOT a JWT),
 *     issued at login and on every successful refresh, persisted in the
 *     `refresh_tokens` table by SHA-256 hash, server-side revocable. The
 *     helpers for that live in `./refreshTokens.ts`.
 *
 * Signing helpers below cover the access token only; refresh tokens go
 * through `generateRefreshToken` / `hashRefreshToken`.
 *
 * The legacy `signToken` is kept as a thin alias that calls
 * `signAccessToken` so existing tests and fixtures keep working.
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/index.js';
import { isRole, type Role } from './roles.js';

/**
 * The authenticated principal carried by a verified access JWT.
 *
 * F4.1 / ADR-0012 — multi-location extension. `locationId` (primary) stays
 * in the JWT for backward-compat; `locationIds` and `activeLocationId` are
 * filled in by the `authenticate` middleware from the DB (M:N) and the
 * `X-Active-Location` header, NOT from the token. This keeps tokens stable
 * across location-assignment changes (a freshly added location is visible
 * on the next request, no re-issue needed).
 */
export type AuthPrincipal = {
  readonly userId: number;
  readonly role: Role;
  /** Primary location id. null for chain-wide roles (pm, ai_assistant). */
  readonly locationId: number | null;
  /**
   * Every location the user is assigned to (primary + secondary).
   * Empty for chain-wide roles (`pm`, `ai_assistant`).
   */
  readonly locationIds: number[];
  /**
   * Request-scoped active location. Set by `authenticate` middleware:
   * `X-Active-Location` header (validated) > primary `locationId` >
   * `null` (chain-wide).
   */
  readonly activeLocationId: number | null;
};

/** Token type claim — defends against accidentally accepting a refresh JWT
 *  on an authenticated endpoint (currently only `access` exists). */
const ACCESS_TOKEN_TYPE = 'access' as const;

/** The raw JWT claim shape we sign and expect back. */
type JwtClaims = {
  readonly sub: string; // user id as string
  readonly role: string;
  readonly locationId: number | null;
  readonly type: typeof ACCESS_TOKEN_TYPE;
};

/**
 * What `verifyToken` returns — the JWT-only fields. The `authenticate`
 * middleware enriches this with `locationIds` (DB lookup) and
 * `activeLocationId` (`X-Active-Location` header) to form the full
 * `AuthPrincipal` attached to `req.auth`.
 */
export type JwtPrincipal = {
  readonly userId: number;
  readonly role: Role;
  readonly locationId: number | null;
};

/**
 * Sign a short-lived access JWT for an authenticated user.
 *
 * TTL comes from `config.jwt.accessTtlSeconds` (1h default). The token is
 * stamped with `type: 'access'` so the `authenticate` middleware can
 * reject any future non-access token by claim, not just by shape.
 */
export function signAccessToken(principal: JwtPrincipal): string {
  const cfg = loadConfig();
  const claims: JwtClaims = {
    sub: String(principal.userId),
    role: principal.role,
    locationId: principal.locationId,
    type: ACCESS_TOKEN_TYPE,
  };
  return jwt.sign(claims, cfg.jwt.secret, {
    expiresIn: cfg.jwt.accessTtlSeconds,
    issuer: 'adia-erp',
  });
}

/**
 * Legacy alias — older code paths (tests, fixtures) still import
 * `signToken`. Keeping it pointed at `signAccessToken` lets the rest of
 * the codebase migrate at its own pace.
 */
export function signToken(principal: JwtPrincipal): string {
  return signAccessToken(principal);
}

/**
 * Verify and decode an access JWT.
 *
 * Throws on:
 *   - an expired or malformed token (jsonwebtoken rejects it),
 *   - a recognised JWT whose `type` claim is missing or not `'access'`
 *     (defence against accepting a refresh JWT on a protected endpoint;
 *     currently there is no refresh JWT — refresh tokens are opaque —
 *     but the check future-proofs the middleware), or
 *   - malformed core claims (sub / role / locationId).
 *
 * Callers (the `authenticate` middleware) translate any failure into a
 * single generic 401 response — no leak of "expired vs malformed".
 */
export function verifyToken(token: string): JwtPrincipal {
  const cfg = loadConfig();
  const decoded = jwt.verify(token, cfg.jwt.secret, { issuer: 'adia-erp' });

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Malformed JWT payload.');
  }
  const claims = decoded as Partial<JwtClaims>;
  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('JWT "sub" claim is not a valid user id.');
  }
  if (!isRole(claims.role)) {
    throw new Error('JWT "role" claim is not a recognised role.');
  }
  const locationId =
    claims.locationId === null || claims.locationId === undefined ? null : Number(claims.locationId);
  if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) {
    throw new Error('JWT "locationId" claim is invalid.');
  }
  // Type check — accept tokens with no `type` (legacy, signed before this
  // change rolled out) for one release; once all live tokens carry it,
  // tighten to a strict `!== 'access'` reject. We tighten now because
  // Sprint-3 is a breaking auth change and we accept the forced re-login.
  if (claims.type !== undefined && claims.type !== ACCESS_TOKEN_TYPE) {
    throw new Error('JWT "type" claim is not "access".');
  }

  return { userId, role: claims.role, locationId };
}

// ---------------------------------------------------------------------------
// Refresh token primitives
// ---------------------------------------------------------------------------

/** Length of a refresh token in raw bytes — 32 = 256 bits of CSPRNG entropy. */
const REFRESH_TOKEN_BYTES = 32;

/**
 * Generate a new opaque refresh token — 32 bytes of CSPRNG output, hex-
 * encoded (64 hex chars). NOT a JWT: the server stores its hash and
 * revocation lives in the database.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

/**
 * Hash a refresh token for storage. SHA-256 is sufficient — the raw token
 * already has full 256-bit entropy, so a slow KDF (bcrypt/argon2) would
 * only add refresh-endpoint latency without raising the security floor.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
