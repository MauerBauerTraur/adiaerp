-- Each product can have a designated storage location (where stock is kept after
-- production or purchase), and optional min/max stock thresholds for alerting.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS storage_location_id bigint REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS min_qty             numeric CHECK (min_qty >= 0),
  ADD COLUMN IF NOT EXISTS max_qty             numeric CHECK (max_qty >= 0);
