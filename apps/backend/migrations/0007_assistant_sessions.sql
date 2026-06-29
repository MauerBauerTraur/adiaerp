-- =============================================================================
-- 0007_assistant_sessions.sql — Phase-2 F2.2 (AI assistant)
-- =============================================================================
-- Stores Vertex AI assistant chat sessions and per-turn messages so that
-- (a) multi-turn conversations resume by `session_id`, and
-- (b) every model request / response / tool call is durable and auditable.
--
-- Design choices (spec §7.4 / ADR-0006 §4):
--   * BIGINT identity PKs — consistent with the rest of the schema (users,
--     stock_movements, …). The session id is exposed in API responses but
--     not a security token (RBAC is enforced server-side on every read).
--   * `assistant_messages.role` is an ENUM — only three roles exist in the
--     Gemini function-calling model: the human user, the assistant reply,
--     and the tool execution record. Anything else is a bug.
--   * `tool_calls` (assistant rows) captures the ordered list of function
--     calls the model emitted on that turn, for UI display and audit.
--   * `tool_name` / `tool_payload` / `tool_result` populated only when
--     `role='tool'` — they describe one executed tool round-trip.
-- =============================================================================

CREATE TABLE assistant_sessions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Short auto-summary derived from the first user message (UI sidebar).
    title       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One user's sessions, freshest first — drives the chat history sidebar.
CREATE INDEX ix_assistant_sessions_user
    ON assistant_sessions (user_id, updated_at DESC);

CREATE TYPE assistant_message_role AS ENUM ('user', 'assistant', 'tool');

CREATE TABLE assistant_messages (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id    BIGINT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    role          assistant_message_role NOT NULL,
    -- Free-text content. For 'user' it is the question; for 'assistant' the
    -- final reply; for 'tool' a short human label ("get_stock executed").
    content       TEXT NOT NULL,
    -- Assistant turns only: ordered summary of the tool calls the model made
    -- (each item shaped { name, args, ok }). NULL for user/tool rows.
    tool_calls    JSONB,
    -- Tool rows only: which tool was executed, with arguments + raw result
    -- so we can replay and audit later.
    tool_name     TEXT,
    tool_payload  JSONB,
    tool_result   JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay a session in turn order; also drives the GET /sessions/:id response.
CREATE INDEX ix_assistant_messages_session
    ON assistant_messages (session_id, created_at);
