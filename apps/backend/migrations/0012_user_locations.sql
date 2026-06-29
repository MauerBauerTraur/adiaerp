-- =============================================================================
-- F4.1 — Many-to-many user <-> location (ADR-0012).
-- =============================================================================
-- Faza-1 da `users.location_id BIGINT` (single FK) ishlatildi — bitta hodim
-- bitta lokatsiyaga (1:1). Faza-4 da bitta omborchi 3 do'konga xizmat qilishi,
-- bitta supply hodimi 2 zonada ishlashi mumkin.
--
-- Yondashuv: HYBRID (ADR-0012 §2.1).
--   - `users.location_id` saqlanadi va `is_primary = true` qator bilan
--     teng bo'ladi (back-compat — eski 95% kod tegmagan holatda ishlaydi).
--   - Yangi `user_locations` jadval — M:N qo'shimcha biriktirilgan lokatsiyalar.
--   - `is_primary` partial unique index — har user uchun faqat bitta primary.
--
-- Back-fill idempotent: mavjud `users.location_id IS NOT NULL` qatorlar
-- `user_locations` ga (is_primary=true) ko'chiriladi (ON CONFLICT DO NOTHING).
-- PM (chain-wide, NULL location) — qator yaratilmaydi; `locationIds = []`,
-- `isSuperAdmin` orqali passes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_locations (
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id          BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    is_primary           BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, location_id)
);

CREATE INDEX IF NOT EXISTS ix_user_locations_user
    ON user_locations(user_id);

CREATE INDEX IF NOT EXISTS ix_user_locations_location
    ON user_locations(location_id);

-- Partial unique — faqat bitta primary har user uchun. Row-level CHECK
-- shu invariantni ifoda eta olmaydi; partial unique index toza yechim.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_locations_primary
    ON user_locations(user_id) WHERE is_primary = TRUE;

-- Back-fill mavjud users.location_id dan. PM (NULL location_id) o'tib ketadi.
INSERT INTO user_locations (user_id, location_id, is_primary, assigned_at)
SELECT id, location_id, TRUE, COALESCE(created_at, now())
  FROM users
 WHERE location_id IS NOT NULL
ON CONFLICT (user_id, location_id) DO NOTHING;

COMMENT ON TABLE user_locations IS
    'F4.1 (ADR-0012). M:N — har user bir yoki ko''p lokatsiyada xizmat qiladi. '
    'is_primary=true qator users.location_id bilan sinxron (back-compat).';

COMMENT ON COLUMN user_locations.is_primary IS
    'Faqat bitta primary har user uchun (partial unique). '
    'users.location_id shu primary lokatsiya bilan sinxron saqlanadi.';
