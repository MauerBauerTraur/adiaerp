-- =============================================================================
-- 0010_telegram_callbacks.sql — F3.3 / ADR-0011: Telegram inline callback
-- actions. Turns the previously outbound-only bot into a two-way control
-- surface (managers tap "Tasdiqlash" / "Boshladim" / "Tezda bajarish" right
-- inside Telegram).
--
-- Two schema changes:
--
--   1. `notifications.inline_callback JSONB` — the per-row inline keyboard
--      payload. Format (kept compatible with Grammy's
--      `InlineKeyboardMarkup`):
--
--          {
--            "buttons": [
--              [ { "text": "Tasdiqlash", "data": "apprv:po:7" },
--                { "text": "Rad etish",  "data": "rej:po:7"  } ],
--              [ { "text": "Ko'rish",    "data": "view:po:7" } ]
--            ]
--          }
--
--      The outbox worker translates this into Telegram's
--      `reply_markup.inline_keyboard` shape; NULL or {"buttons":[]} means
--      the message is sent without a keyboard (legacy behaviour).
--      Backwards compatible — existing rows keep NULL and behave as before.
--
--   2. `telegram_callback_actions` — one audit row per callback_query the
--      bot receives. `update_id` is UNIQUE so a Telegram retry can never
--      execute the same action twice (idempotency, ADR-0011 §6).
--      Spoofing / RBAC rejections are recorded too (forensic trail).
-- =============================================================================

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS inline_callback JSONB;

-- Distinguish every possible outcome of a callback dispatch. Kept as an
-- ENUM so the audit trail is queryable (`WHERE status='rejected_rbac'`)
-- and so application code can't accidentally invent a new status string.
-- The IF NOT EXISTS check must be scoped to the CURRENT schema, otherwise
-- a parallel test schema's matching type makes this DO block skip the
-- CREATE TYPE — which then breaks the CREATE TABLE below because the type
-- does NOT exist in the current schema. `pg_type` is global; filtering by
-- `typnamespace = pg_my_temp_schema()::oid OR ... = ANY(current_schemas())`
-- is verbose. Simpler: join pg_namespace and match the connection's
-- current_schema().
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'telegram_callback_status'
           AND n.nspname = current_schema()
    ) THEN
        CREATE TYPE telegram_callback_status AS ENUM (
            'processed',              -- domain action executed successfully
            'rejected_unauthorized',  -- ctx.from.id does not match any active user
            'rejected_rbac',          -- user found, but role/scope forbids the verb
            'failed',                 -- domain service threw — captured in error_detail
            'duplicate'               -- update_id already on file (Telegram retry)
        );
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS telegram_callback_actions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Telegram-assigned update id. UNIQUE so the bot can safely re-handle a
    -- delivery without double-running the action (Telegram retries on
    -- 5xx / timeout).
    update_id           BIGINT      NOT NULL UNIQUE,
    -- callback_query.id — the short token the bot must echo on
    -- `answerCallbackQuery`. Kept for forensic correlation only.
    callback_query_id   TEXT        NOT NULL,
    -- Always known: the Telegram numeric user id that pressed the button.
    -- We store it BEFORE the user lookup so unauthorized presses are still
    -- attributable (ADR-0011 §6).
    from_telegram_id    BIGINT      NOT NULL,
    -- Resolved ADIA user id (NULL when the Telegram user is unknown / inactive).
    user_id             BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    -- Raw callback payload — "verb:entity:id". 64 byte max enforced upstream
    -- by Telegram's `callback_data` length limit.
    callback_data       TEXT        NOT NULL,
    status              telegram_callback_status NOT NULL,
    -- Structured outcome (e.g. {"purchase_order_id":7,"new_status":"approved"}).
    result              JSONB,
    -- Truncated error reason for `failed` rows.
    error_detail        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forensic / abuse-investigation queries: "every callback from telegram user
-- X in the last 24h" — most common scan, so it gets an index.
CREATE INDEX IF NOT EXISTS ix_telegram_callback_from
    ON telegram_callback_actions(from_telegram_id, created_at DESC);
