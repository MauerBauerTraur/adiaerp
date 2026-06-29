-- 0036 — recipe uniqueness must include `stage`.
--
-- Bug (found by e2e SCENARIO 5a): `uq_recipe_component` was
-- UNIQUE (product_id, component_product_id), so a raw material could appear
-- only ONCE per finished product. But EPIC 8.4 (sectioned nakladnoy) and
-- EPIC 5 (base/decoration stages) require the SAME raw (e.g. flour, sugar) to
-- appear in BOTH the `base` (hamir) and `decoration` (krem) stage of one
-- product — the ITOGO line then sums that raw across sections. The old
-- constraint blocked that with a duplicate-key error.
--
-- Fix: re-key uniqueness on (product_id, component_product_id, stage). This
-- still forbids a true duplicate (same component twice in the SAME stage) while
-- allowing one component across different stages. Idempotent + non-destructive
-- (no row is deleted; only the constraint definition changes).

DO $$
BEGIN
  -- Drop the old (stage-less) unique constraint if it is still the 2-column one.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_recipe_component'
       AND pg_get_constraintdef(oid) = 'UNIQUE (product_id, component_product_id)'
  ) THEN
    ALTER TABLE recipes DROP CONSTRAINT uq_recipe_component;
  END IF;

  -- Add the stage-aware unique constraint if it is not present yet.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_recipe_component_stage'
  ) THEN
    ALTER TABLE recipes
      ADD CONSTRAINT uq_recipe_component_stage
      UNIQUE (product_id, component_product_id, stage);
  END IF;
END $$;
