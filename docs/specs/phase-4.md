# ADIA ERP — Faza-4 Spetsifikatsiyasi

> Versiya: 1.0 · Sana: 2026-05-24 · Muallif: system-architect
> Asos: `docs/TZ.md` (§6, §12, §13, §14), `docs/specs/phase-3.md`,
> `docs/architecture/adr-0009-ai-write-actions.md`,
> `docs/architecture/adr-0011-telegram-inline-actions.md`,
> egasining 2026-05-24 qarorlari (Employees M:N, Yandex STT,
> Voice→AI, Markaziy dashboard, Chrome DevTools e2e).
> Holat: jamoa rahbari va loyiha egasi tasdig'iga.

Bu hujjat ADIA ERP **Faza-4** ning to'liq spetsifikatsiyasi. Faza-3
(F3.1 Vertex SDK + F3.2 AI write actions + F3.3 Telegram inline +
F3.4 forecasting) ishlab chiqarishga chiqarildi. Faza-4 to'rt
funksional yo'nalish + bitta sifat (QA) yo'nalishni qamrab oladi:

1. **F4.1 — Employees (Hodimlar bo'limi)**: admin login/parol bilan
   hodim yaratadi; bir hodim **bir nechta lokatsiyaga** (M:N)
   biriktirilishi mumkin; session davomida "aktiv lokatsiya" kontekst
   o'zgartirilishi mumkin.
2. **F4.2 — Yandex SpeechKit STT** integratsiyasi: IAM token exchange,
   Object Storage bucket (`adia-erp-voice`), STT v3 REST API
   (`recognize` short + `recognizeFileAsync` long).
3. **F4.3 — Voice → AI → Action** pipeline: Telegram'ga ovozli xabar →
   STT transkripsiya → Vertex Gemini intent parse → F3.2 two-phase
   commit oqimi orqali **N ta pending action** → inline tasdiq.
4. **F4.4 — Markaziy Dashboard kengaytma**: Poster sync holati,
   ekosistema oqimi vizualizatsiyasi, real-time alerts feed, savdo
   grafigi 7d/30d.
5. **F4.5 — Chrome DevTools e2e**: har sahifa va funksiya brauzerda
   sinaladi; console errors = 0; performance va RBAC smoke.

Arxitektura qarorlari (yangi):
- `docs/architecture/adr-0012-multi-location-users.md`
- `docs/architecture/adr-0013-yandex-stt.md`
- `docs/architecture/adr-0014-voice-to-action.md`

---

## 1. Qamrov (scope)

### 1.1. Faza-4 ga KIRADI

#### F4.1 — Employees / Multi-location M:N

- Yangi UI sahifa `/employees` (admin uchun):
  - Hodim ro'yxati (jadval: ism, rol, email, biriktirilgan lokatsiyalar,
    aktiv/inaktiv).
  - "Yangi hodim" formasi: ism, email, login, parol (bir martalik,
    bcrypt hash), rol, **bir yoki bir nechta lokatsiya tanlash** (multi-select).
  - "Tahrirlash": parol reset, rol o'zgartirish, lokatsiya qo'shish/olish.
  - "Inaktiv qilish" (soft delete: `users.is_active=false`).
- **M:N model**: yangi `user_locations` jadval (`user_id`, `location_id`,
  `is_primary`, `assigned_at`, `assigned_by_user_id`). `users.location_id`
  ustuni **saqlanadi** (back-compat) va primary lokatsiyaga teng bo'ladi.
- **Aktiv lokatsiya konsepti** (session-scoped):
  - JWT access token ichida ixtiyoriy `active_loc` claim
    (refresh ham `active_loc` ni `null` qabul qiladi).
  - Frontend header: `X-Active-Location: <id>` har request da
    yuborilishi mumkin (override).
  - Backend prioritet: `X-Active-Location` header > JWT `active_loc` >
    `users.location_id` (primary).
- **RBAC kengaytmasi** (ADR-0012):
  - `Principal.locationIds: number[]` qo'shiladi (barcha biriktirilgan
    lokatsiyalar).
  - `Principal.activeLocationId: number | null` — joriy kontekst.
  - `assertLocationAccess(principal, target)` endi: pm passes; aks holda
    `target` `principal.locationIds` ichida bo'lishi shart.
  - Eski `principal.locationId` saqlanadi (= primary), back-compat uchun.
- **Audit log** har `audit_log` qator endi `active_location_id`
  maydonini saqlaydi (request kontekstidagi aktiv lokatsiya).
- Migr `0012_user_locations.sql` — M:N + back-fill `users.location_id` dan.

#### F4.2 — Yandex SpeechKit STT

- Backend integratsiya `apps/backend/src/integrations/yandex/`:
  - `iam.ts` — OAuth → IAM token exchange (12h TTL cache).
  - `stt.ts` — `recognize` (short < 30s) va `recognizeFileAsync` (long).
  - `storage.ts` — Object Storage uchun upload (long flow uchun).
  - `errors.ts` — Yandex specific xato mapping.
- **OAuth → IAM token oqimi**:
  - `.env.YANDEX_OAUTH_TOKEN` (qo'lda olinadi: yandex.cloud konsoli).
  - `POST https://iam.api.cloud.yandex.net/iam/v1/tokens` body
    `{yandexPassportOauthToken: <oauth>}` → `{iamToken, expiresAt}`.
  - In-memory cache (12h TTL, lazy refresh on 401). Multi-process
    ishlatish bo'lsa — keyingi faza Redis.
- **Service account** (manual provisioning yo'riqnomasi ADR-0013 §3):
  - Service account `adia-erp-stt-sa` `ai.speechkit-stt.user` roli bilan.
  - Bucket `adia-erp-voice` (private, faqat SA uchun read/write).
  - Access keys (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` style)
    `.env` ga.
- **STT v3 API**:
  - Short (< 30s, sinxron): `POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize`.
  - Long (> 30s, async): yuklash → bucket → `recognizeFileAsync` →
    polling `getRecognition`.
  - Telegram voice odatda < 60s — `short` API yetadi (Telegram limit
    1h, lekin amaliyotda < 1min).
  - **Audio format**: Telegram `voice` → OGG/Opus container.
    Yandex STT `oggopus` formatni qabul qiladi → konvertatsiya
    KERAK EMAS (default codec).
  - Language: `uz-UZ`, fallback `ru-RU` (config orqali).
  - Profanity filter va swear word ON.

#### F4.3 — Voice → AI → Action pipeline

- Telegram bot uchun `message:voice` handler
  (`apps/backend/src/integrations/telegram/voiceHandler.ts`):
  1. `from.id` → `users.telegram_id` lookup → principal (active
     location = primary).
  2. `bot.api.getFile(voice.file_id)` → URL → backend HTTPS download →
     tmp file (`/tmp/voice-<update_id>.ogg`).
  3. Voice metadata + transcript saqlanadi: yangi `voice_messages`
     jadvali (§5.3).
  4. Yandex STT `recognize` → `transcript: string`, `confidence`.
  5. Vertex `parseStockMovementIntent(transcript, principal)` →
     `intents: Intent[]`.
  6. **Har intent uchun** F3.2 oqimi (assistant_actions `pending`):
     `INSERT INTO assistant_actions ...` (bitta yoki ko'p qatorlar).
  7. Telegram'ga xabar: transkripsiya + har action uchun inline
     "Tasdiq / Rad et" tugmalari (F3.3 verb `apprv:act:<id>`).
  8. Foydalanuvchi har actionni alohida tasdiqlaydi → F3.2
     `confirm` oqimi normal ishlaydi.
- **Vertex Gemini system prompt** (Vertex `parseStockMovementIntent`):
  - O'zbekcha + ruscha tushunadi.
  - Function calling JSON schema: `parse_movements({movements: [{action,
    product_name, qty, unit, location_hint?}]})`.
  - **Action turlari**:
    - `adjust_in` — kirim (masalan, "omborga 500 kg un keldi").
    - `adjust_out` — chiqim (masalan, "10 kg shakar yo'qoldi/tushdi").
    - `transfer` — bo'g'inlar orasida (masalan, "Filial-2 ga 5 ta tort
      jo'natdim").
  - Product matching: `product_name` matniga aniq mos `products.name`
    izlanadi; mos kelmasa — **disambiguation savol**: bot
    foydalanuvchidan tanlovni so'raydi (`action_id` = `pending_clarification`,
    inline tugmalar bilan top 3 nomzod).
- **Audit chain**:
  - `voice_messages` qator (transcript saqlanadi).
  - `assistant_actions` qator (intent → pending).
  - `audit_log` qator (real action bajarilganda).
  - Hammasi `voice_message_id` orqali bog'lanadi.
- **Xavfsizlik** (ADR-0014 §5):
  - Faqat `users.telegram_id` mavjud va `is_active=true` foydalanuvchi
    voice yubora oladi.
  - Notanish `from.id` → bot rad etadi va PM ga `notifications`
    qator yozadi (potansial hujum/spam).
  - Voice fayl tmp da 5 daqiqadan keyin o'chiriladi
    (`fs.unlink` finally bloki ichida).
  - Transcript `voice_messages` da saqlanadi (audit), lekin **ham
    sirli ma'lumotni filtirlash** — bu Faza-4 dan tashqarida.

#### F4.4 — Markaziy Dashboard kengaytma

- Yangi widgetlar `/dashboard` sahifasiga (TZ §6.10):
  - **PosterStatusCard** — oxirgi `poster_sync_runs` qator:
    `started_at`, `finished_at`, `status`, `error_count`, `latency_ms`
    (qizil/sariq/yashil badge).
  - **EcosystemFlowDiagram** — SVG asosida zanjir vizualizatsiyasi:
    Xom-ashyo ombori → Ishlab chiqarish → Ta'minot → Markaziy sklad →
    Do'konlar. Har bo'g'in node'ga statistika (jami ostatka, qizil
    mahsulotlar soni, ochiq replenishment soni); chiziqlarda 24h dagi
    `stock_movements` summa.
  - **AlertsFeed** — `notifications` jadvalining oxirgi 20 ta qatori
    (real-time uchun: dashboard 30s da poll qiladi yoki SSE; tanlov —
    polling, MVP).
  - **SalesChart** — Recharts line chart 7d / 30d switcher;
    `sales_stats_daily` agregatsiya.
- **Backend** yangi endpoint `GET /api/dashboard/ecosystem`:
  - **Response shape**:
    ```ts
    {
      poster: { lastRun, status, errorCount, latencyMs, hoursSinceLastRun },
      flow: {
        nodes: [{ locationId, name, type, totalQty, productsBelowMin, openRequests }],
        edges: [{ fromLocationId, toLocationId, qty24h, count24h }]
      },
      alerts: Array<{ id, type, title, body, createdAt }>,  // top 20
      sales: { range: '7d'|'30d', series: [{ date, qty, revenue? }] }
    }
    ```
  - RBAC: pm to'liq; manager o'z lokatsiyalari (M:N) bilan filter
    (faqat shu lokatsiya bog'liq qatorlar).
  - Cache: 10s in-memory (dashboard avtomatik refresh 30s da — 10s
    cache yetadi).
- **Frontend** yangi komponentlar `apps/web/src/features/dashboard/`:
  - `PosterStatusCard.tsx`, `EcosystemFlowDiagram.tsx`,
    `AlertsFeed.tsx`, `SalesChart.tsx`.
  - SVG flow diagram: D3 emas, custom positioned SVG (5-7 node yetadi).
- **Performance** (TZ §13): dashboard overview < 1s. Maqsad: P95
  endpoint < 500ms; client render < 500ms.

#### F4.5 — Chrome DevTools e2e

- `qa-engineer` chrome-devtools MCP bilan brauzerda har sahifa/funksiya
  sinaydi:
  - **Sahifalar**: login, dashboard, products, stock, requests,
    purchase orders, production, ai-chat, employees (yangi),
    settings (parol o'zgartirish).
  - **Funksiyalar**: login/logout, refresh oqimi, replenishment yaratish,
    purchase order tasdig'i, voice (mock), assistant query +
    action confirm, employees add/edit, lokatsiya switcher.
  - **Console**: errors = 0 har test scenariosida.
  - **Network**: 4xx/5xx jurnali (kutilgan 401 dan tashqari).
  - **Performance**: lighthouse score dashboard >= 85, transactional
    pages >= 80.
  - **RBAC smoke**: store_manager loginida boshqa do'konning resursi
    403 qaytaradi.
- AC mapping fayli: `docs/qa/phase-4-ac-mapping.md` (qa-engineer
  yaratadi).

### 1.2. Faza-4 ga KIRMAYDI (Faza-5 yoki keyingi)

- **Multi-tenant** — har doim bitta kompaniya.
- **Poster write-back** (ADIA → Poster) — Faza-3 da qoldirilgan, Faza-4
  da ham ochiq.
- **AI auto-confirm "yashil ro'yxat"** (low-risk write tasdiqsiz) —
  Faza-5 ga qoldiriladi.
- **Voice → Action without confirmation** — har doim tasdiq talab.
- **Multi-pending action paralel** (bitta sessiyada ko'p ochiq action) —
  voice flow uchun **istisno**: bir voice'da N intent → N pending
  action paralel ruxsat (yagona joy; chat flow esa bitta paralel).
- **PII / sirli ma'lumotni filtirlash** transcript'da.
- **SSE / WebSocket real-time** — hozircha polling 30s.
- **Lokatsiya o'zgartirilganda webhook/sync trigger** — back-compat
  uchun yetarli.
- **Voice tilini avtomatik aniqlash** — `uz-UZ` default, ruscha bilan
  ham ishlaydi (Yandex multi-language sozlanadi).

### 1.3. Asosiy invariantlar (buzilmaydi)

Faza-1..Faza-3 invariantlari saqlanadi (CLAUDE.md §6, `docs/specs/phase-3.md`
§1.3) + Faza-4 yangilanmalari:

11. **M:N user_locations:** har user bir yoki ko'p lokatsiyaga
    biriktiriladi; `assertLocationAccess` `principal.locationIds` ga
    qaraydi; pm har joyda passes.
12. **Aktiv lokatsiya** har request kontekstida aniqlanadi;
    `principal.activeLocationId` audit log'ga yoziladi.
13. **Voice intent → har bir movement alohida `assistant_actions`
    qator** — har biri alohida tasdiqlanadi (yoki rad etiladi).
14. **STT IAM token** loglarga, audit'ga, foydalanuvchi javobiga
    **hech qachon** sızdırilmaydi.
15. **Voice fayl** tmp da `unlink` finally bloki bilan o'chiriladi
    (5 daqiqa max retention).
16. **Voice transcript** `voice_messages` da saqlanadi (audit);
    foydalanuvchi `delete_my_data` so'rasa o'chiriladi (Faza-5).

---

## 2. Modullar

### 2.1. F4.1 — Employees (Hodimlar bo'limi)

**Scope:**

- Yangi sahifa `/employees` (admin/pm uchun):
  - Jadval — `users` qatorlari + bog'liq lokatsiyalar.
  - "Yangi hodim" wizard:
    - Step 1: shaxsiy (ism, email, telefon, telegram_id?).
    - Step 2: rol (dropdown — TZ §11 dagi 6 rol).
    - Step 3: lokatsiyalar (multi-select `locations` ro'yxati +
      `is_primary` checkbox).
    - Step 4: login + bir martalik parol (avtomatik generate yoki
      qo'lda; bcrypt hash backendda).
  - Edit modal: parol reset, lokatsiya qo'shish/olish, primary
    o'zgartirish.
  - Soft delete: `is_active=false`; default jadval faqat aktivlarni.
- Backend yangi service `apps/backend/src/services/employees.ts`:
  - `createEmployee(input, principal)` — `users` + `user_locations`
    INSERT bitta tranzaksiyada.
  - `assignLocation(userId, locationId, isPrimary, principal)`.
  - `removeLocation(userId, locationId, principal)` — `is_primary`
    o'tkazilmaguncha primary o'chirilmaydi.
  - `setPrimaryLocation(userId, locationId)`.
- **Aktiv lokatsiya tanlovi**:
  - Frontend: header da dropdown — `principal.locationIds` ga mos
    keladigan lokatsiyalar; tanlov localStorage va backend
    `PATCH /api/auth/active-location` ga yuboriladi.
  - Backend: `auth/active-location` endpoint JWT'ni qayta-imzolaydi
    (yangi `active_loc` claim bilan) yoki refresh ni majburlaydi.
    Tavsiya: **`active_loc` ni JWT'ga qo'shmaymiz** (har request da
    qayta imzolash qimmat); o'rniga `X-Active-Location` header har
    request da yuboriladi; backend uni validate qiladi (`locationIds`
    ichida bo'lishi shart).
  - PATCH endpoint: faqat audit yozadi va frontend uchun "set"
    bayonotini tasdiqlaydi.
- **RBAC pre-check**:
  - Hodim yaratish/o'chirish — faqat pm yoki admin (TZ §11).
  - Hodimga lokatsiya biriktirish — faqat pm (chunki bu RBAC
    konfiguratsiyasi).
  - Hodim o'z parolini o'zgartirishi mumkin (yangi
    `PATCH /api/auth/password` endpoint, Faza-1 bor ekan — saqlanadi).

**Migration:** `0012_user_locations.sql` (§5.1).

**Acceptance:**
- AC4.1.1: PM `POST /api/users` orqali login/parol/lokatsiyalar ro'yxati
  bilan yangi hodim yaratadi. `users` da qator, `user_locations` da
  N qator, parol bcrypt hash.
- AC4.1.2: Bir omborchi 3 do'konga biriktirilgan — uchchala do'konning
  `GET /api/stock` chiqishi uning uchun ko'rinadi; 4-do'kon 403.
- AC4.1.3: Header `X-Active-Location: <id>` (ro'yxatdagi id) → request
  shu lokatsiya kontekstida bajariladi (audit log yozadi).
- AC4.1.4: Header `X-Active-Location: 999` (ro'yxatda yo'q) → 403
  `ACTIVE_LOCATION_NOT_ALLOWED`.
- AC4.1.5: Eski endpointlar (`/api/stock`, `/api/replenishments`, ...)
  buzilmaydi — `principal.locationId` (primary) hali ishlaydi.
- AC4.1.6: Hodim primary lokatsiyasini o'chirib bo'lmaydi — avval
  boshqa primary belgilash kerak.
- AC4.1.7: Hodim soft-delete (`is_active=false`) → JWT validate
  `INACTIVE_USER` qaytaradi va refresh ishlamaydi.

### 2.2. F4.2 — Yandex SpeechKit STT

**Scope:**

- Modul `apps/backend/src/integrations/yandex/`:
  - `iam.ts`:
    ```ts
    export async function getIamToken(): Promise<string> {
      if (cache && cache.expiresAt > Date.now() + 60_000) return cache.token;
      const resp = await fetch('https://iam.api.cloud.yandex.net/iam/v1/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yandexPassportOauthToken: cfg.yandex.oauthToken }),
      });
      const { iamToken, expiresAt } = await resp.json();
      cache = { token: iamToken, expiresAt: new Date(expiresAt).getTime() };
      return iamToken;
    }
    ```
  - `stt.ts`:
    - `recognizeShort(audioBuffer, opts): Promise<{transcript, confidence}>`.
    - Endpoint: `POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize`.
    - Query params: `folderId=<folder>`, `lang=uz-UZ`,
      `format=oggopus`, `profanityFilter=true`.
    - Headers: `Authorization: Bearer <iamToken>`.
    - Body: raw audio bytes (Telegram OGG faylni direct yuboramiz).
    - Timeout: 30s; retry 1 marta `401` ga (token refresh).
- **Config**:
  ```env
  YANDEX_OAUTH_TOKEN=...
  YANDEX_FOLDER_ID=...
  YANDEX_STT_BUCKET=adia-erp-voice
  YANDEX_S3_ACCESS_KEY_ID=...
  YANDEX_S3_SECRET_ACCESS_KEY=...
  YANDEX_STT_LANGUAGE=uz-UZ
  ```
- **Maxfiy** (ADR-0013 §5): IAM tokenni hech qachon loglashga
  yo'l qo'ymaslik — log helper'da `iamToken`, `Authorization`
  headerlari sanitize qilinadi.

**Acceptance:**
- AC4.2.1: `getIamToken()` birinchi chaqiruv da Yandex IAM ga POST
  yuboradi va token qaytaradi; ikkinchi chaqiruv cache'dan.
- AC4.2.2: Token muddati 5 daqiqadan kam qolganda — re-fetch.
- AC4.2.3: `recognizeShort` real Yandex'ga POST → transcript qaytadi
  (smoke test, real OAuth bilan; CI'da skip).
- AC4.2.4: 401 javob → bir marta token refresh + retry.
- AC4.2.5: Loglar da `Authorization`, `iamToken`, `oauthToken`
  qiymatlari yo'q (test: grep stdout).

### 2.3. F4.3 — Voice → AI → Action

**Scope:**

- Grammy bot handler:
  ```ts
  bot.on('message:voice', async (ctx) => {
    const tgId = ctx.from?.id;
    const user = await db.queryOne(
      'SELECT * FROM users WHERE telegram_id = $1 AND is_active = true', [tgId]);
    if (!user) {
      await ctx.reply("Sizning Telegram hisobingiz tizimda topilmadi.");
      return;
    }
    const principal = await loadPrincipal(user.id);
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const audioBuf = await downloadTelegramFile(file.file_path);
    const voiceMsg = await insertVoiceMessage({
      userId: user.id, telegramUpdateId: ctx.update.update_id,
      durationS: ctx.message.voice.duration, sizeBytes: audioBuf.length,
    });
    let transcript: string;
    try {
      const stt = await recognizeShort(audioBuf, { language: 'uz-UZ' });
      transcript = stt.transcript;
      await updateVoiceMessageTranscript(voiceMsg.id, transcript, stt.confidence);
    } catch (e) {
      await ctx.reply("Ovozni tushuna olmadim, qayta sinab ko'ring.");
      return;
    }
    const intents = await parseStockMovementIntent(transcript, principal);
    if (intents.length === 0) {
      await ctx.reply(`"${transcript}" — amal aniqlanmadi.`);
      return;
    }
    const actions = await createPendingActionsForIntents(intents, principal, voiceMsg.id);
    const messageText = formatVoiceConfirmation(transcript, actions);
    const keyboard = buildVoiceActionKeyboard(actions);
    await ctx.reply(messageText, { reply_markup: { inline_keyboard: keyboard } });
  });
  ```
- **Vertex `parseStockMovementIntent`** (yangi system prompt
  `apps/backend/src/integrations/vertex/voicePrompt.ts`):
  - O'zbekcha (lotin + krill) va ruscha.
  - Function declaration:
    ```ts
    {
      name: 'parse_movements',
      parameters: {
        type: 'OBJECT',
        properties: {
          movements: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                action: { type: 'STRING', enum: ['adjust_in','adjust_out','transfer'] },
                product_name: { type: 'STRING' },
                qty: { type: 'NUMBER' },
                unit: { type: 'STRING' },
                from_location_hint: { type: 'STRING' },
                to_location_hint: { type: 'STRING' },
              },
              required: ['action','product_name','qty','unit']
            }
          }
        },
        required: ['movements']
      }
    }
    ```
  - **Product resolution**:
    - `product_name` matnini `products.name` ga `ILIKE`, `pg_trgm`
      similarity orqali izlaydi.
    - Yagona aniq mos topilsa → product_id ni action ga yopishtir.
    - Ko'p nomzod → `clarification_action` (max 3 ta variant inline
      tugma bilan).
    - Hech narsa — `unknown_product` xato action (PM ga notification).
- **Inline keyboard** voice confirmation uchun:
  - Har action uchun ikki tugma: `apprv:act:<id>`, `rej:act:<id>`.
  - Yagona "Hammasini tasdiqlash" tugmasi: `apprv_all:vmsg:<vmsg_id>`
    (verb yangi).
- **F3.2 oqimi reuse**: `assistant_actions` qatori sifatida pending
  yaratiladi; mavjud `confirm` / `reject` endpointlari va Telegram
  callback handler ishlatiladi. Bitta o'zgartirish — `assistant_actions`
  ga `voice_message_id` ustun (§5.3).

**Acceptance:**
- AC4.3.1: Omborchi "Bugun omborga 500 kg un keldi" ovozli xabar yuboradi
  → bot transkripsiya + 1 ta pending action ("Xom-ashyo ombori: +500
  kg Un Oliy nav") + 2 tugma (Tasdiq / Rad).
- AC4.3.2: "500 kg un va 50 l yog' keldi" → 2 ta alohida action +
  "Hammasini tasdiqlash" tugmasi.
- AC4.3.3: "Filial-2 ga 5 ta tort jo'natdim" → transfer action
  (from = principal.activeLocationId, to = Filial-2).
- AC4.3.4: Aniq bo'lmagan mahsulot ("un keldi" — Oliy/I/II nav bor) →
  bot disambiguation savol (3 tugma).
- AC4.3.5: Hech qanday amal aniqlanmagan transkripsiya ("Salom,
  yaxshimisiz") → bot "Amal aniqlanmadi" deydi, `assistant_actions`
  yaratilmaydi.
- AC4.3.6: Notanish telegram_id voice yuborsa → bot "Sizning hisobingiz
  topilmadi" javob beradi; PM ga notification (spam ehtimoli).
- AC4.3.7: Tasdiq oqimi F3.2 normal — `executed` da real
  `stock_movements` qator yaratiladi.
- AC4.3.8: Voice fayl tmp dan 5 daqiqa ichida o'chadi (`fs.unlink`
  finally yoki keyingi cron). `voice_messages` qator esa saqlanadi.

### 2.4. F4.4 — Markaziy Dashboard kengaytma

**Scope:**

- Backend yangi endpoint `GET /api/dashboard/ecosystem`:
  - 4 ta blok (poster, flow, alerts, sales) bitta payloadda
    (frontendning bitta fetch).
  - Query: `?sales_range=7d|30d` (default 7d).
  - RBAC:
    - pm — barcha locations, butun sales.
    - manager — `principal.locationIds` ga filtrlangan flow va sales.
    - alerts — recipient_user_id = principal.userId yoki broadcast.
  - Cache: `node-cache` 10s TTL key per `(role, locationIds.join, range)`.
- **Frontend** `/dashboard`:
  - Top row: KPI cards (Faza-2 davom — orqada turadi).
  - **PosterStatusCard**: status badge + "Oxirgi sync N daqiqa oldin"
    + error count link → `/admin/poster-runs`.
  - **EcosystemFlowDiagram**:
    - 5 ta node (raw_wh, production, supply, central_wh, store) —
      yoki dinamik `locations` ro'yxatidan generate.
    - Har node card: jami ostatka, qizil mahsulotlar soni, ochiq req.
    - Edges (chiziq): yo'nalish strelka, 24h movement summa.
    - Qizil nuqta: pulsing (red) — node'da invariant buzilgan yoki
      yangi alert.
  - **AlertsFeed**: 20 oxirgi `notifications` (ikon + title +
    "5 daqiqa oldin"). 30s da auto-refresh.
  - **SalesChart**: line chart `qty` va ixtiyoriy `revenue` (Poster
    dan kelgan bo'lsa); 7d/30d switch.
- **Performance**:
  - SQL: 1 ta `WITH ... SELECT ... UNION ALL` kombinatsiyalashgan
    yoki 4 ta parallel `Promise.all` (har biri index'lar bilan
    indexlangan). Tavsiya: parallel queries (oson debug).
  - Maqsad: endpoint < 500ms P95; frontend render < 500ms.

**Acceptance:**
- AC4.4.1: PM `/dashboard` ochadi → 1 ta network request to
  `/api/dashboard/ecosystem` (KPI dan boshqa) → barcha 4 blok keladi.
- AC4.4.2: PosterStatusCard'da oxirgi sync vaqti to'g'ri (sun'iy
  `poster_sync_runs` qator → UI yangilanadi).
- AC4.4.3: Flow diagram da har lokatsiya qizil/sariq/yashil
  ostatka holatiga moslab rang oladi.
- AC4.4.4: Sales chart 7d/30d switch real-time.
- AC4.4.5: store_manager `/dashboard` ochadi — faqat o'z
  lokatsiyalariga oid flow va alerts (boshqa do'konlar yo'q).
- AC4.4.6: `/api/dashboard/ecosystem` P95 < 1000ms (smoke test).
- AC4.4.7: Dashboard 30s da AlertsFeed avtomatik yangilanadi (yangi
  notification yaratilsa keyingi pollda paydo bo'ladi).

### 2.5. F4.5 — Chrome DevTools e2e

**Scope:**

- `qa-engineer` chrome-devtools MCP bilan har sahifa va asosiy
  funksiyalarni brauzerda kuzatadi.
- Test scenariosi (umumiy 20+ scenario):
  1. Login (admin, pm, store_manager, raw_wh) — 4 ta.
  2. Logout + refresh oqimi.
  3. Dashboard load — 4 blok ko'rinadi; console errors=0.
  4. Stock CRUD smoke (Faza-1) — list, filter, adjust qty.
  5. Replenishment yaratish va state machine bosqichlari.
  6. Purchase order: yaratish, manager tasdiq, keeper tasdiq.
  7. AI chat: oddiy savol (read) → javob.
  8. AI chat: write tool (transfer) → tasdiq dialog → confirm.
  9. Voice mock (audio fayl upload simulyatsiya).
  10. Telegram inline tugmalar (mock).
  11. Employees: yangi hodim yaratish.
  12. Aktiv lokatsiya o'zgartirish.
  13. RBAC: store_manager boshqa do'kon → 403.
  14. Refresh expiry (sun'iy clock).
- **Lighthouse**:
  - Dashboard `/dashboard`: performance >= 85.
  - Stock `/stock`: performance >= 80.
- **Console**: `list_console_messages` errors length === 0.
- **Network**: `list_network_requests` da 5xx === 0.
- AC mapping fayl `docs/qa/phase-4-ac-mapping.md` — har AC uchun
  qaysi scenario va `take_snapshot` skrinshoti.

**Acceptance:**
- AC4.5.1: 20+ scenario brauzerda muvaffaqiyatli o'tadi.
- AC4.5.2: Har scenario'da console errors=0 (kutilgan unauthenticated
  401 dan tashqari).
- AC4.5.3: Lighthouse dashboard >= 85.
- AC4.5.4: Hisobot fayl `docs/qa/phase-4-ac-mapping.md` mavjud,
  har AC ga scenario id yopishtirilgan.

---

## 3. API kontrakti (yangi endpointlar)

JWT + RBAC + audit. Xato kodlari §3.6 (kengaytma).

### 3.1. Employees

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/users` | pm | `?role=&location_id=&active=` → `{items, total}` |
| GET  | `/api/users/:id` | pm | tafsilot + `locations: [{id,name,type,is_primary}]` |
| POST | `/api/users` | pm | `{full_name, email, login, password, role, telegram_id?, location_ids:number[], primary_location_id}` → `{id,...}` |
| PATCH | `/api/users/:id` | pm | partial update (role, is_active, telegram_id) |
| POST | `/api/users/:id/password-reset` | pm | `{new_password}` → 204 |
| GET  | `/api/users/:id/locations` | pm, self | → `[{location_id,name,type,is_primary,assigned_at}]` |
| POST | `/api/users/:id/locations` | pm | `{location_id, is_primary?}` → 201 |
| DELETE | `/api/users/:id/locations/:location_id` | pm | 204 (primary o'chirib bo'lmaydi) |
| PUT  | `/api/users/:id/locations/:location_id/primary` | pm | 204 (primary'ni o'tkazadi) |

### 3.2. Active location switch

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| PATCH | `/api/auth/active-location` | har auth user | `{location_id: number}` → `{active_location_id}` (audit log + sessionga belgilaydi) |
| GET   | `/api/auth/me` | har auth | kengayadi: `locations: [{id,name,is_primary}]`, `active_location_id` |

**Header**: `X-Active-Location: <id>` har request da yuborilishi mumkin.
Backend validate: `locationIds` ichida bo'lishi shart, aks holda 403
`ACTIVE_LOCATION_NOT_ALLOWED`.

### 3.3. Yandex STT (ichki)

| Metod | Endpoint | Auth | Request → Response |
|---|---|---|---|
| POST | `/api/integrations/yandex/stt/recognize` | internal (shared secret) | `multipart/form-data` audio + `language?` → `{transcript, confidence}` |

> Eslatma: bu endpoint asosan **voice handler** ichki chaqiruvi —
> tashqi foydalanuvchi UI dan chaqirmaydi. Future-proof sifatida
> qoldiramiz; hozirgi pipeline `stt.ts` ni to'g'ridan-to'g'ri chaqiradi
> (extra HTTP hop'siz). Endpoint test va frontend smoke uchun
> qoldiriladi.

### 3.4. Dashboard ecosystem

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET | `/api/dashboard/ecosystem` | pm, *_manager (scoped) | `?sales_range=7d|30d` → `{poster, flow, alerts, sales}` |

### 3.5. Voice (audit / debug)

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET | `/api/voice-messages` | pm, self | `?user_id=&from=&to=` → `{items, total}` |
| GET | `/api/voice-messages/:id` | pm, self | tafsilot + linked `assistant_actions` |

### 3.6. Yangi xato kodlari (Faza-3 ustiga)

- `ACTIVE_LOCATION_NOT_ALLOWED` (403) — `X-Active-Location` user'ning
  `locationIds` ichida yo'q.
- `LOCATION_NOT_ASSIGNED` (403) — domen endpoint target `location_id`
  user'da assign emas.
- `PRIMARY_LOCATION_REQUIRED` (422) — primary lokatsiyani o'chirish
  urinishi.
- `STT_SERVICE_UNAVAILABLE` (503) — Yandex STT 5xx yoki timeout.
- `STT_AUTH_FAILED` (502) — IAM token refresh ham 401 berdi.
- `VOICE_USER_UNKNOWN` (401, bot only) — telegram_id mos kelmaydi.
- `INTENT_NOT_PARSED` (422) — Vertex parser bo'sh massiv qaytardi.
- `PRODUCT_NOT_MATCHED` (422) — product_name mos kelmadi (clarification
  ham yo'q).

---

## 4. RBAC kengaytmasi

Faza-3 §4 matritsasi davom etadi. M:N tufayli **uchta yangi**
hujjat-effekt:

1. `assertLocationAccess(principal, target)` endi `principal.locationIds`
   ga qaraydi (pm passes; aks holda `target ∈ locationIds`).
2. Audit log `active_location_id` ham yozadi (kontekst).
3. Action confirm — actionning maqsad `location_id` (transfer da `from`
   va `to`) ikkalasi ham `principal.locationIds` ichida bo'lishi shart
   (pm istisno).

**Employees endpointlari**:

| Endpoint | pm | manager | omborchi | sotuvchi |
|---|---|---|---|---|
| `GET /api/users` | R | – | – | – |
| `POST /api/users` | W | – | – | – |
| `PATCH /api/users/:id` | W | – | – | – |
| `POST /api/users/:id/password-reset` | W | self | self | self |
| `*/locations` | W | – | – | – |
| `PATCH /api/auth/active-location` | self | self | self | self |

**Voice flow**: telegram callback action `principal` = `users.telegram_id`
match (Faza-3 saqlanadi), `activeLocationId` = primary
(voice flow uchun manfaat — voice xabarda location explicit emas, default
primary; intent ichida `from_location_hint` topilsa o'sha ishlatiladi).

---

## 5. Migratsiyalar

Tartib:
1. `0012_user_locations.sql` — M:N + back-fill.
2. `0013_voice_messages.sql` — voice audit jadval.
3. `0014_audit_log_active_location.sql` — audit kolonkasi.

### 5.1. `0012_user_locations.sql`

```sql
-- F4.1 — Many-to-many user <-> location.
--
-- Faza-1 da `users.location_id BIGINT` (single FK) ishlatildi.
-- Faza-4 da bitta hodim bir nechta lokatsiyaga xizmat qilishi mumkin
-- (omborchi 3 do'konga, supply 2 zonaga, h.k.). `users.location_id`
-- saqlanadi (= primary) — back-compat uchun; M:N tafsilot
-- `user_locations` jadvalida.
--
-- Back-fill strategiyasi:
-- har mavjud `users.location_id IS NOT NULL` qator uchun
-- `user_locations` ga (user_id, location_id, is_primary=true) qator
-- yoziladi.

CREATE TABLE user_locations (
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id          BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    is_primary           BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, location_id)
);

CREATE INDEX ix_user_locations_user      ON user_locations(user_id);
CREATE INDEX ix_user_locations_location  ON user_locations(location_id);

-- Faqat bitta primary har user uchun (CHECK qator-darajasiga to'g'ri
-- kelmaydi — partial unique index ishlatamiz).
CREATE UNIQUE INDEX uq_user_locations_primary
    ON user_locations(user_id) WHERE is_primary = TRUE;

-- Back-fill mavjud users.location_id dan.
INSERT INTO user_locations (user_id, location_id, is_primary, assigned_at)
SELECT id, location_id, TRUE, COALESCE(created_at, now())
  FROM users
 WHERE location_id IS NOT NULL
ON CONFLICT (user_id, location_id) DO NOTHING;

COMMENT ON TABLE  user_locations IS
    'M:N — har user bir yoki ko''p lokatsiyada xizmat qiladi. ' ||
    'is_primary = users.location_id ekvivalenti (back-compat).';

COMMENT ON COLUMN user_locations.is_primary IS
    'Faqat bitta primary har user; users.location_id shu primary ' ||
    'lokatsiya bilan sinxron saqlanadi.';
```

### 5.2. `0013_voice_messages.sql`

```sql
-- F4.3 — Voice → AI → Action audit chain.
--
-- Telegram `message:voice` har xabar uchun bir qator. Transcript va
-- bog'liq `assistant_actions` ham shu qatorga link orqali ulanadi
-- (forensic uchun).

CREATE TABLE voice_messages (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_update_id   BIGINT,
    telegram_file_id     TEXT,
    duration_s           INTEGER,
    size_bytes           INTEGER,
    transcript           TEXT,
    stt_confidence       NUMERIC(5,4),
    stt_language         TEXT DEFAULT 'uz-UZ',
    stt_provider         TEXT NOT NULL DEFAULT 'yandex',
    intents_count        INTEGER NOT NULL DEFAULT 0,
    processing_error     TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_voice_messages_user       ON voice_messages(user_id, created_at DESC);
CREATE INDEX ix_voice_messages_update_id  ON voice_messages(telegram_update_id);

-- `assistant_actions` ga link.
ALTER TABLE assistant_actions
    ADD COLUMN voice_message_id BIGINT REFERENCES voice_messages(id) ON DELETE SET NULL;

CREATE INDEX ix_assistant_actions_voice ON assistant_actions(voice_message_id)
    WHERE voice_message_id IS NOT NULL;

COMMENT ON TABLE voice_messages IS
    'F4.3 — Telegram voice xabarlarining audit chain. Bitta voice ' ||
    'xabar 0..N ta `assistant_actions` qatorni yaratishi mumkin.';
```

### 5.3. `0014_audit_log_active_location.sql`

```sql
-- F4.1 — Audit log da aktiv lokatsiya kontekstini saqlash.
--
-- M:N tufayli foydalanuvchi qaysi lokatsiya nomidan ishlaganini
-- audit log da fiks qilamiz (X-Active-Location header yoki primary).

ALTER TABLE audit_log
    ADD COLUMN active_location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX ix_audit_log_active_location
    ON audit_log(active_location_id) WHERE active_location_id IS NOT NULL;

COMMENT ON COLUMN audit_log.active_location_id IS
    'Request paytida user kontekstidagi aktiv lokatsiya (M:N: primary ' ||
    'yoki X-Active-Location header bilan tanlangan).';
```

---

## 6. Ochiq savol va qarorlar

### 6.1. Hal qilingan qarorlar (egasi, 2026-05-24)

| Qaror | Holat |
|---|---|
| Employees: M:N user_locations. | ✅ Hal qilindi (ADR-0012). |
| Aktiv lokatsiya: session-scoped (header / state). | ✅ `X-Active-Location` header (JWT'ga qo'shilmaydi). |
| STT provayder: Yandex SpeechKit v3. | ✅ ADR-0013. |
| Voice→AI: F3.2 two-phase commit reuse. | ✅ ADR-0014. |
| Dashboard ekosistema oqimi vizual. | ✅ SVG asosida custom diagram (D3 emas). |
| QA: chrome-devtools MCP bilan har sahifa. | ✅ Faza-4 acceptance. |

### 6.2. Faza-4 ichida hal qilinishi kerak (texnik, bloklamaydi)

- **Yandex SA va bucket provisioning** — DevOps qo'lda yaratadi
  (yo'riqnoma ADR-0013 §3); avtomatlashtirish keyingi faza.
- **STT cost monitoring** — Yandex billing API yoki shunchaki manual
  oylik review (~$0.10/daqiqa, 20 voice/kun × 30s ≈ $3/oy — pastroq,
  monitoring zarurati past).
- **Voice multi-process IAM cache** — bitta PM2 jarayonda in-memory
  yetadi (cluster mode bo'lsa Redis kerak; Faza-4 default single
  process).
- **Aktiv lokatsiya UI** — frontend dropdown joyi: header center yoki
  user menyu? Tavsiya: header center (lazyweb da Notion / Linear
  workspace switcher pattern).
- **EcosystemFlowDiagram dinamik mi static?** — `locations` jadvalidan
  query qilinadi, lekin layout (x/y koordinatalar) hozircha **static
  hardcoded** (5-7 node). Dinamik graph algoritm (force-directed)
  Faza-5.

### 6.3. Faza-5 ga qoldiriladigan ochiq savollar

- **Poster write-back** (ADIA → Poster).
- **AI auto-confirm yashil ro'yxat**.
- **PII filtirlash** voice transcript da.
- **SSE / WebSocket real-time** dashboard.
- **Dinamik flow diagram layout** (force-directed).
- **Multi-process IAM token cache** (Redis).
- **Multi-language STT auto-detect**.
- **Voice transcript searchable archive** (full-text indeks).

---

## 7. Faza-4 yetkazib berish ketma-ketligi

> `planning-and-task-breakdown` uchun ko'rsatkich. Team lead
> taqsimlaydi.

**Sprint 0 (bu hujjat) — planning**
- Spec yozildi (F4.0).
- 3 ta ADR yozildi (0012, 0013, 0014).
- Egasi tasdig'i.

**Sprint 1 (2 hafta) — F4.1 Employees + F4.2 Yandex STT** (parallel):

F4.1 backend:
- `0012_user_locations.sql` migratsiya + back-fill.
- `services/employees.ts`.
- `lib/principal.ts` kengaytmasi (`locationIds`, `activeLocationId`).
- Auth middleware: `X-Active-Location` header validate.
- Routes `/api/users`, `/api/users/:id/locations`,
  `/api/auth/active-location`.
- `0014_audit_log_active_location.sql`.
- Audit helper kengaytmasi.
- Unit + integration testlar.

F4.1 frontend:
- `/employees` sahifa (jadval + wizard + edit modal).
- Header lokatsiya switcher.
- `useActiveLocation` hook.

F4.2 backend (parallel):
- DevOps Yandex SA va bucket yaratadi (yo'riqnoma).
- `integrations/yandex/iam.ts`, `stt.ts`, `errors.ts`.
- Smoke test (real OAuth).
- Log sanitizer (Authorization, iamToken filter).

**Sprint 2 (1.5 hafta) — F4.3 Voice → AI → Action**:
- `0013_voice_messages.sql`.
- Voice handler (`telegram/voiceHandler.ts`).
- `vertex/voicePrompt.ts` + `parseStockMovementIntent`.
- Product matching (`pg_trgm` similarity).
- Disambiguation flow (clarification action).
- "Hammasini tasdiqlash" verb (`apprv_all:vmsg:<id>`).
- Tests AC4.3.1..AC4.3.8 (mock STT + mock Vertex).

**Sprint 3 (1 hafta) — F4.4 Markaziy Dashboard**:
- `GET /api/dashboard/ecosystem` endpoint.
- Frontend: `PosterStatusCard`, `EcosystemFlowDiagram`,
  `AlertsFeed`, `SalesChart`.
- Caching va polling.
- Performance smoke (<1s).

**Sprint 4 (1 hafta) — F4.5 QA + Polish**:
- `qa-engineer` chrome-devtools test suite.
- AC mapping `docs/qa/phase-4-ac-mapping.md`.
- Lighthouse audit.
- `code-reviewer` audit.
- `ship` checklist.

---

## 8. Riskler va himoyalar

| Risk | Ehtimol | Ta'sir | Himoya |
|---|---|---|---|
| M:N migratsiya back-fill xato | Past | Yuqori (RBAC bug) | Idempotent `ON CONFLICT DO NOTHING`; staging smoke; rollback DDL `DROP TABLE user_locations` |
| `X-Active-Location` header forging | Past | O'rta | Backend har request da `principal.locationIds` ichida ekanini tekshiradi; aks holda 403 |
| Yandex STT IAM token leak | Past | Yuqori | Log sanitizer; testlar grep bilan tasdiqlaydi |
| Yandex STT down | O'rta | O'rta (voice ishlamaydi) | Foydalanuvchiga "Qayta sinab ko'ring" javob; matn yozish opsiya saqlanadi |
| Vertex intent parser xato (yog'/un noto'g'ri ajratadi) | O'rta | O'rta (noto'g'ri amal yaratiladi) | Tasdiq oqimi har action ni alohida tasdiq talab qiladi (F3.2) — user ko'radi va rad etadi |
| Product matching false positive ("un" Oliy navga yopishadi) | Yuqori | O'rta | Similarity threshold >= 0.7; pastroq bo'lsa clarification savol |
| Dashboard endpoint sekin | O'rta | O'rta | 10s cache + parallel queries + index'lar; performance smoke |
| Voice fayl tmp leak | Past | Past | `finally { unlink }` + nightly cron tmp tozalash |
| `pg_trgm` extension mavjud emas | Past | O'rta (matching ishlamaydi) | Migratsiyada `CREATE EXTENSION IF NOT EXISTS pg_trgm` |

---

## 9. References

- TZ.md §6, §11, §12, §13.
- ADR-0009 (AI write actions) — Faza-3.
- ADR-0011 (Telegram inline actions) — Faza-3.
- ADR-0012 (Multi-location users M:N) — yangi.
- ADR-0013 (Yandex STT) — yangi.
- ADR-0014 (Voice → AI → Action) — yangi.
- Faza-3 spec — `docs/specs/phase-3.md`.
- Yandex STT v3 docs:
  https://yandex.cloud/en/docs/speechkit/stt/api/transcribation-api-v3
- Yandex IAM tokens:
  https://yandex.cloud/en/docs/iam/operations/iam-token/create
