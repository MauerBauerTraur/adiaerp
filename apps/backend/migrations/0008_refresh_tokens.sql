-- =============================================================================
-- 0008_refresh_tokens.sql — Phase-2 Sprint 3 / F2.3 cleanup (ADR-0005).
--
-- Splits authentication into a short-lived access token (1 hour, JWT) and a
-- long-lived refresh token (30 days, opaque random 32-byte hex, server-side
-- revocable). Replaces the previous "single 12-hour JWT" policy flagged by
-- the Sprint 1+2 security audit as too long-lived (loss of a token = ~12h
-- of attacker access, no server-side revocation).
--
-- Design choices:
--   * The refresh token itself is NEVER stored — only its SHA-256 hex hash.
--     SHA-256 is sufficient (the raw token is 256 bits of CSPRNG entropy);
--     bcrypt is overkill and would slow refresh latency for no gain.
--   * `rotated_to` forms an audit chain — every successful refresh
--     atomically revokes the current row and inserts the next, with the
--     previous row pointing at the new id. A reused (already-rotated) token
--     can therefore be detected and the whole chain revoked if needed.
--   * The partial unique index on (user_id) WHERE revoked_at IS NULL is NOT
--     applied — a user can have multiple active refresh tokens (different
--     browsers, mobile + desktop). The lookup index keys on token_hash
--     (already UNIQUE) for validation.
--   * `cleanupExpired` cron deletes rows older than (expires_at + 7d) — the
--     7-day lag preserves a short audit trail for debugging refresh issues
--     after the token itself is unusable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 hex of the raw token. The raw token is returned ONCE on
    -- issue and never stored. Verification recomputes the hash and looks
    -- the row up by this column.
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    -- Audit chain — set on rotation: the row this token was rotated into.
    rotated_to  BIGINT REFERENCES refresh_tokens(id),
    -- Free-form user agent string (optional, taken from the request).
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Active tokens for a user" lookup (logout-all, session listing). The
-- partial WHERE clause keeps the index small — revoked rows are not
-- relevant to liveness queries.
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user_active
    ON refresh_tokens(user_id, expires_at)
    WHERE revoked_at IS NULL;
