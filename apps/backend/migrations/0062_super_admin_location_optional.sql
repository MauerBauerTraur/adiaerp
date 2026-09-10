-- =============================================================================
-- 0062 — `super_admin` ni chain-wide rollar ro'yxatiga qo'shish.
-- =============================================================================
-- `chk_users_location_required` (0001) faqat 'pm' va 'ai_assistant' ga NULL
-- location'ga ruxsat beradi. `super_admin` roli keyinroq (0049) qo'shilgan,
-- lekin CHECK yangilanmagan — natijada ilova kodi bilan sxema bir-biriga
-- zid bo'lib qoldi:
--
--   * apps/backend/src/routes/users.ts → CHAIN_WIDE_ROLES = {super_admin, pm,
--     ai_assistant} — bo'g'insiz super_admin yaratishga ruxsat beradi;
--   * DB CHECK esa uni rad etadi → POST /api/users toza 422 emas, xom 500
--     qaytaradi.
--
-- CHECK faqat KENGAYTIRILADI (yangi rolga NULL ruxsat beriladi), shuning uchun
-- mavjud birorta qator uni buza olmaydi — validatsiya xavfsiz.
-- =============================================================================

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS chk_users_location_required;

ALTER TABLE users
    ADD CONSTRAINT chk_users_location_required
        CHECK (role IN ('super_admin', 'pm', 'ai_assistant') OR location_id IS NOT NULL);

COMMENT ON CONSTRAINT chk_users_location_required ON users IS
    'super_admin, pm va ai_assistant chain-wide — location_id NULL bo''lishi '
    'mumkin. Qolgan barcha rollar bo''g''inga bog''lanadi (RBAC location-scoped).';
