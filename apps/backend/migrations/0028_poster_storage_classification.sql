-- =============================================================================
-- 0028 — Poster storage classification (storage_id -> location_type).
-- =============================================================================
-- ADR-0017. Non-destructive: UPDATE / INSERT...ON CONFLICT only (no DELETE /
-- DROP / TRUNCATE). Idempotent: every statement is gated so a re-run is a
-- no-op.
--
-- Fixes P1: seedSync.upsertStorage historically defaulted ALL 25 storages to
-- 'central_warehouse'. This migration corrects the rows to their true type
-- (ADR §3) and merges the 3 store-backing storages (3/4/5) into their POS
-- spot locations (P2, ADR §4).
--
-- DATA SAFETY: only locations.type / poster_storage_id / is_active / name
-- rotate. stock / stock_movements / replenishment_requests reference
-- location_id — those ids are PRESERVED. No FK row is deleted here. On a
-- real-data deployment, stock must be merged from a store-backing storage
-- location to its spot location BEFORE this runs (ADR §5.4); on greenfield
-- this is a no-op because no stock has been synced yet.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — P2: merge store-backing storages (3,4,5) into POS spot locations.
-- For each (spot_id, storage_id) pair, move poster_storage_id onto the spot
-- row, then deactivate the orphaned storage-only row (DELETE is avoided).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- spot_poster_id, backing_storage_id
  pairs INT[][] := ARRAY[ARRAY[1, 3], ARRAY[2, 4], ARRAY[3, 5]];
  p     INT[];
  v_spot_loc    BIGINT;
  v_storage_loc BIGINT;
BEGIN
  FOREACH p SLICE 1 IN ARRAY pairs LOOP
    SELECT id INTO v_spot_loc
      FROM locations
     WHERE poster_spot_id = p[1] AND type = 'store'
     LIMIT 1;
    SELECT id INTO v_storage_loc
      FROM locations
     WHERE poster_storage_id = p[2] AND poster_spot_id IS NULL
     LIMIT 1;

    IF v_spot_loc IS NOT NULL THEN
      -- ORDER MATTERS: release the storage-only row's UNIQUE key FIRST, then
      -- claim it on the spot row. Doing the spot UPDATE first would collide
      -- with the storage-only row still holding the same poster_storage_id
      -- (uq_locations_poster_storage).
      --
      -- Deactivate the now-redundant storage-only row, if it still exists,
      -- and release its UNIQUE key so the spot row can own the storage id.
      IF v_storage_loc IS NOT NULL AND v_storage_loc <> v_spot_loc THEN
        UPDATE locations
           SET is_active = FALSE,
               poster_storage_id = NULL,
               name = name || ' [merged->spot]',
               updated_at = now()
         WHERE id = v_storage_loc
           AND poster_storage_id IS NOT NULL; -- gate: re-run is a no-op
      END IF;

      -- Move the storage id onto the spot row, but never steal a storage id
      -- already owned by a different ACTIVE spot row (keeps the UNIQUE index
      -- intact). Idempotent via `IS DISTINCT FROM`.
      UPDATE locations
         SET poster_storage_id = p[2],
             updated_at = now()
       WHERE id = v_spot_loc
         AND poster_storage_id IS DISTINCT FROM p[2]
         AND NOT EXISTS (
           SELECT 1 FROM locations
            WHERE poster_storage_id = p[2]
              AND id <> v_spot_loc
         );
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- STEP 2 — classify the remaining storages by poster_storage_id.
-- Idempotent: `type IS DISTINCT FROM` makes an already-correct row a no-op.
-- ---------------------------------------------------------------------------

-- raw_warehouse — Основной склад
UPDATE locations SET type = 'raw_warehouse', updated_at = now()
 WHERE poster_storage_id = 2 AND type IS DISTINCT FROM 'raw_warehouse';

-- central_warehouse (the ONE) — Склад Центральный
UPDATE locations SET type = 'central_warehouse', updated_at = now()
 WHERE poster_storage_id = 8 AND type IS DISTINCT FROM 'central_warehouse';

-- production — Производственный Цех
UPDATE locations SET type = 'production', updated_at = now()
 WHERE poster_storage_id = 20 AND type IS DISTINCT FROM 'production';

-- sex_storage — every remaining classified storage (ADR §3).
UPDATE locations SET type = 'sex_storage', updated_at = now()
 WHERE poster_storage_id IN (
         12, 15, 19, 21, 25, 26, 27, 28, 29, 30,
         31, 32, 33, 34, 35, 36, 37, 38, 39
       )
   AND type IS DISTINCT FROM 'sex_storage';

-- ---------------------------------------------------------------------------
-- STEP 3 — forward flows: every active sex_storage -> the central warehouse.
-- Mirrors migration 0026, but keyed on the Poster-named central warehouse
-- (storage_id = 8). ON CONFLICT DO NOTHING keeps it idempotent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_central BIGINT;
  v_sex     BIGINT;
BEGIN
  SELECT id INTO v_central
    FROM locations
   WHERE poster_storage_id = 8 AND type = 'central_warehouse'
   LIMIT 1;

  IF v_central IS NOT NULL THEN
    FOR v_sex IN
      SELECT id FROM locations WHERE type = 'sex_storage' AND is_active = TRUE
    LOOP
      INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
      VALUES (v_sex, v_central, 'forward')
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END$$;
