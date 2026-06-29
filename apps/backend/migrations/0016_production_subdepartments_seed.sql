-- =============================================================================
-- F4.9 — Production sub-departments (sexlar) default seed.
-- =============================================================================
-- Frontend "Production layer" sahifasi sub-tree quradi: parent = production
-- root, child = sex. Bu migratsiya zanjirning eng birinchi `production` typi
-- bo'lgan lokatsiyani "root" deb hisoblaydi va unga uchta default sub-dept
-- qo'shadi — agar hali yo'q bo'lsa.
--
-- Idempotent: nomi va parent_id bo'yicha mavjudligi tekshiriladi.
-- Production lokatsiya umuman yo'q bo'lsa — hech narsa qilinmaydi (system-
-- architect tomonidan owner seed-time da qo'shadi).
-- =============================================================================

DO $$
DECLARE
    root_id   BIGINT;
    dept_name TEXT;
    dept_names TEXT[] := ARRAY['Tort sexi', 'Perojniy sexi', 'Yarim Fabrika sexi'];
BEGIN
    -- Eng kichik id li parent_id=NULL bo'lgan production lokatsiya — "root".
    -- Agar barcha production lokatsiyalar boshqa rootga bog'langan bo'lsa,
    -- "root" sifatida eng kichik id li production qatorni olamiz.
    SELECT id INTO root_id
      FROM locations
     WHERE type = 'production' AND parent_id IS NULL
     ORDER BY id
     LIMIT 1;

    IF root_id IS NULL THEN
        SELECT id INTO root_id
          FROM locations
         WHERE type = 'production'
         ORDER BY id
         LIMIT 1;
    END IF;

    IF root_id IS NULL THEN
        -- Hali production layer mavjud emas; seed o'tkazib yuboriladi.
        RAISE NOTICE 'F4.9 seed: no production location found, skipping.';
        RETURN;
    END IF;

    FOREACH dept_name IN ARRAY dept_names LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM locations
             WHERE type = 'production'
               AND parent_id = root_id
               AND name = dept_name
        ) THEN
            INSERT INTO locations (name, type, parent_id)
            VALUES (dept_name, 'production', root_id);
        END IF;
    END LOOP;
END$$;
