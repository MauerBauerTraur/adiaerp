-- 0052: Poster product modifications — weight-based sale variants
-- Stores brutto weight of each modifier so sales can be recorded
-- as fractional product units (e.g. КУСОК 55.55g / ЦЕЛЫЙ 1000g = 0.0556 pcs).
-- Populated by syncModifications() which calls menu.getProduct for type=3 products.

CREATE TABLE IF NOT EXISTS poster_product_modifications (
  modification_id   BIGINT PRIMARY KEY,
  poster_product_id BIGINT NOT NULL,
  product_id        BIGINT REFERENCES products(id) ON DELETE SET NULL,
  name              TEXT   NOT NULL DEFAULT '',
  weight_g          NUMERIC(10, 4),
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ppm_poster_product_id
  ON poster_product_modifications (poster_product_id);

-- modification_id on sales for auditability (nullable — most products have no modifications)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS modification_id BIGINT;
