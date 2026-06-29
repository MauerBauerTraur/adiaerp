-- When recipe_locked = TRUE, the Poster sync skips replacing the recipe for
-- this product. Set automatically when a recipe is manually edited via the API.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS recipe_locked boolean NOT NULL DEFAULT FALSE;
