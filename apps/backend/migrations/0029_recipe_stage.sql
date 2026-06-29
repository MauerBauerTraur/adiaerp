-- =============================================================================
-- 0029 — recipes.stage (BOM section): base / decoration / assembly.
-- =============================================================================
-- ADR-0016 §2.2 — the zagatovka -> ukrasheniye production flow needs the BOM
-- split into stages so a finished cake's recipe can be evaluated in two passes:
--
--   * 'base'       — hamir/asos (un, biskvit, shakar) — makes the zagatovka
--                    (the 70%-done cake parked in sex_storage).
--   * 'decoration' — ukrasheniye (krem, bezak, dekor) + the zagatovka (semi)
--                    component itself — turns a zagatovka into the finished cake.
--   * 'assembly'   — yig'ish/pishirish (somsa: bake, add filling). Optional;
--                    MVP uses base + decoration only.
--
-- WHY 'base' DEFAULT — every existing recipe row (synced flat from Poster, which
-- has no stage concept) keeps working unchanged: a recipe that is entirely
-- 'base' behaves exactly like the old single-pass flow (consumeBomAndProduce
-- reads every line). Splitting a cake into base/decoration is a later,
-- per-recipe curation step (EPIC 1.3/1.5) — it does not break anything that
-- exists today.
--
-- IDEMPOTENT: the enum is created only when missing; the column add uses
-- IF NOT EXISTS. No data is deleted or rewritten — purely additive.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recipe_stage') THEN
    CREATE TYPE recipe_stage AS ENUM ('base', 'decoration', 'assembly');
  END IF;
END$$;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS stage recipe_stage NOT NULL DEFAULT 'base';

COMMENT ON COLUMN recipes.stage IS
  'ADR-0016 — BOM section: base (hamir/zagatovka), decoration (ukrasheniye: '
  'krem+bezak + the semi zagatovka component), assembly (optional bake/fill). '
  'Default base keeps Poster-synced flat recipes behaving like the old flow.';

-- The production-input checks filter by (product_id, stage), so an index on the
-- pair keeps the per-stage BOM read a single index scan.
CREATE INDEX IF NOT EXISTS ix_recipes_product_stage ON recipes(product_id, stage);
