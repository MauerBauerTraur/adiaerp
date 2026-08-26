-- 0059: Align the recipe_stage enum with the vocabulary the application writes.
--
-- 0029 created:  recipe_stage AS ENUM ('base', 'decoration', 'assembly')
-- but the app writes 'dough' | 'cream' | 'decoration' | 'other'
-- (routes/products.ts VALID_STAGES, services/nakladnoy.ts RecipeStage) and
-- defaults a line with no explicit stage to 'other'.
--
-- Only 'decoration' overlaps, so PUT /api/products/:id/recipe failed with
--   invalid input value for enum recipe_stage: "other"
-- and because the write runs in one transaction the whole recipe save rolled
-- back — recipes could not be edited in production at all.
--
-- Additive only: existing 'base' / 'assembly' rows keep their value, so this is
-- safe on a live database and needs no backfill. ALTER TYPE ... ADD VALUE runs
-- inside a transaction on PostgreSQL 12+ (prod is 14.23) as long as the new
-- label is not used in the same transaction, which is the case here.

ALTER TYPE recipe_stage ADD VALUE IF NOT EXISTS 'dough';
ALTER TYPE recipe_stage ADD VALUE IF NOT EXISTS 'cream';
ALTER TYPE recipe_stage ADD VALUE IF NOT EXISTS 'other';
