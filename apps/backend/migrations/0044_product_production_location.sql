-- Each semi-finished / finished product can be assigned to the sex (location)
-- responsible for producing it. Used by the production order form to auto-fill
-- the production location, and by sub-order routing instead of the global
-- zagatovka fallback.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS production_location_id bigint
  REFERENCES locations(id) ON DELETE SET NULL;
