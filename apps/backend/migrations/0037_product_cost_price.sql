-- Add cost_price column to products table.
-- For raw materials: populated from Poster prime_cost during stock leftover sync.
-- For semi/finished products: displayed as calculated BOM total on the frontend.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(14,4);
