-- 0051: Add production_cost column to products
-- Stores the manual manufacturing cost per unit (so'm).
-- Separate from cost_price (raw material / Poster sync) and sell_price (sale price).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS production_cost NUMERIC(14,2);
