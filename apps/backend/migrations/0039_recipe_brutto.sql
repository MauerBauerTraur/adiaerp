-- =============================================================================
-- 0039 — recipes: add brutto column for gross weight before waste/loss.
-- =============================================================================
-- Poster POS stores brutto (gross input weight) and netto (net weight after
-- processing) separately. Our `qty_per_unit` maps to netto; `brutto` is the
-- raw input before cooking/processing loss.
--
-- DEFAULT 0 keeps all existing rows valid; the UI shows brutto = 0 as "—".
-- =============================================================================

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS brutto NUMERIC(14,4) NOT NULL DEFAULT 0
    CHECK (brutto >= 0);

COMMENT ON COLUMN recipes.brutto IS
  'Gross weight of component before processing/cooking loss (Poster: Брутто). '
  '0 = not set. qty_per_unit is the net consumed quantity (Poster: Нетто).';
