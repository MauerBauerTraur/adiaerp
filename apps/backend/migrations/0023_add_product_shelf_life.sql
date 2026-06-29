-- =============================================================================
-- 0023 — Add `products.shelf_life_days` for aging / expiry alerts (sub-task #5)
-- =============================================================================
-- Half-finished goods sitting in a `sex_storage` (Tort skladi / Yarim Fabrika
-- skladi / Perojniy skladi) spoil within a handful of days. The dashboard
-- must surface aging stock so the supply chief uses it before it goes off.
--
-- DESIGN:
--   * `shelf_life_days` is a NULLABLE positive integer.
--     NULL  -> the product has no expiry (raw materials: flour, sugar, oil).
--     N >0  -> the product spoils after N days in storage.
--   * The aging signal is derived from the most recent `production_output`
--     stock_movement landing the product into the sex skladi. Computed at
--     read time (see `GET /api/dashboard/aging-alerts`); no extra column.
--   * Default values for the common semi-finished products are NOT seeded
--     here (this migration is data-safe); the owner / a follow-up data
--     migration can populate `shelf_life_days` per product in production.
--
-- INVARIANT:
--   * `shelf_life_days >= 1` when set (zero would mean "expired immediately"
--     which has no business meaning).
--
-- IDEMPOTENT:
--   * `ADD COLUMN IF NOT EXISTS` lets the migration run twice without error.
-- =============================================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER NULL;

ALTER TABLE products
    DROP CONSTRAINT IF EXISTS chk_products_shelf_life_positive;
ALTER TABLE products
    ADD CONSTRAINT chk_products_shelf_life_positive
        CHECK (shelf_life_days IS NULL OR shelf_life_days >= 1);

COMMENT ON COLUMN products.shelf_life_days IS
    'Days the product stays usable after production. NULL = no expiry (raw '
    'materials). Drives the GET /api/dashboard/aging-alerts feed for sex skladi.';
