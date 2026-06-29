-- 0025 — Yarim Fabrika is a SHARED sex_storage, not a sex.
-- D2/D7 correction: only 2 production sexes exist (Tort, Perojniy).
-- All sexes can deposit semi-finished items into the shared "Yarim Fabrika skladi".
-- Migration 0022 wrongly recreated "Yarim Fabrika sexi" (production); we remove it here
-- and re-parent the shared "Yarim Fabrika skladi" to the Ishlab chiqarish root.

DO $$
DECLARE
  v_yf_sexi_id        INTEGER;
  v_yf_skladi_id      INTEGER;
  v_ic_root_id        INTEGER;
  v_has_refs          BOOLEAN;
BEGIN
  SELECT id INTO v_yf_sexi_id
    FROM locations
   WHERE name = 'Yarim Fabrika sexi' AND type = 'production'
   LIMIT 1;

  SELECT id INTO v_yf_skladi_id
    FROM locations
   WHERE name = 'Yarim Fabrika skladi' AND type = 'sex_storage'
   LIMIT 1;

  SELECT id INTO v_ic_root_id
    FROM locations
   WHERE name = 'Ishlab chiqarish sexi' AND type = 'production'
   LIMIT 1;

  -- Step 1: re-parent the shared sklad to the Ishlab chiqarish root.
  IF v_yf_skladi_id IS NOT NULL AND v_ic_root_id IS NOT NULL THEN
    UPDATE locations
       SET parent_id = v_ic_root_id
     WHERE id = v_yf_skladi_id
       AND parent_id IS DISTINCT FROM v_ic_root_id;
  END IF;

  -- Step 2: remove or soft-deprecate "Yarim Fabrika sexi" depending on whether it has live references.
  IF v_yf_sexi_id IS NOT NULL THEN
    SELECT EXISTS (
        SELECT 1 FROM production_orders WHERE location_id = v_yf_sexi_id
      UNION ALL
        SELECT 1 FROM stock WHERE location_id = v_yf_sexi_id
      UNION ALL
        SELECT 1 FROM stock_movements WHERE from_location_id = v_yf_sexi_id OR to_location_id = v_yf_sexi_id
      UNION ALL
        SELECT 1 FROM replenishment_requests
         WHERE requester_location_id = v_yf_sexi_id OR target_location_id = v_yf_sexi_id
    ) INTO v_has_refs;

    IF NOT v_has_refs THEN
      DELETE FROM locations WHERE id = v_yf_sexi_id;
    ELSE
      UPDATE locations
         SET name = '[deprecated] Yarim Fabrika sexi'
       WHERE id = v_yf_sexi_id
         AND name = 'Yarim Fabrika sexi';
    END IF;
  END IF;
END $$;
