-- =============================================================================
-- 0040 — products: add batch_yield for semi-finished (prepack) recipe context.
-- =============================================================================
-- Poster prepacks have an `out` field (grams of output per batch). Storing
-- the normalised yield (kg) allows the frontend to display recipe quantities
-- in the same batch format Poster uses, instead of the per-unit normalised form.
--
-- DEFAULT 1 keeps all existing rows valid (1 kg batch = quantities are
-- already the per-unit values, unchanged).
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS batch_yield NUMERIC(14,4) NOT NULL DEFAULT 1
    CHECK (batch_yield > 0);

COMMENT ON COLUMN products.batch_yield IS
  'Batch output in the product''s own unit (kg for semi-finished). '
  'Populated from Poster prepack `out` field (normalised to kg). '
  'Used to display recipe quantities in Poster-matching batch format.';
