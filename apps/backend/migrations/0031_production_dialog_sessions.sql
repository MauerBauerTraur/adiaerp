-- =============================================================================
-- 0031 — production_dialog_sessions (channel-agnostic AI dialog state machine).
-- =============================================================================
-- ADR-0016 §3 — when a finished-cake order is raised, the AI asks the sex user
-- "Nta buyurtma, M zagatovka bor — tayyordan yoki 0dan?" (and, after that,
-- "krem kam — tayyorlash yoki ombordan?"). The QUESTION + the chosen ANSWER
-- live here as a single source of truth; the web modal and the Telegram bot are
-- both thin render/answer layers over this table (Q5 — owner: web + telegram).
--
-- States (ADR-0016 §3.3):
--   AWAITING_SOURCE_DECISION — Q1: tayyordan vs 0dan (zagatovka source).
--   AWAITING_CREAM_CONFIRM   — Q2: krem kam — tayyorlash vs ombordan.
--   RESOLVED   — user answered everything; requests/sub-orders were created.
--   EXPIRED    — expires_at passed; the cron stamps this + escalates to PM.
--   CANCELLED  — sex user / pm cancelled the dialog.
--
-- `context` / `decision` are JSONB because the dialog payload is light and
-- evolving (zagatovka_have/need, options, the user's choices) — a rigid column
-- set would churn. `decision` is the full audit of what the user chose.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS. No data deleted.
-- =============================================================================

CREATE TABLE IF NOT EXISTS production_dialog_sessions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  replenishment_id    BIGINT REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  production_order_id BIGINT REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id          BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id         BIGINT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  assigned_user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  state               TEXT NOT NULL
                        CHECK (state IN (
                          'AWAITING_SOURCE_DECISION',
                          'AWAITING_CREAM_CONFIRM',
                          'RESOLVED',
                          'EXPIRED',
                          'CANCELLED'
                        )),
  qty_ordered         NUMERIC(14,4) NOT NULL CHECK (qty_ordered > 0),
  context             JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision            JSONB,
  created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '6 hours'
);

COMMENT ON TABLE production_dialog_sessions IS
  'ADR-0016 — channel-agnostic AI production dialog. Web modal + Telegram bot '
  'both read questions / write answers here; backend is the single state owner.';

-- Open dialogs scoped to the assigned user — the GET /api/production/dialog
-- list query and the cron expiry scan both filter on (assigned_user_id, state).
CREATE INDEX IF NOT EXISTS ix_pds_open
  ON production_dialog_sessions(assigned_user_id, state)
  WHERE state IN ('AWAITING_SOURCE_DECISION', 'AWAITING_CREAM_CONFIRM');

-- The expiry cron scans open dialogs whose expires_at has passed.
CREATE INDEX IF NOT EXISTS ix_pds_expiry
  ON production_dialog_sessions(expires_at)
  WHERE state IN ('AWAITING_SOURCE_DECISION', 'AWAITING_CREAM_CONFIRM');
