-- =============================================================================
-- F4.9 — Replenishment so'roviga mas'ul xodimni biriktirish.
-- =============================================================================
-- Yetkazib berish (delivery) bo'limi `replenishment_requests` ni "yetkazma
-- vazifalari" ko'rinishida ishlatadi (status IN ('NEW','CHECK_STORE_SUPPLIER',
-- 'SHIP_TO_REQUESTER')). Vazifani bajaradigan aniq odam — `assigned_to_user_id`.
--
-- NULL — hali hech kimga biriktirilmagan. Diqqat: foydalanuvchi o'chirilsa
-- (ON DELETE SET NULL), vazifa "biriktirilmagan" holatga qaytadi va so'rov
-- yo'qolmaydi.
-- =============================================================================

ALTER TABLE replenishment_requests
    ADD COLUMN IF NOT EXISTS assigned_to_user_id BIGINT
        REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_replenishment_assigned
    ON replenishment_requests(assigned_to_user_id)
    WHERE assigned_to_user_id IS NOT NULL;

COMMENT ON COLUMN replenishment_requests.assigned_to_user_id IS
    'F4.9 — yetkazib berish/replenishment vazifasini bajaradigan mas''ul user. '
    'NULL = hali biriktirilmagan.';
