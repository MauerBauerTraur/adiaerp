-- =============================================================================
-- 0002_notifications_retry.sql — Telegram outbox retry support (M9, spec §2.9).
--
-- Adds the columns the `telegramOutbox` worker needs to retry Grammy
-- `sendMessage` failures without spinning forever:
--   * `telegram_send_attempts` — incremented on every send failure;
--   * `error_detail`           — the most recent send-failure reason (capped
--                                in app code to 500 chars). Once attempts
--                                reach the worker's limit (5) the row is
--                                skipped on subsequent cycles.
--
-- Also adds an optional `dedupe_key` for `stock_below_min`-style debounce
-- (one Telegram message per (product, location) per 24h, spec §2.9 / §7).
-- A partial UNIQUE INDEX over a 24-hour window is impractical in PostgreSQL,
-- so the application checks for an existing row with the same `dedupe_key`
-- created within the window; the index keeps the lookup fast.
--
-- Backwards compatible: every column has a default or is nullable, so the
-- existing `notifications` rows continue to work.
-- =============================================================================

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS telegram_send_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS error_detail           TEXT,
    ADD COLUMN IF NOT EXISTS dedupe_key             TEXT;

-- Fast lookup for the 24h debounce check (`type='stock_below_min'` etc.).
CREATE INDEX IF NOT EXISTS ix_notifications_dedupe
    ON notifications(dedupe_key, created_at DESC)
    WHERE dedupe_key IS NOT NULL;
