-- 0026 — `location_flows` junction table for explicit M:N supply-chain flows.
--
-- Until now the EcosystemCanvas derived its edges from `locations.parent_id`
-- (a 1:N tree). The real domain is M:N:
--
--   * Tort sexi      → Tort skladi      AND Yarim Fabrika skladi
--   * Perojniy sexi  → Perojniy skladi  AND Yarim Fabrika skladi
--   * Every sex_storage → Markaziy Sklad (forward)
--   * Yarim Fabrika skladi → Tort sexi / Perojniy sexi (BOM re-entry — reverse loop)
--
-- `location_flows` makes those edges explicit so the canvas can render them
-- without inferring topology from names.
--
-- The seed runs in a single DO block so missing rows (different deployments
-- name the markaziy sklad differently — `Markaziy Sklad` in dev, `Склад
-- Центральный` in Poster) are skipped instead of erroring out. Every INSERT
-- guards itself with NULL checks.

CREATE TABLE IF NOT EXISTS location_flows (
  id                 SERIAL PRIMARY KEY,
  from_location_id   INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  to_location_id     INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  flow_type          VARCHAR(32) NOT NULL
                       CHECK (flow_type IN ('production_output','bom_input','forward','reverse')),
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_location_id, to_location_id, flow_type),
  CHECK (from_location_id <> to_location_id)
);

CREATE INDEX IF NOT EXISTS idx_location_flows_from ON location_flows(from_location_id);
CREATE INDEX IF NOT EXISTS idx_location_flows_to   ON location_flows(to_location_id);

-- ---------------------------------------------------------------------------
-- Seed — current domain model. Idempotent (UNIQUE + ON CONFLICT DO NOTHING).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_tort_sexi        INTEGER;
  v_perojniy_sexi    INTEGER;
  v_tort_skladi      INTEGER;
  v_perojniy_skladi  INTEGER;
  v_yf_skladi        INTEGER;
  v_central          INTEGER;
BEGIN
  SELECT id INTO v_tort_sexi       FROM locations WHERE name = 'Tort sexi'             AND type = 'production' LIMIT 1;
  SELECT id INTO v_perojniy_sexi   FROM locations WHERE name = 'Perojniy sexi'         AND type = 'production' LIMIT 1;
  SELECT id INTO v_tort_skladi     FROM locations WHERE name = 'Tort skladi'           AND type = 'sex_storage' LIMIT 1;
  SELECT id INTO v_perojniy_skladi FROM locations WHERE name = 'Perojniy skladi'       AND type = 'sex_storage' LIMIT 1;
  SELECT id INTO v_yf_skladi       FROM locations WHERE name = 'Yarim Fabrika skladi'  AND type = 'sex_storage' LIMIT 1;

  -- Markaziy Sklad — Poster ships the name in Russian (`Склад Центральный`)
  -- but the dev seed uses the Uzbek `Markaziy Sklad`. Pick whichever exists.
  SELECT id INTO v_central
    FROM locations
   WHERE type = 'central_warehouse'
     AND (name = 'Markaziy Sklad' OR name ILIKE '%центральный%' OR name ILIKE '%markaziy%')
   ORDER BY id
   LIMIT 1;

  -- Sexlar → o'z skladlari (production_output)
  IF v_tort_sexi IS NOT NULL AND v_tort_skladi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_tort_sexi, v_tort_skladi, 'production_output')
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_perojniy_sexi IS NOT NULL AND v_perojniy_skladi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_perojniy_sexi, v_perojniy_skladi, 'production_output')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Sexlar → Yarim Fabrika skladi (semi-finished output)
  IF v_tort_sexi IS NOT NULL AND v_yf_skladi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_tort_sexi, v_yf_skladi, 'production_output')
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_perojniy_sexi IS NOT NULL AND v_yf_skladi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_perojniy_sexi, v_yf_skladi, 'production_output')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Yarim Fabrika skladi → sexlar (BOM komponenti — qayta kirish)
  IF v_yf_skladi IS NOT NULL AND v_tort_sexi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_yf_skladi, v_tort_sexi, 'bom_input')
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_yf_skladi IS NOT NULL AND v_perojniy_sexi IS NOT NULL THEN
    INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
    VALUES (v_yf_skladi, v_perojniy_sexi, 'bom_input')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Sex skladlari → Markaziy Sklad (forward)
  IF v_central IS NOT NULL THEN
    IF v_tort_skladi IS NOT NULL THEN
      INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
      VALUES (v_tort_skladi, v_central, 'forward')
      ON CONFLICT DO NOTHING;
    END IF;
    IF v_perojniy_skladi IS NOT NULL THEN
      INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
      VALUES (v_perojniy_skladi, v_central, 'forward')
      ON CONFLICT DO NOTHING;
    END IF;
    IF v_yf_skladi IS NOT NULL THEN
      INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
      VALUES (v_yf_skladi, v_central, 'forward')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END $$;
