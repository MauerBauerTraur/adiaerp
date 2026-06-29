-- =============================================================================
-- 0011_forecasts.sql — Faza-3 Sprint 4 (F3.4, ADR-0010).
--
-- One-row-per-(location, product) cache for the Prophet sidecar output. The
-- nightly cron (`forecastRefreshCron.ts`, 04:30 UTC) batches sales series to
-- the sidecar and upserts the response here. Reads come from the `GET
-- /api/forecasts` route, the AI `get_forecast` tool, and the dashboard
-- "stockout list" widget — none of those touch the sidecar at request time.
--
-- Schema notes:
--   * Composite PK (location_id, product_id) — one forecast per pair; new
--     runs overwrite the previous output. This matches ADR-0010 §"Cache
--     strategiyasi" (TTL 24h, single row per pair).
--   * `daily_predictions` JSONB — array of `{date, yhat, yhat_lower,
--     yhat_upper}`. JSON keeps the shape flexible (Prophet may grow extra
--     fields like trend components in Faza-4 without a schema migration).
--   * `expected_stockout_date` is NULL when the item is forecast safe for
--     the next 30 days; the partial index makes the "tez tugaydigan
--     tovarlar" dashboard widget O(log N).
--   * `source` defaults to 'prophet' so a future Faza-4 alternative engine
--     (e.g. moving_average fallback) can coexist in the same table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecasts (
    location_id            BIGINT      NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    product_id             BIGINT      NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    daily_predictions      JSONB       NOT NULL,
    expected_stockout_date DATE,
    generated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    source                 TEXT        NOT NULL DEFAULT 'prophet',
    PRIMARY KEY (location_id, product_id)
);

COMMENT ON TABLE  forecasts IS
    'Per-(location, product) sales forecast cache populated by '
    'forecastRefreshCron (ADR-0010). One row per pair; nightly overwrite.';

COMMENT ON COLUMN forecasts.daily_predictions IS
    'JSON array of {date, yhat, yhat_lower, yhat_upper}. Up to 30 entries.';

COMMENT ON COLUMN forecasts.expected_stockout_date IS
    'NULL when current_qty will not run out within the forecast horizon.';

-- Dashboard "soon to stock out" widget reads ORDER BY expected_stockout_date
-- ASC LIMIT 10. A partial index keeps it tiny — only non-null rows.
CREATE INDEX IF NOT EXISTS ix_forecasts_stockout
    ON forecasts(expected_stockout_date)
    WHERE expected_stockout_date IS NOT NULL;
