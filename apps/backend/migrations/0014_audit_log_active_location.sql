-- =============================================================================
-- F4.1 — Audit log da aktiv lokatsiya kontekstini saqlash (ADR-0012 §2.3).
-- =============================================================================
-- M:N tufayli foydalanuvchi qaysi lokatsiya nomidan ishlaganini audit log da
-- fiks qilamiz (X-Active-Location header yoki primary).
--
-- Eski audit_log qatorlar NULL qoladi (back-fill kerak emas — forensic
-- ma'lumot Faza-4 dan boshlab kerak).
-- =============================================================================

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS active_location_id BIGINT
        REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_audit_log_active_location
    ON audit_log(active_location_id) WHERE active_location_id IS NOT NULL;

COMMENT ON COLUMN audit_log.active_location_id IS
    'F4.1 (ADR-0012). Request paytida user kontekstidagi aktiv lokatsiya. '
    'X-Active-Location header yoki primary location.';
