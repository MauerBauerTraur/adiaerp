-- =============================================================================
-- EPIC 3.2 — Telegram self-link tokens.
-- =============================================================================
-- "Foydalanuvchi + Hodim" birlashtirilgan: ADIA'da `employees` jadval yo'q —
-- hodim = foydalanuvchi (`users`). Bu migration faqat TG SELF-LINK oqimini
-- qo'shadi (additive, destruktiv emas, idempotent):
--
--   1. Admin (yoki foydalanuvchining o'zi) bir martalik link token oladi.
--   2. Hodim Telegram bot'da `/start <token>` yuboradi.
--   3. Bot token'ni tekshiradi va o'sha userning `users.telegram_id` sini
--      bog'laydi.
--
-- Token bir martalik (consumed_at), muddatli (expires_at) va auditlanadi.
-- `users.telegram_id` ustuni (0001_init) o'zgarmaydi — bu jadval faqat
-- bog'lash jarayonini boshqaradi.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_telegram_link_tokens (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The opaque single-use token the user pastes after `/start`. Stored as a
    -- SHA-256 hex digest (never the raw token) so a DB leak does not expose
    -- usable link tokens — mirrors the refresh-token hashing discipline.
    token_hash      TEXT        NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    -- Set once the token is redeemed via `/start`; a consumed token is dead.
    consumed_at     TIMESTAMPTZ,
    -- The Telegram numeric id the token bound (audit trail of who linked).
    consumed_by_telegram_id BIGINT,
    -- Who requested the token (admin on behalf of a user, or the user itself).
    created_by_user_id BIGINT   REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One token maps to exactly one hash; the lookup on redemption is by hash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_tg_link_token_hash
    ON user_telegram_link_tokens(token_hash);

-- Fast "is there a live token for this user?" + housekeeping of expired rows.
CREATE INDEX IF NOT EXISTS ix_user_tg_link_token_user
    ON user_telegram_link_tokens(user_id, consumed_at, expires_at);

COMMENT ON TABLE user_telegram_link_tokens IS
    'EPIC 3.2 — single-use, expiring tokens for Telegram self-link. A user '
    'redeems one via the bot `/start <token>` command to bind users.telegram_id.';
