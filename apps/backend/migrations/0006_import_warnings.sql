-- =============================================================================
-- 0006_import_warnings.sql — Phase-2 F2.3 (Poster sync warnings table).
--
-- The Poster seed/sync flow already collects per-item failures in memory
-- (`failedItems` in seedSync.ts) and writes the summary line to
-- `poster_sync_log.error_detail`. That makes the LOG visible to PM, but the
-- per-item detail (which ingredient/recipe failed, with which SQLSTATE) is
-- buried in the server log.
--
-- This migration introduces `import_warnings` — one row per per-item anomaly
-- (unit mismatch, missing component, BOM impossible, leftover for an
-- unknown product, ...). Future Phase-2 work writes a row here from every
-- catch block in seedSync.ts / stockSync.ts.
--
-- The recalc cron (F2.1) also writes here at `severity='info'` ("no sales
-- history — skip") and `severity='warning'` ("would zero out min/max,
-- preserved old values") so the PM dashboard has a single feed of
-- self-correcting anomalies.
--
-- A partial index keeps the "unresolved warnings" feed cheap; a second
-- index supports the `source=` filter on the admin endpoint.
-- =============================================================================

CREATE TABLE IF NOT EXISTS import_warnings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source      TEXT NOT NULL,                          -- 'poster.bom', 'poster.leftovers', 'minmax.recalc', ...
    entity      TEXT,                                   -- 'product:123', 'storage:5', 'stock:7:42', ...
    severity    TEXT NOT NULL DEFAULT 'warning'
                CHECK (severity IN ('info','warning','error')),
    message     TEXT NOT NULL,
    payload     JSONB,
    resolved    BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_import_warnings_unresolved
    ON import_warnings(created_at DESC)
    WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS ix_import_warnings_source
    ON import_warnings(source, created_at DESC);
