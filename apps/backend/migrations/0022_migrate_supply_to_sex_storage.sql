-- =============================================================================
-- 0022 — Migrate `supply` locations to `sex_storage` + recreate Yarim Fabrika
--        production sex.
-- =============================================================================
-- Owner-approved 2026-05-28 (D7). Three live locations are flipped from the
-- legacy `supply` type to the new `sex_storage` type added by 0021. Names and
-- parent pointers are updated so each sex skladi is parented to its sex floor.
--
--   id  | old name                     | old type | new name              | new type
--   ----+------------------------------+----------+-----------------------+-------------
--   3   | Ta'minot — Tort              | supply   | Tort skladi           | sex_storage
--   38  | Ta'minot — Yarim Fabrika     | supply   | Yarim Fabrika skladi  | sex_storage
--   39  | Ta'minot — Perojniy          | supply   | Perojniy skladi       | sex_storage
--
-- Parent pointers move from the old `Ishlab chiqarish sexi` root to the sex
-- floor that owns the buffer (Tort sexi / Perojniy sexi / Yarim Fabrika sexi).
-- The migration also RECREATES `Yarim Fabrika sexi` (production) — migration
-- 0019 had reclassified that row into the supply layer (a mistake D7 fixes).
--
-- DATA SAFETY:
--   * Only `locations.name`, `locations.type`, `locations.parent_id` rotate.
--   * `stock`, `stock_movements`, `replenishment_requests`, `production_orders`,
--     `user_locations`, `audit_log` references are keyed on `location_id` — the
--     ids are PRESERVED across this migration so every historical FK stays
--     intact. No row in those tables is touched here.
--   * The Markaziy Sklad (`central_warehouse`) still points to the Tort skladi
--     row via its `parent_id` — that parent edge is unchanged (id=3 is just
--     renamed).
--   * `supply_manager` users keep their `users.location_id` and the matching
--     `user_locations` mapping; the role becomes a SYNONYM for "the manager
--     of a sex_storage location" (see ADR-0015 §4).
--
-- IDEMPOTENT:
--   * Each `UPDATE` is gated on `type = 'supply'` — a second run finds nothing
--     to flip (the rows are now `sex_storage`) and the WHERE clause fails.
--   * The Yarim Fabrika sexi `INSERT` is guarded by `NOT EXISTS` on the
--     (name, type='production') tuple.
--
-- Idempotency caveat: if the "Tort sexi" / "Perojniy sexi" / "Yarim Fabrika
-- sexi" production rows are missing at run time the `parent_id` sub-SELECT
-- yields NULL — which is allowed by the schema. A later cleanup migration
-- (or the operator) can re-link the parents once the sex rows exist.
-- =============================================================================

-- 1. Recreate `Yarim Fabrika sexi` (production) — migration 0019 had folded it
--    into the supply layer; D7 reverts that. Parented to the legacy
--    "Ishlab chiqarish sexi" root so the production-layer dashboard query
--    still finds it.
INSERT INTO locations (name, type, parent_id, poster_storage_id)
SELECT 'Yarim Fabrika sexi', 'production'::location_type, ips.id, NULL
  FROM locations ips
 WHERE ips.name = 'Ishlab chiqarish sexi'
   AND ips.type = 'production'
   AND NOT EXISTS (
     SELECT 1
       FROM locations
      WHERE name = 'Yarim Fabrika sexi'
        AND type = 'production'
   );

-- 2. Rename + reclassify the 3 supply rows as sex_storage. Each row's
--    `parent_id` points to the sex floor that owns the buffer; if that floor
--    is missing the parent_id falls back to NULL (DB allows it).

-- 2a. id=3 — Ta'minot — Tort  ->  Tort skladi (under Tort sexi).
UPDATE locations
   SET name       = 'Tort skladi',
       type       = 'sex_storage'::location_type,
       parent_id  = (SELECT id FROM locations
                      WHERE name = 'Tort sexi' AND type = 'production'
                      ORDER BY id LIMIT 1),
       updated_at = now()
 WHERE id = 3
   AND type = 'supply';

-- 2b. id=38 — Ta'minot — Yarim Fabrika  ->  Yarim Fabrika skladi.
UPDATE locations
   SET name       = 'Yarim Fabrika skladi',
       type       = 'sex_storage'::location_type,
       parent_id  = (SELECT id FROM locations
                      WHERE name = 'Yarim Fabrika sexi' AND type = 'production'
                      ORDER BY id LIMIT 1),
       updated_at = now()
 WHERE id = 38
   AND type = 'supply';

-- 2c. id=39 — Ta'minot — Perojniy  ->  Perojniy skladi.
UPDATE locations
   SET name       = 'Perojniy skladi',
       type       = 'sex_storage'::location_type,
       parent_id  = (SELECT id FROM locations
                      WHERE name = 'Perojniy sexi' AND type = 'production'
                      ORDER BY id LIMIT 1),
       updated_at = now()
 WHERE id = 39
   AND type = 'supply';
