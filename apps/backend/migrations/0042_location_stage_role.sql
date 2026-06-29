-- 0042_location_stage_role.sql
-- Marks specific locations as designated for a production stage:
--   'final'    → where finished products are made (ishlab chiqarish sexi)
--   'zagatovka' → where semi-finished / prep products are made (zagatovka sexi)
-- Used to auto-route zagatovka sub-orders to the correct sex when a
-- production order is created.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS stage_role TEXT
    CHECK (stage_role IN ('final', 'zagatovka'));
