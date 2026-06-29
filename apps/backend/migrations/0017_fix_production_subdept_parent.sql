-- =============================================================================
-- F4.11 Bug-MIN-02 — Re-parent production sub-departments to the production
-- root location ("Ishlab chiqarish sexi").
-- =============================================================================
-- Migration 0016 (production_subdepartments_seed) inserts the three default
-- sex'lar with parent_id pointing at the first production root it can find.
-- On databases where the seed was applied BEFORE the production root existed
-- — or where the rows were inserted by hand without parent_id — the sub-
-- departments end up orphaned and the Production-layer tree on the dashboard
-- renders empty.
--
-- Fix-forward: find the row named "Ishlab chiqarish sexi" (the canonical
-- production root in seed-dev.ts) and adopt every orphaned sub-department.
--
-- Idempotent:
--   * only rows with parent_id IS NULL are touched, so re-running this
--     migration after a successful first run is a no-op,
--   * matched by the exact (name, type='production') tuple — never reaches
--     outside the production layer,
--   * a no-op (zero rows updated) when the production root location is
--     absent (e.g. test databases that never seeded the chain).
-- =============================================================================

UPDATE locations
   SET parent_id = (
         SELECT id
           FROM locations
          WHERE type = 'production'
            AND name = 'Ishlab chiqarish sexi'
          ORDER BY id
          LIMIT 1
       )
 WHERE type = 'production'
   AND name IN ('Tort sexi', 'Perojniy sexi', 'Yarim Fabrika sexi')
   AND parent_id IS NULL
   AND EXISTS (
         SELECT 1
           FROM locations
          WHERE type = 'production'
            AND name = 'Ishlab chiqarish sexi'
       );
