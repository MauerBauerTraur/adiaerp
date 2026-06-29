-- =============================================================================
-- 0003_dynamic_minmax.sql — Phase-2 F2.1 (dynamic min/max engine support).
--
-- The base schema (0001_init.sql) already carries the columns the engine
-- needs:
--   * locations.lead_time_days, review_days, safety_factor — formula inputs
--   * stock.minmax_mode CHECK IN ('manual','dynamic')      — per-row toggle
--   * sales_stats_daily (location_id, product_id, stat_date) + avg_7d/avg_30d
--
-- This migration adds two operational aids the nightly cron benefits from:
--
--   1. A descending index on `sales_stats_daily` keyed by
--      `(location_id, product_id, stat_date DESC)`. The recalc worker reads
--      the *latest* row per (location, product) — the existing PK is good
--      for point lookups but a DESC index is the natural pick for
--      `ORDER BY stat_date DESC LIMIT 1`. Idempotent (IF NOT EXISTS).
--
--   2. A nullable `stock.last_recalc_at` column. The cron sets it on every
--      pass — even on skip (no sales history) — so the PM dashboard can show
--      "last recalc N hours ago" without scanning audit_log. Defaults to
--      NULL so existing rows remain untouched until the first cron pass.
--
-- Both changes are non-breaking and idempotent.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_sales_stats_recent
    ON sales_stats_daily(location_id, product_id, stat_date DESC);

ALTER TABLE stock
    ADD COLUMN IF NOT EXISTS last_recalc_at TIMESTAMPTZ;
COMMENT ON COLUMN stock.last_recalc_at IS
    'Timestamp of the most recent dynamic min/max recalc pass — set by '
    'minmaxRecalcCron whether or not the row was updated, so dashboards can '
    'distinguish "never recalculated" from "recalculated but unchanged".';
