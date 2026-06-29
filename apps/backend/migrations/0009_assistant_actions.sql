-- =============================================================================
-- 0009_assistant_actions.sql — Faza-3 F3.2 (AI write actions, two-phase commit)
-- =============================================================================
-- Stores the *intent* of every AI write tool call so the user can confirm or
-- reject it before the server touches real domain tables. The model never
-- mutates anything directly — it inserts a `pending` row here, the UI calls
-- `/confirm`, and only then does the executor run for real.
--
-- Design choices (ADR-0009):
--   * BIGINT identity PK — consistent with the rest of the schema.
--   * `status` is an ENUM; legal transitions are `pending` → one of
--     `executed | rejected | expired | superseded`. The application enforces
--     the transition with an atomic `UPDATE … WHERE status = 'pending'`,
--     which gives us a SQL-level idempotency guarantee.
--   * `expires_at` lives on the row (created_at + 5 minutes by default) so
--     the expire cron is a single sweep `UPDATE … WHERE expires_at < now()`.
--   * The partial index on `(session_id, status) WHERE status='pending'`
--     keeps the supersede-on-new-pending probe O(1).
--   * `caused_by_message_id` links the action back to the assistant message
--     that requested it (forensic trail: which model turn produced this).
-- =============================================================================

CREATE TYPE assistant_action_status AS ENUM (
  'pending',
  'executed',
  'rejected',
  'expired',
  'superseded'
);

CREATE TABLE assistant_actions (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id            BIGINT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Write tool name, e.g. 'transfer_stock'. Free text on purpose — the
  -- registry validates the value at execute time; we don't pin it with a
  -- FK to a tools table.
  tool_name             TEXT NOT NULL,
  -- The exact arguments the model proposed. Validated again at confirm time
  -- (canExecute) before the executor runs.
  args                  JSONB NOT NULL,
  -- The short Uzbek summary shown to the user in the confirm dialog.
  summary               TEXT NOT NULL,
  status                assistant_action_status NOT NULL DEFAULT 'pending',
  caused_by_message_id  BIGINT REFERENCES assistant_messages(id) ON DELETE SET NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  confirmed_at          TIMESTAMPTZ,
  executed_at           TIMESTAMPTZ,
  -- Whatever the executor returned (e.g. `{movement_id: 42}`) or
  -- `{error: "..."}` if it raised after status flipped.
  result                JSONB,
  error_detail          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One pending row per session at most — the supersede invariant probes this
-- index. Partial so non-pending rows don't bloat it.
CREATE INDEX ix_assistant_actions_session_pending
  ON assistant_actions (session_id, status)
  WHERE status = 'pending';

-- The "my recent actions" list endpoint.
CREATE INDEX ix_assistant_actions_user_recent
  ON assistant_actions (user_id, created_at DESC);

-- Lets the expire cron run a fast `WHERE status='pending' AND expires_at<now()`.
CREATE INDEX ix_assistant_actions_pending_expiry
  ON assistant_actions (expires_at)
  WHERE status = 'pending';
