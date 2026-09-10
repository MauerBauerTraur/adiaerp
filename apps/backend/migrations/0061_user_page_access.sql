-- =============================================================================
-- 0061 — per-user sahifa (bo'lim) ruxsatlari.
-- =============================================================================
-- Ilgari foydalanuvchi qaysi ekranlarni ko'rishi FAQAT roli bilan aniqlanardi
-- (frontend `NAV_SECTIONS[].items[].roles`). Egasining talabi: "Foydalanuvchilar"
-- sahifasidagi biriktirish oynasi skladlarni emas, chap menyudagi bo'limlarni
-- (Boshqaruv paneli / Modullar / Ishlab chiqarish / Ma'lumotnoma) va ular
-- ichidagi sahifalarni tanlatsin.
--
-- Model: WHITELIST + rolga fallback.
--   - user uchun bironta qator YO'Q  → cheklov yo'q, roli ruxsat bergan hamma
--     ekran ko'rinadi (orqaga moslik: mavjud userlar tegilmaydi, back-fill shart emas).
--   - kamida bitta qator BOR         → aynan o'sha yo'llar ko'rinadi (rol filtri
--     baribir ustidan qo'llanadi — rol bermagan ekranni grant qilib bo'lmaydi).
--
-- `path` — frontend router yo'li (`/production`, `/cashier/receipts`, ...).
-- Ro'yxat backend'da `src/lib/navPaths.ts` da, u yerda validatsiya qilinadi;
-- shuning uchun bu yerda FK emas, oddiy TEXT.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_page_access (
    user_id             BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path                TEXT        NOT NULL,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_user_id  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, path)
);

CREATE INDEX IF NOT EXISTS ix_user_page_access_user
    ON user_page_access(user_id);

COMMENT ON TABLE user_page_access IS
    'Per-user ekran whitelist. Qator yo''q = cheklov yo''q (rol default). '
    'Qator bor = faqat shu yo''llar ko''rinadi. Ruxsat etilgan yo''llar '
    'ro''yxati: apps/backend/src/lib/navPaths.ts.';

COMMENT ON COLUMN user_page_access.path IS
    'Frontend router yo''li, masalan "/production" yoki "/cashier/receipts".';
