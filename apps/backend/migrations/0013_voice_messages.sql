-- =============================================================================
-- F4.3 — Voice → STT → AI → Action audit chain (ADR-0014).
-- =============================================================================
-- Har Telegram `message:voice` xabar uchun bitta qator. Transcript saqlanadi
-- (audit + forensic), va voice-dan kelib chiqqan barcha `assistant_actions`
-- qatorlari `voice_message_id` orqali shu yozuvga ulanadi.
--
-- Status mashinasi (ADR-0014 §2.1):
--   received           — voice qabul qilindi, fayl yuklab olindi.
--   transcribed        — STT muvaffaqiyatli, transcript yozildi.
--   parsed             — Vertex intent parse muvaffaqiyatli (intents bor).
--   actions_pending    — N ta assistant_actions yaratildi, foydalanuvchi tasdig'i kutilmoqda.
--   executed           — barcha pending actionlar oxiriga yetdi (executed/rejected).
--   failed             — STT yoki Vertex yoki download xato.
--   clarification_needed — mahsulot nomi noaniq, foydalanuvchidan tanlov so'raldi.
--
-- Index strategiyasi:
--   - (user_id, created_at DESC) — foydalanuvchi tarixi (`GET /api/voice-messages`).
--   - partial index pending statuslar — voiceCleanupCron va forensic so'rovlar.
-- =============================================================================

CREATE TYPE voice_message_status AS ENUM (
    'received',
    'transcribed',
    'parsed',
    'actions_pending',
    'executed',
    'failed',
    'clarification_needed'
);

CREATE TABLE voice_messages (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Telegram identifikatorlari — forensic + idempotensiya.
    telegram_message_id  BIGINT NOT NULL,
    telegram_file_id     TEXT NOT NULL,
    -- Audio metama'lumotlari (Telegram bizga beradi).
    audio_duration_sec   INTEGER,
    audio_bytes          INTEGER,
    -- STT chiqishi.
    transcript           TEXT,
    -- Status mashinasi.
    status               voice_message_status NOT NULL DEFAULT 'received',
    -- Vertex parser natijasi (intents[] yoki {clarification_needed,options}).
    intent_parse_result  JSONB,
    -- STT/Vertex/download xato detallari (oxirgi xato).
    error_detail         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- STT/parse/action loop tugagan vaqt (forensic SLA hisobi uchun).
    processed_at         TIMESTAMPTZ
);

CREATE INDEX ix_voice_user_recent
    ON voice_messages(user_id, created_at DESC);

-- Eski/turg'unligi tekshiruvchi cleanup uchun engil partial indeks. Voice
-- pipeline tugamagan (received/transcribed/parsed/actions_pending) qatorlar
-- — alert uchun.
CREATE INDEX ix_voice_pending
    ON voice_messages(status)
    WHERE status IN ('received','transcribed','parsed','actions_pending');

-- assistant_actions ga link (har action qaysi voice-dan kelganini bilish).
ALTER TABLE assistant_actions
    ADD COLUMN IF NOT EXISTS voice_message_id BIGINT
        REFERENCES voice_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_assistant_actions_voice
    ON assistant_actions(voice_message_id)
    WHERE voice_message_id IS NOT NULL;

COMMENT ON TABLE voice_messages IS
    'F4.3 (ADR-0014). Telegram voice xabarlarining audit chain. Bitta voice '
    'xabar 0..N ta assistant_actions yaratishi mumkin (multi-intent).';

COMMENT ON COLUMN voice_messages.intent_parse_result IS
    'Vertex Gemini parseStockMovementIntent JSONB chiqishi. Forma: '
    '{"intents":[{...}]} yoki {"clarification_needed":true,"options":[...]}.';

COMMENT ON COLUMN assistant_actions.voice_message_id IS
    'F4.3 (ADR-0014). Agar action voice xabar oqimi orqali yaratilgan bo''lsa, '
    'bog''langan voice_messages.id. UI/chat dan kelgan action uchun NULL.';
