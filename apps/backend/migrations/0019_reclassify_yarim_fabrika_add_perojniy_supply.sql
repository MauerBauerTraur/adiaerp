-- =============================================================================
-- Reclassify "Yarim Fabrika sexi" as a supply layer and add the missing
-- "Ta'minot — Perojniy" supply node.
-- =============================================================================
-- Owner clarification (2026-05-26): the chain has THREE supply departments:
--   1. Ta'minot — Tort
--   2. Ta'minot — Perojniy
--   3. Ta'minot — Yarim Fabrika  (a fridge/warehouse, NOT a production shop)
--
-- Migration 0016 seeded "Yarim Fabrika sexi" as a `production` sub-department
-- alongside "Tort sexi" and "Perojniy sexi". The domain truth is that Yarim
-- Fabrika is a supply/storage layer (semi-finished goods cold storage), and
-- there is no "Ta'minot — Perojniy" supply node at all.
--
-- This migration:
--   * Reclassifies the existing "Yarim Fabrika sexi" row (type=production)
--     into "Ta'minot — Yarim Fabrika" (type=supply), preserving its id so that
--     any existing stock/users/audit references stay intact.
--   * Inserts a new "Ta'minot — Perojniy" (type=supply) row.
--
-- Parent strategy: both supply nodes are parented to the production root
-- ("Ishlab chiqarish sexi"). The chain hierarchy lookup is a reference graph,
-- not a strict 1:1 flow constraint — parent_id is `ON DELETE RESTRICT` and
-- only used by the dashboard tree.
--
-- Idempotent: re-running this migration is a no-op:
--   * the UPDATE matches the legacy (name, type='production') tuple and only
--     flips it while it is still present in that form;
--   * the INSERT is gated by NOT EXISTS on the supply-typed target name.
-- =============================================================================

DO $$
DECLARE
    prod_root_id  BIGINT;
BEGIN
    SELECT id INTO prod_root_id
      FROM locations
     WHERE type = 'production'
       AND name = 'Ishlab chiqarish sexi'
     ORDER BY id
     LIMIT 1;

    IF prod_root_id IS NULL THEN
        RAISE NOTICE 'reclassify-yarim-fabrika: production root not found, skipping.';
        RETURN;
    END IF;

    UPDATE locations
       SET type       = 'supply',
           name       = 'Ta''minot — Yarim Fabrika',
           parent_id  = prod_root_id,
           updated_at = now()
     WHERE type = 'production'
       AND name = 'Yarim Fabrika sexi';

    IF NOT EXISTS (
        SELECT 1
          FROM locations
         WHERE type = 'supply'
           AND name = 'Ta''minot — Perojniy'
    ) THEN
        INSERT INTO locations (name, type, parent_id)
        VALUES ('Ta''minot — Perojniy', 'supply', prod_root_id);
    END IF;
END$$;
