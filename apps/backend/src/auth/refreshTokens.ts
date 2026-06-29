/**
 * Refresh-token service (Sprint-3 / ADR-0005).
 *
 * The refresh token is an opaque 32-byte hex string the server issues at
 * login and rotates on every refresh. We store only the SHA-256 hash;
 * the raw token is returned ONCE to the client and never persists
 * anywhere on the server side.
 *
 * Lifecycle:
 *
 *   issue          login or rotation → INSERT a row, return the raw token.
 *   validateAndRotate
 *                  refresh request →
 *                    1. find the row by `token_hash`,
 *                    2. reject if missing, expired, or revoked,
 *                    3. inside ONE transaction:
 *                       a. issue a brand-new row,
 *                       b. mark the previous row revoked AND point
 *                          `rotated_to` at the new id (audit chain),
 *                    4. return the new raw token + the user it belongs to.
 *   revokeAllForUser
 *                  logout — revoke every active row for the user.
 *   cleanupExpired
 *                  daily cron — delete rows whose `expires_at` is older
 *                  than 7 days (short audit lag).
 *
 * Rotation atomicity matters: a refresh + race with logout must end in
 * exactly one of {old revoked, new active} or {old revoked, no new}.
 * We achieve that with a single transaction + `FOR UPDATE` row lock on
 * the lookup, so two concurrent refreshes on the same token serialise
 * and one of them sees the row already revoked.
 */
import { withTransaction } from '../db/index.js';
import { query } from '../db/index.js';
import { generateRefreshToken, hashRefreshToken } from './jwt.js';
import { loadConfig } from '../config/index.js';
import type { Role } from './roles.js';
import { isRole } from './roles.js';

/** Public shape returned to refresh-flow callers. */
export type IssuedRefreshToken = {
  /** The raw token — return to the client, then forget. */
  readonly rawToken: string;
  /** DB row id — useful for the audit chain on rotation. */
  readonly id: number;
  /** Computed expiry timestamp. */
  readonly expiresAt: Date;
};

/** Snapshot of the user a refresh token unlocks — used by the route layer. */
export type RefreshedUser = {
  readonly userId: number;
  readonly role: Role;
  readonly locationId: number | null;
};

/**
 * Issue a fresh refresh-token row for `userId`. Returns the raw token —
 * the caller must include it in the HTTP response and then forget it.
 *
 * `rotatedFromId` is set on rotation only (links the old row to the new).
 * Pass `null` on first issue (login).
 */
export async function issueRefreshToken(
  userId: number,
  opts: { userAgent?: string | null; rotatedFromId?: number | null } = {},
): Promise<IssuedRefreshToken> {
  const cfg = loadConfig();
  const rawToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);
  // expires_at = now() + N days. Compute in JS so the value we return
  // matches the value we INSERT (postgres `now()` could be a few ms ahead).
  const expiresAt = new Date(Date.now() + cfg.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [userId, tokenHash, expiresAt, opts.userAgent ?? null],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw new Error('issueRefreshToken: insert returned no id.');
  }
  const id = Number(idRaw);

  // If this row was minted by rotating an older one, fix up the audit
  // chain so the old row points at the new id. We do this outside the
  // rotation tx ONLY when called directly (login path: rotatedFromId
  // is null, nothing to fix up). `validateAndRotate` does it inside a tx.
  if (opts.rotatedFromId !== undefined && opts.rotatedFromId !== null) {
    await query(
      `UPDATE refresh_tokens SET rotated_to = $1 WHERE id = $2`,
      [id, opts.rotatedFromId],
    );
  }

  return { rawToken, id, expiresAt };
}

/**
 * Validate a raw refresh token and rotate it atomically.
 *
 * Returns:
 *   - `{ rawToken, user }` on success (the freshly minted token + the
 *     user it belongs to, ready for the access-token sign step).
 *   - `null` if the token is unknown, expired, revoked, or the user has
 *     been deactivated — the route layer maps that to a generic 401.
 */
export async function validateAndRotate(
  rawToken: string,
  opts: { userAgent?: string | null } = {},
): Promise<{ raw: string; expiresAt: Date; user: RefreshedUser } | null> {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
  const tokenHash = hashRefreshToken(rawToken);
  const cfg = loadConfig();
  const ttlMs = cfg.jwt.refreshTtlDays * 24 * 60 * 60 * 1000;

  return withTransaction(async (tx) => {
    // FOR UPDATE serialises any concurrent refresh on the same token —
    // the second tx sees a revoked row when it acquires the lock.
    const lookup = await tx.query<{
      id: string;
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      role: string;
      location_id: number | null;
      is_active: boolean;
    }>(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.role, u.location_id, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
        FOR UPDATE OF rt`,
      [tokenHash],
    );
    const row = lookup.rows[0];
    if (row === undefined) return null;
    if (row.revoked_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (!row.is_active) return null;
    if (!isRole(row.role)) return null;

    // Mint the new row in the same tx so the audit chain is consistent.
    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const newExpires = new Date(Date.now() + ttlMs);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
      [Number(row.user_id), newHash, newExpires, opts.userAgent ?? null],
    );
    const newId = Number(inserted.rows[0]?.id);
    if (!Number.isInteger(newId) || newId <= 0) {
      throw new Error('validateAndRotate: insert returned no id.');
    }
    // Revoke the previous row and stamp the chain pointer.
    await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now(), rotated_to = $1 WHERE id = $2`,
      [newId, Number(row.id)],
    );

    return {
      raw: newRaw,
      expiresAt: newExpires,
      user: {
        userId: Number(row.user_id),
        role: row.role,
        locationId: row.location_id,
      },
    };
  });
}

/**
 * Revoke a single refresh token by its raw value. Idempotent — an
 * already-revoked or unknown token returns `false` without error.
 */
export async function revokeOne(rawToken: string): Promise<boolean> {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return false;
  const tokenHash = hashRefreshToken(rawToken);
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return rowCount > 0;
}

/**
 * Revoke every active refresh token for a user — used by the
 * "logout everywhere" path and any future "force-logout" admin action.
 */
export async function revokeAllForUser(userId: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount;
}

/**
 * Cleanup cron — delete rows whose `expires_at` is older than 7 days.
 * The 7-day lag keeps a short audit trail for debugging refresh issues
 * after the token itself stopped being usable.
 *
 * Returns the number of rows deleted (useful in logs and tests).
 */
export async function cleanupExpired(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - interval '7 days'`,
  );
  return rowCount;
}
