# ADIA ERP — Faza-2 Spetsifikatsiyasi

> Versiya: 1.0 · Sana: 2026-05-23 · Muallif: system-architect
> Asos: `docs/TZ.md` (§8.3, §12, §14), `docs/specs/phase-1-mvp.md` (§8.4),
> `docs/architecture/decisions.md` (D1–D6), egasining 2026-05-23 qarorlari.
> Holat: jamoa rahbari va loyiha egasi tasdig'iga.

Bu hujjat ADIA ERP **Faza-2** ning to'liq spetsifikatsiyasi. Faza-1 yakunlandi
(kommitlar `1a71dc6` gacha). Faza-2 uch yo'nalishni qamrab oladi:
1. **F2.1 — Dinamik min/max engine** (TZ §8.3): tungi cron sales agregat +
   recalc.
2. **F2.2 — AI assistant** (TZ §12): Vertex AI Gemini, read-only function
   calling, RBAC-scoped tools.
3. **F2.3 — Texnik qarz cleanup** (phase-1-mvp.md §8.4): dead enum, M:N PO,
   import warnings, JWT refresh, frontend `window.prompt` o'rniga dialog.

Arxitektura qarorlari: `docs/architecture/adr-0006-ai-tool-layer.md`,
`docs/architecture/adr-0007-dynamic-minmax-engine.md`.

---

## 1. Qamrov (scope)

### 1.1. Faza-2 ga KIRADI

- **F2.1 Dinamik min/max engine:**
  - Tungi `sales_stats_daily` agregat cron (`03:00 UTC`) — oxirgi N kunlik
    `sales` dan `avg_7d`, `avg_30d` to'ldiriladi.
  - Tungi `minmax_recalc` cron (`04:00 UTC`) — har
    `(location_id, product_id)` da `stock.minmax_mode='dynamic'` bo'lsa TZ
    §8.3 formulasi qo'llaniladi.
  - `PATCH /api/stock/minmax-mode` — PM/manager qator-darajada `manual` ↔
    `dynamic` toggle qiladi.
  - `POST /api/admin/recalc-minmax` (PM) — qo'lda trigger.
  - Default sozlamalar: `lead_time_days=2`, `review_days=2`,
    `safety_factor=1.3` (PM `locations` darajasida tahrirlaydi).
- **F2.2 AI assistant (read-only):**
  - Vertex AI Gemini client (`@google-cloud/vertexai`), model
    `gemini-2.5-flash`, region `europe-west1`.
  - Function-calling tool layer — 6 ta read-only tool (§3).
  - `POST /api/assistant/query` — chat endpoint, multi-turn.
  - `assistant_sessions` + `assistant_messages` jadvallar — sessiya tarixi
    va audit.
  - Dashboard tepasida chat UI (frontend).
  - RBAC delegatsiya: foydalanuvchining roli ostida tools ishlaydi.
- **F2.3 Texnik qarz cleanup:**
  - `0004_purchase_status_cleanup.sql` — dead enum qiymatlarni olib tashlash
    (`manager_approved`, `keeper_approved`).
  - `0003_recipes_purchase_orders_mn.sql` — `replenishment_purchase_orders`
    M:N jadval; `replenishment_requests.purchase_order_id` ustuni
    deprecated qilinadi (Faza-3 da olib tashlanadi).
  - `0005_import_warnings.sql` — Poster sync/BOM mismatch'larni
    `import_warnings` jadvaliga yozish.
  - JWT refresh token oqimi — access token 1h, refresh 30d.
  - Frontend `window.prompt` ↔ shadcn `Dialog` (input/confirm) migratsiya.

### 1.2. Faza-2 ga KIRMAYDI (Faza-3)

- AI assistant **write** buyruqlar (transfer/zayafka yaratish chat'dan) —
  Faza-3.
- AI assistant chat ichida grafik/chart render — Faza-3.
- Hot/cold product strategiyalar (mavsumiy/kunlik koeffitsent) — Faza-3.
- Telegram inline tugmali tasdiq oqimi — Faza-3.
- Poster write-back (ADIA → Poster yozuvi) — Faza-3.

### 1.3. Asosiy invariantlar (buzilmaydi — CLAUDE.md §6, Faza-1 dan davom)

1. Har `stock_movement` — atomar tranzaksiya.
2. Bitta `(product, location)` uchun bitta ochiq `replenishment_request`.
3. `stock.qty` hech qachon manfiy emas.
4. min/max har `(location_id, product_id)` juftligida.
5. RBAC har endpointda va har AI tool javobida — scope avtomatik filtrlanadi.
6. AI **yozish amalini bajarmaydi** (Faza-2 da). Har AI savol-javob
   `audit_log` ga yoziladi.
7. AI raqamlari **har doim** tool javobidan keladi — model o'zidan
   to'qib chiqarmaydi (hallucination guard, ADR-0006 §5).

---

## 2. Modullar

Har modul: scope + acceptance criteria.

### 2.1. F2.1 — Dinamik min/max engine

**Scope:**
- Sales agregat cron `sales-aggregate.ts` — har kuni `03:00 UTC` (Toshkent
  `08:00`).
  - Oxirgi 30 kunlik `sales` qatorlarini `(store_id, product_id, stat_date)`
    bo'yicha guruhlab `sales_stats_daily` ga `INSERT ... ON CONFLICT DO
    UPDATE` qiladi. `avg_7d` va `avg_30d` har qator uchun moving window
    bilan hisoblanadi.
  - Idempotent — bir kun ichida ikki marta ishga tushsa, natija o'zgarmaydi.
  - Audit: `poster_sync_log` emas, alohida log (yoki `audit_log` ga
    `entity='sales_stats_daily'` payload bilan).
- Recalc cron `minmax-recalc.ts` — har kuni `04:00 UTC`.
  - `stock` qatorlari ichidan `minmax_mode='dynamic'` bo'lganlarini topadi.
  - Har qator uchun `locations.lead_time_days`, `review_days`,
    `safety_factor` qiymatlarini oladi (lokatsiya darajasida).
  - `avg_daily := sales_stats_daily.avg_7d` (yetarli bo'lsa) yoki `avg_30d`
    (oxirgi 7 kunda sotuv yo'q bo'lsa). Agar ikkala ham `NULL` bo'lsa —
    qator o'tkazib yuboriladi (sales tarixi yo'q, ADR-0007 §4).
  - Formula:
    ```
    min_new := round(avg_daily * lead_time_days * safety_factor, 4)
    max_new := round(min_new + avg_daily * review_days, 4)
    ```
  - `UPDATE stock SET min_level=min_new, max_level=max_new` —
    `applyMovement` orqali EMAS (qty o'zgarmaydi). Har qator alohida
    tranzaksiya. `audit_log` ga `entity='stock.minmax', payload={old:{min,max},
    new:{min,max}, formula_inputs:{avg_daily,lead_time,review_days,
    safety_factor}}`.
  - Recalc tugagach, butun zanjirda `qty <= min_level` bo'lib qolgan
    qatorlar uchun replenishment scan'i (mavjud Faza-1 worker) avtomatik
    keyingi tsiklda yangi requestlar yaratadi.

**Toggle API:** `PATCH /api/stock/minmax-mode` — bitta `(location_id,
product_id)` qatorni `manual` ↔ `dynamic` o'zgartiradi. RBAC: PM yoki shu
location manageri.

**Manual override:** `manual` mode da PATCH /api/stock/minmax qo'lda
yozilgan min/max ni saqlaydi va recalc cron uni teginmaydi. Bu PM ga
"ushbu mahsulot uchun avtomatika ishlamasin" deyish imkonini beradi.

**Yangi joriy do'kon:** sales tarixi yo'q — cron qator o'tkazib yuboradi;
default (PM kiritgan) qiymatlar saqlanadi. Bu xulq-atvor avtomatik:
`avg_7d`/`avg_30d` `NULL` bo'lsa formula qo'llanmaydi.

**Acceptance:**
- AC2.1.1: Sotuv o'sgan do'konda `min_level` va `max_level` ertasiga ko'tariladi
  (TZ §15 AC#3). Test: 7 kunlik sotuv 2× ga oshirilsa, recalc ertasiga `min`
  ham ~2× ga oshadi.
- AC2.1.2: Sotuv tarixi yo'q (yangi do'kon yoki yangi mahsulot) — recalc qator
  o'tkazib yuboradi, default qoladi.
- AC2.1.3: `minmax_mode='manual'` qatorlar recalc'dan o'zgarmaydi.
- AC2.1.4: Har recalc o'zgarishi `audit_log` ga `entity='stock.minmax'` bilan
  yoziladi (eski/yangi qiymat + formula kirish).
- AC2.1.5: Recalc transaktsion — birorta `UPDATE` muvaffaqiyatsiz bo'lsa
  alohida qator rollback, qolgan qatorlar davom etadi.

### 2.2. F2.2 — AI assistant (read-only)

**Scope:**
- **Vertex client** — `apps/backend/src/integrations/vertex/client.ts`. Service
  account JSON `.env.GOOGLE_APPLICATION_CREDENTIALS` (path) yoki
  `VERTEX_SERVICE_ACCOUNT_JSON` (inline base64). Region `europe-west1`,
  model `gemini-2.5-flash`. `@google-cloud/vertexai` SDK.
- **Tool layer** — `apps/backend/src/integrations/vertex/tools/` — 6 ta
  function declaration (§3). Har tool — TypeScript funksiyasi; argument
  schema va executor.
- **Chat endpoint** — `POST /api/assistant/query`. Multi-turn: client
  `session_id` ni saqlasa, davomi shu session ichida ishlaydi.
- **Session storage** — `assistant_sessions` + `assistant_messages`
  (migratsiya §7.4).
- **System prompt builder** — `apps/backend/src/integrations/vertex/prompt.ts`.
  Foydalanuvchi roli, `location_id`, ruxsat etilgan tools ro'yxati va
  qoidalar (§3.4) jamlanadi.
- **Frontend chat panel** — dashboard tepasida `Sheet`/`Drawer` (shadcn).
  Multi-turn ko'rinish, "Loading" indikator, tool-call'larni "AI joriy
  qoldiqni tekshiryapti..." kabi statusda ko'rsatadi.

**RBAC delegatsiya modeli (ADR-0006 §3):**
- `ai_assistant` rol — Vertex chaqiruvlari uchun **texnik konteyner** (audit
  pattern), lekin **amalda scope** har doim foydalanuvchi rolidan keladi.
- Foydalanuvchi `pm` bo'lsa — tools butun zanjirni ko'radi; `store_manager`
  bo'lsa — faqat o'z do'koni; `raw_warehouse_manager` — faqat xom-ashyo
  ombori. Har tool executor `principal.locationId` va `principal.role` ni
  o'qib SQL `WHERE location_id = $1` ga qo'shadi.
- Tool javoblari **server tomonida** filtrlanadi — LLM ga butun ma'lumot
  hech qachon ko'rsatilmaydi. Bu prompt injection xavfini kamaytiradi
  (foydalanuvchi "ignore RBAC" desa ham model boshqa ma'lumotni ko'ra
  olmaydi).

**Audit:**
- Har `POST /api/assistant/query` chaqiruvi `audit_log` ga
  `entity='assistant_query', payload={session_id, user_question,
  tools_used:[...], response_text, latency_ms}` bilan yoziladi.
- `assistant_messages` jadvaliga rol-by-rol (user/model/tool) yoziladi —
  bu ham chat tarixi (UI uchun), ham audit (compliance uchun).

**Acceptance:**
- AC2.2.1: `pm` "Markaziy skladda qaysi mahsulotlar min'dan past?" deb so'rasa
  — javob to'g'ri (DB dagi haqiqiy qatorlarga mos), raqamlar gallyutsinatsiyasiz.
- AC2.2.2: `store_manager` "Do'kon 3 da qancha non bor?" deb so'rasa (lekin u
  Do'kon 1 manageri) — tool javobi avtomatik `403` yoki bo'sh natija; AI
  "Sizga ruxsat yo'q" deydi.
- AC2.2.3: AI write buyruqni rad etadi: "Transfer qiling" so'roviga AI
  "Faza-2 da men faqat o'qiy olaman" deydi (write tool yo'q, system prompt
  shunga ishora qiladi).
- AC2.2.4: Multi-turn — birinchi savol "Markaziy skladda non qancha?"; ikkinchi
  "Va Do'kon 1 da?" → session davom etadi, javob to'g'ri.
- AC2.2.5: Har query `audit_log` da; `assistant_messages` da rol/content
  bilan saqlangan.
- AC2.2.6: Latency p50 < 3s (Vertex + tool roundtrip), p95 < 6s.

### 2.3. F2.3 — Texnik qarz cleanup

**2.3.1. Dead enum cleanup (`0004`)**
- Maqsad: `purchase_order_status` enumdan `manager_approved` va
  `keeper_approved` qiymatlarni olib tashlash. M6 amalda ularni
  ishlatmaydi — `manager_approved_by`/`keeper_approved_by` ustunlari
  orqali ishlaydi.
- Strategiya (PostgreSQL enum cleanup pattern):
  1. Tekshirish: `SELECT count(*) FROM purchase_orders WHERE status IN
     ('manager_approved','keeper_approved')` — `0` bo'lishi shart.
  2. `ALTER TYPE purchase_order_status RENAME TO purchase_order_status_old`.
  3. `CREATE TYPE purchase_order_status AS ENUM ('draft','approved',
     'received','cancelled','rejected')`.
  4. `ALTER TABLE purchase_orders ALTER COLUMN status TYPE purchase_order_status
     USING status::text::purchase_order_status` (default'larni qayta
     yozish).
  5. `DROP TYPE purchase_order_status_old`.
- Migratsiya idempotent (`IF EXISTS`/`IF NOT EXISTS` qaerda mumkin bo'lsa).

**2.3.2. Multi-shortage M:N jadval (`0003`)**
- Maqsad: bir `replenishment_request` ga ko'p `purchase_order` bog'lash
  imkoni.
- Yangi jadval:
  ```sql
  CREATE TABLE replenishment_purchase_orders (
      replenishment_id BIGINT NOT NULL REFERENCES replenishment_requests(id)
          ON DELETE CASCADE,
      purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id)
          ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (replenishment_id, purchase_order_id)
  );
  ```
- Migratsiya **mavjud `replenishment_requests.purchase_order_id` ni**
  bog'liq M:N qatorlariga ko'chirib yozadi (back-fill):
  ```sql
  INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id, created_at)
  SELECT id, purchase_order_id, updated_at
    FROM replenishment_requests
   WHERE purchase_order_id IS NOT NULL;
  ```
- **`replenishment_requests.purchase_order_id` ustuni Faza-2 da olib
  tashlanmaydi** — backend code ko'chguncha deprecated marker qo'shiladi
  (`COMMENT ON COLUMN`). Faza-3 da olib tashlanadi.
- State machine kodda (`CHECK_PRODUCTION_INPUT → CREATE_PURCHASE_ORDER`
  action'i) endi `INSERT INTO replenishment_purchase_orders` qiladi va
  `request.purchase_order_id` ni ham yozadi (transition davri uchun).

**2.3.3. Import warnings (`0005`)**
- Maqsad: Poster sync va BOM import jarayonida yuzaga keladigan og'ohlantirishlarni
  bir joyga yig'ish (masalan, "ingredient unit Poster'da `kg`, ADIA da
  `pcs`", "menu mahsuloti ingredient qaytarmadi").
- Yangi jadval:
  ```sql
  CREATE TABLE import_warnings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source TEXT NOT NULL,           -- 'poster.bom', 'poster.leftovers', 'poster.sales', ...
      entity TEXT,                    -- 'product:123', 'storage:5', ...
      severity TEXT NOT NULL DEFAULT 'warning'
          CHECK (severity IN ('info','warning','error')),
      message TEXT NOT NULL,
      payload JSONB,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
- Backend M7 (Poster integratsiya) kodi har anomaliyada
  `INSERT INTO import_warnings` qiladi. PM dashboard ostida "Sync
  ogohlantirishlar" panel (frontend Faza-2 ichida).
- `GET /api/admin/import-warnings?resolved=` (PM).
- `POST /api/admin/import-warnings/:id/resolve` — `resolved=true` belgilash.

**2.3.4. JWT refresh tokens**
- Hozir: access token TTL = 7 kun (`apps/backend/src/auth/jwt.ts`). Bu uzoq —
  agar token o'g'irlansa, 7 kun mobaynida ishlaydi.
- Yangi: access TTL = 1h, refresh TTL = 30d.
- Yangi jadval (migratsiya alohida — `0006_refresh_tokens.sql`):
  ```sql
  CREATE TABLE refresh_tokens (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of the refresh token
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      user_agent TEXT,
      ip TEXT
  );
  CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX ix_refresh_tokens_active ON refresh_tokens(user_id)
      WHERE revoked_at IS NULL;
  ```
- API:
  - `POST /api/auth/login` → `{access_token, refresh_token, user}`.
  - `POST /api/auth/refresh` `{refresh_token}` → `{access_token,
    refresh_token}` (rotation — har refresh yangi token, eski
    `revoked_at` belgilanadi).
  - `POST /api/auth/logout` `{refresh_token}` → revoke.
- Frontend `axios` interceptor — 401 da `/api/auth/refresh` chaqiradi,
  yangi token bilan asl so'rovni qaytaradi.

**2.3.5. Frontend `window.prompt` o'rniga Dialog**
- Frontend kodda `window.prompt`/`window.confirm` ishlatilgan joylar
  (PATCH stock/minmax kabi inline inputlar) — shadcn `Dialog` +
  controlled state bilan almashtiriladi.
- A11y va tema (dark) bilan moslashish; mobile keyboard'da prompt'ning
  uglier bo'lishi yo'qoladi.

**Acceptance (F2.3):**
- AC2.3.1: `purchase_order_status` enum'da faqat 5 qiymat qoladi; mavjud
  qatorlar buzilmaydi.
- AC2.3.2: `replenishment_purchase_orders` jadvaliga back-fill qilingan;
  state machine yangi PO ni unga ham yozadi.
- AC2.3.3: Poster sync paytida anomaliya `import_warnings` ga yoziladi;
  PM dashboard'da ko'rinadi.
- AC2.3.4: Access token 1h, refresh 30d; `/auth/refresh` rotation bilan
  ishlaydi; eski refresh token revoke qilinsa qayta ishlatilmaydi.
- AC2.3.5: Frontend'da `window.prompt` qolmadi (grep tekshiruvi); barcha
  input dialog orqali.

---

## 3. AI assistant tool layer dizayni

To'liq dizayn: `docs/architecture/adr-0006-ai-tool-layer.md`.

### 3.1. Tool ro'yxati (Faza-2 da read-only)

Har tool — Vertex `FunctionDeclaration` ko'rinishida deklaratsiya, executor
TypeScript funksiyasi. Hammasi `principal: {userId, role, locationId}` ni
ichkaridan oladi (LLM bilmaydi — server inject qiladi). Har tool javobida
**raqamlar** va **identifikatorlar** (`location_id`, `product_id`) — model
keyingi turda ulardan foydalanishi uchun.

| Tool nomi | Argumentlar | Javob | RBAC scope |
|---|---|---|---|
| `get_stock` | `{location_id?: number, product_id?: number}` | `[{location_id, location_name, product_id, product_name, qty, min_level, max_level, unit, below_min: boolean}]` | non-pm: `location_id` foydalanuvchi bo'g'iniga qisiladi; pm: ixtiyoriy |
| `get_open_requests` | `{status?: string, location_id?: number}` | `[{id, product_name, requester_location_name, target_location_name, qty_needed, status, created_at}]` | non-pm: faqat foydalanuvchi bo'g'iniga `requester` yoki `target` bo'lgan requestlar |
| `get_production_plan` | `{date_from?: date, date_to?: date, status?: string}` | `[{id, product_name, qty, location_name, target_location_name, status, deadline}]` | non-pm: faqat `location_id` foydalanuvchi bo'g'iniga teng zayafkalar |
| `get_below_min` | `{location_id?: number}` | `[{location_id, location_name, product_id, product_name, qty, min_level, shortage: qty - min_level (negative)}]` | non-pm: foydalanuvchi bo'g'iniga qisiladi |
| `get_recent_movements` | `{location_id?: number, product_id?: number, limit?: number (default 20, max 100)}` | `[{id, product_name, from_location_name, to_location_name, qty, reason, created_at}]` | non-pm: faqat `from` yoki `to` foydalanuvchi bo'g'iniga teng harakatlar |
| `get_sales_summary` | `{date_from?: date, date_to?: date, location_id?: number, product_id?: number}` | `[{location_id, location_name, product_id, product_name, total_qty, total_revenue, days_in_range}]` | non-pm: foydalanuvchi bo'g'iniga qisiladi |

### 3.2. Tool executor shabloni

```ts
// apps/backend/src/integrations/vertex/tools/get_stock.ts
import type { ToolExecutor } from './types';

export const getStock: ToolExecutor<{location_id?: number; product_id?: number}> = {
  declaration: {
    name: 'get_stock',
    description: 'Returns current stock levels for one or more (location, product) pairs. Use when the user asks about on-hand qty, min/max thresholds, or whether something is below min.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location_id: { type: 'NUMBER', description: 'Location id; if omitted, returns all locations the caller is allowed to see' },
        product_id:  { type: 'NUMBER', description: 'Product id; if omitted, returns all products' },
      },
    },
  },
  async execute(args, principal, db) {
    // Server-side RBAC scope override: non-pm callers are pinned to their location.
    const scopedLocationId = principal.role === 'pm'
      ? args.location_id ?? null
      : principal.locationId;
    const rows = await db.query(`
      SELECT s.location_id, l.name AS location_name,
             s.product_id, p.name AS product_name,
             s.qty, s.min_level, s.max_level, p.unit,
             (s.qty <= s.min_level) AS below_min
        FROM stock s
        JOIN locations l ON l.id = s.location_id
        JOIN products  p ON p.id = s.product_id
       WHERE ($1::bigint IS NULL OR s.location_id = $1)
         AND ($2::bigint IS NULL OR s.product_id  = $2)
       ORDER BY l.name, p.name
       LIMIT 200
    `, [scopedLocationId, args.product_id ?? null]);
    return rows;
  },
};
```

Asosiy qoidalar:
- Har tool **SELECT-only** — `INSERT`/`UPDATE`/`DELETE` qatorlari yo'q
  (Faza-2 invariant 6).
- Tool javobi `LIMIT 200` (yoki `limit` argumenti, max 100) — uzun ro'yxat
  LLM kontekstini to'ldirib yubormasin.
- RBAC scope **arg'umentdan kelmaydi** — server tomonida principal'dan
  hosil bo'ladi.

### 3.3. Function-calling oqimi

```
1. Client: POST /api/assistant/query {messages:[{role:'user', content:'...'}], session_id?}
2. Backend: principal ni JWT'dan o'qiydi, system prompt'ni rolga moslab tuzadi.
3. Backend → Vertex: generateContent({contents, tools:[...declarations], systemInstruction})
4. Vertex → Backend: yo {text: '...'} (final) yoki {functionCall: {name, args}}
5. Agar functionCall:
     a. Backend: executor.execute(args, principal, db) → result
     b. assistant_messages ga {role:'tool', tool_name, args, result} yoziladi
     c. Backend → Vertex: generateContent (oldingi history + {role:'function', response:result})
     d. Vertex → Backend: yana text yoki yana functionCall (multi-call mumkin)
6. Final text qaytadi → audit_log + assistant_messages.
7. Response: {response: text, tool_calls: [{name,args,result_summary}], session_id}
```

- **Multi-call** — model bir savolga 3 tagacha tool chaqirishi mumkin (masalan,
  "Markaziy sklad va Do'kon 1 da non" — `get_stock` ikki marta yoki bitta
  marta ikki `location_id` bilan). Backend tsiklda Vertex'ni qayta-qayta
  chaqiradi.
- **Hard limit:** 5 ta tool call ketma-ket; undan ko'p bo'lsa "Murakkab
  savol — operatorga murojaat qiling" javobi.

### 3.4. System prompt shabloni

```
Siz ADIA ERP AI yordamchisisiz — non/qandolat ishlab chiqarish va ta'minot
zanjiri uchun. Sizning vazifangiz: foydalanuvchining savollariga joriy
ma'lumotlar bazasi holatiga asoslanib, ANIQ va QISQA javob berish.

Qoidalar:
1. RAQAMLAR HAR DOIM TOOL'DAN. O'zingizdan raqam, mahsulot nomi yoki
   miqdor to'qib chiqarmang. Agar tool javob bermasa — "ma'lumot yo'q" deng.
2. Faza-2 da siz FAQAT O'QIY OLASIZ. Transfer, zayafka, ostatka tuzatish
   kabi yozish amalini bajarmaysiz; foydalanuvchi shunday so'rasa, qaytib
   ayting: "Bu amalni Faza-3 da bajara olaman; hozircha qo'lda ekrandan
   bajaring."
3. Noaniq savolga aniqlashtiruvchi savol bering. Masalan: "Non" — qaysi
   non? Qaysi joyda?
4. Foydalanuvchi sizning rolingiz {ROLE}; sizning bo'g'iningiz nomi
   "{LOCATION_NAME}". Boshqa bo'g'inlar haqida so'rasangiz va sizda
   ko'rinmasa — "Sizga ruxsat yo'q" deyiladi.
5. Javob — o'zbek tilida (lotin), professional ohangda. Raqamlar mahalliy
   format: 1 234,56 kg.
6. Iloji bo'lsa, raqamlardan keyin {O'lchov} qo'shing (kg, l, pcs).

Mavjud tools: {TOOL_NAMES_AND_DESCRIPTIONS}
```

`{ROLE}`, `{LOCATION_NAME}`, `{TOOL_NAMES_AND_DESCRIPTIONS}` —
`prompt.ts` ichida principal va declarations'dan tuziladi.

---

## 4. API kontrakti (yangi endpointlar)

Format: Faza-1 §4 ga mos. JWT, RBAC, audit. Xato kodlari §4.10.

### 4.1. AI assistant

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| POST | `/api/assistant/query` | pm, *_manager | `{messages: [{role:'user'\|'model'\|'tool', content:string, tool_calls?}], session_id?: string}` → `{response: string, tool_calls: [{name, args, ok}], session_id, latency_ms}`. Session yangi bo'lsa yangi `session_id` qaytadi. |
| GET  | `/api/assistant/sessions` | pm, foydalanuvchi o'zi | `?user_id=&limit=&offset=` → `{items, total, limit, offset}`. PM hammasini, qolganlar — faqat o'z sessiyalarini. |
| GET  | `/api/assistant/sessions/:id` | pm, sessiya egasi | `{session, messages:[{role,content,tool_name?,created_at}]}` |

**Audit:** har `POST /api/assistant/query` `audit_log` ga
`entity='assistant_query', entity_id=<session_id>, payload={user_question,
tool_calls, response, latency_ms}` bilan.

**Rate limit (server-side):** har foydalanuvchi uchun 20 req/min, 200
req/soat. Vertex tarafdan ham `gemini-2.5-flash` 60 RPM (per project,
region). Birinchi limit ham, ikkinchi limit ham `429 RATE_LIMITED`
qaytaradi.

### 4.2. Dinamik min/max

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| PATCH | `/api/stock/minmax-mode` | pm, o'z bo'g'ini manageri | `{location_id, product_id, mode: 'manual'\|'dynamic'}` → `{stock}`. Audit. |
| POST  | `/api/admin/recalc-minmax` | pm | `{location_id?, product_id?}` (filtr) → `{updated_count, skipped_count, errors:[]}`. Sinxron ishlaydi (max 5s) yoki async job (>500 qator). |

### 4.3. Import warnings

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET   | `/api/admin/import-warnings` | pm | `?resolved=&source=&severity=&limit=&offset=` → `{items,total,limit,offset}` |
| POST  | `/api/admin/import-warnings/:id/resolve` | pm | → `{warning}` |

### 4.4. Auth (yangilangan)

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| POST | `/api/auth/login` | hammasi | `{email,password}` → `{access_token, refresh_token, user}`. Access 1h, refresh 30d. |
| POST | `/api/auth/refresh` | refresh token bilan | `{refresh_token}` → `{access_token, refresh_token}`. Rotation — eski revoke qilinadi. |
| POST | `/api/auth/logout` | refresh token bilan | `{refresh_token}` → `204`. Revoke. |
| GET  | `/api/auth/me` | autentifikatsiyalangan | (Faza-1) |

### 4.5. Yangi xato kodlari

`RATE_LIMITED` (429), `AI_TOOL_ERROR` (502 — Vertex muvaffaqiyatsiz),
`AI_INSUFFICIENT_CONTEXT` (422 — savol juda noaniq, 5 tool call'dan keyin
ham yechilmadi), `REFRESH_TOKEN_INVALID` (401), `REFRESH_TOKEN_REVOKED`
(401).

---

## 5. Sales agregat va dinamik min/max formulasi

To'liq dizayn: `docs/architecture/adr-0007-dynamic-minmax-engine.md`.

### 5.1. Sales agregat (`sales-aggregate.ts`)

**Cron:** `0 3 * * *` (har kuni `03:00 UTC` = `08:00 Toshkent`).

**Algoritm:**
```sql
-- Birinchi: kunlik agregat (oxirgi 31 kun, idempotent)
INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
SELECT s.store_id, s.product_id, date_trunc('day', s.sold_at)::date, sum(s.qty)
  FROM sales s
 WHERE s.sold_at >= current_date - interval '31 days'
 GROUP BY 1,2,3
ON CONFLICT (location_id, product_id, stat_date) DO UPDATE
   SET qty_sold = EXCLUDED.qty_sold;

-- Ikkinchi: avg_7d va avg_30d ni har qator uchun yangilash
UPDATE sales_stats_daily ssd
   SET avg_7d  = sub.a7,
       avg_30d = sub.a30
  FROM (
    SELECT ssd2.location_id, ssd2.product_id, ssd2.stat_date,
           avg(ssd3.qty_sold) FILTER (
               WHERE ssd3.stat_date BETWEEN ssd2.stat_date - 6  AND ssd2.stat_date
           ) AS a7,
           avg(ssd3.qty_sold) FILTER (
               WHERE ssd3.stat_date BETWEEN ssd2.stat_date - 29 AND ssd2.stat_date
           ) AS a30
      FROM sales_stats_daily ssd2
      JOIN sales_stats_daily ssd3
        ON ssd3.location_id = ssd2.location_id
       AND ssd3.product_id  = ssd2.product_id
     WHERE ssd2.stat_date >= current_date - 31
     GROUP BY ssd2.location_id, ssd2.product_id, ssd2.stat_date
  ) sub
 WHERE ssd.location_id = sub.location_id
   AND ssd.product_id  = sub.product_id
   AND ssd.stat_date   = sub.stat_date;
```

**Idempotent:** ikki marta ishga tushsa, natija o'zgarmaydi.

**Edge case:** mahsulot uchun `sales` qator yo'q (semi/raw) — agregatga
kirmaydi, recalc cron bu mahsulot uchun ham `avg_daily`'ni hisoblay
olmaydi → o'tkazib yuboriladi (xom-ashyo uchun dinamik min/max sotuvdan
emas, ishlab chiqarish rejasidan kelishi kerak — bu Faza-3 ko'rinishi,
hozircha xom-ashyo uchun `manual` ishlatiladi).

### 5.2. Recalc cron (`minmax-recalc.ts`)

**Cron:** `0 4 * * *` (`04:00 UTC` = `09:00 Toshkent`). Sales agregat
tugaganidan keyin.

**Algoritm:**
```ts
for each row in stock where minmax_mode = 'dynamic':
  loc = locations[row.location_id]
  stats = sales_stats_daily ORDER BY stat_date DESC LIMIT 1
            WHERE location_id = row.location_id AND product_id = row.product_id
  avg_daily = stats?.avg_7d ?? stats?.avg_30d
  if avg_daily is null or avg_daily < EPSILON (0.001):
      skip (write import_warning severity=info "no sales history")
      continue
  min_new = round(avg_daily * loc.lead_time_days * loc.safety_factor, 4)
  max_new = round(min_new + avg_daily * loc.review_days, 4)
  if min_new == row.min_level and max_new == row.max_level:
      continue  // no-op
  BEGIN
    UPDATE stock SET min_level = min_new, max_level = max_new, updated_at = now()
      WHERE location_id = row.location_id AND product_id = row.product_id
        AND minmax_mode = 'dynamic'  // guard against race with manual flip
    INSERT INTO audit_log (...) VALUES (...)
  COMMIT
```

- Har qator alohida tranzaksiya — bitta xatolik butun cron'ni yiqitmaydi.
- `WHERE minmax_mode = 'dynamic'` guard — manager qator-darajada `manual` ga
  almashtirgan paytda recalc oxirgi paytda uni teginmasin.
- `EPSILON` — juda kichik `avg_daily` (masalan, oyiga bitta sotuv) recalc'ga
  kirmasin; PM qo'lda boshqaradi.

### 5.3. Strategiyalar tanlovi (ADR-0007 §3)

- **`avg_7d` ustun manba** (oxirgi 7 kun) — mavsumiy yaqin o'tmish.
- Agar `avg_7d` `NULL` yoki `0` bo'lsa, fallback `avg_30d`.
- **EMA (Exponentially Moving Average)** muqobili Faza-3 da ko'rib chiqiladi.

### 5.4. Edge case'lar

- **Yangi mahsulot/yangi do'kon** (`sales` da yo'q): qator o'tkazib
  yuboriladi, default min/max qoladi (`manual` mode bo'lganidek).
- **Mahsulot sotuvi to'satdan tushib ketdi** (0 ga yaqin) — `min_new=0`,
  `max_new=0` bo'lishi mumkin → bu xatarli. Guard: agar yangi `max_new <
  EPSILON`, eski qiymat saqlanadi va `import_warnings` ga
  `severity=warning` yoziladi ("dynamic recalc would zero out min/max").
- **Mahsulot sotuvi to'satdan ko'paydi** (10× ga oshdi): tabiiy ravishda
  formula min/max ni 10× ga ko'taradi. Tekshiruv: `audit_log` da PM bu
  o'zgarishni ko'radi.

---

## 6. RBAC kengaytmasi

Faza-1 §6 matritsasi davom etadi. Yangi qatorlar:

| Resurs | pm | raw_wh_mgr | production_mgr | supply_mgr | central_wh_mgr | store_mgr | ai_assistant |
|---|---|---|---|---|---|---|---|
| `/api/assistant/query` | RW | RW | RW | RW | RW | RW | – |
| `/api/assistant/sessions` | R(hammasi) | R(o'z) | R(o'z) | R(o'z) | R(o'z) | R(o'z) | – |
| `/api/stock/minmax-mode` | W | W(own) | W(own) | W(own) | W(own) | W(own) | – |
| `/api/admin/recalc-minmax` | W | – | – | – | – | – | – |
| `/api/admin/import-warnings` | RW | – | – | – | – | – | – |
| `/api/auth/refresh` | hammasi (o'z token'i bilan) | | | | | | – |

**AI tool javobi RBAC qoidalari (qisqacha — to'liq ADR-0006 §3):**
- `pm`: cheklov yo'q, butun zanjir.
- Boshqa rollar: tool executor `WHERE location_id = principal.locationId`
  ga avtomatik qisadi. PM "Markaziy skladda nima bor?" desa, har bir
  location ni ko'radi; do'kon manageri xuddi shu savolni so'rasa, faqat
  o'z do'koniga nisbatan javob keladi.

`ai_assistant` rol — Faza-2 da **foydalanuvchi sifatida login qilmaydi**;
u faqat backend kodda audit pattern uchun (kelajakda kron orqali AI ishga
tushadigan stsenariyga tayyorgarlik).

---

## 7. Migratsiyalar

Tartib:
1. `0003_replenishment_purchase_orders_mn.sql` — M:N jadval + back-fill.
2. `0004_purchase_status_cleanup.sql` — dead enum tozalash.
3. `0005_import_warnings.sql` — yangi jadval.
4. `0006_assistant_sessions.sql` — AI sessions + messages.
5. `0007_refresh_tokens.sql` — JWT refresh tokens.

### 7.1. `0003_replenishment_purchase_orders_mn.sql`

```sql
CREATE TABLE replenishment_purchase_orders (
    replenishment_id  BIGINT NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (replenishment_id, purchase_order_id)
);
CREATE INDEX ix_rpo_replenishment ON replenishment_purchase_orders(replenishment_id);
CREATE INDEX ix_rpo_purchase      ON replenishment_purchase_orders(purchase_order_id);

-- Back-fill: existing single PO links are mirrored into the M:N table.
INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id, created_at)
SELECT id, purchase_order_id, updated_at
  FROM replenishment_requests
 WHERE purchase_order_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN replenishment_requests.purchase_order_id IS
    'DEPRECATED in Phase 2. Use replenishment_purchase_orders M:N table. '
    'Column kept for backward-compat during Phase 2 transition; removed in Phase 3.';
```

### 7.2. `0004_purchase_status_cleanup.sql`

```sql
-- Pre-check (raises if dead values are in use)
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM purchase_orders
     WHERE status IN ('manager_approved','keeper_approved');
    IF n > 0 THEN
        RAISE EXCEPTION 'Cannot drop dead enum values: % rows still use them', n;
    END IF;
END $$;

ALTER TYPE purchase_order_status RENAME TO purchase_order_status_old;
CREATE TYPE purchase_order_status AS ENUM (
    'draft','approved','received','cancelled','rejected'
);
ALTER TABLE purchase_orders
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE purchase_order_status
        USING status::text::purchase_order_status,
    ALTER COLUMN status SET DEFAULT 'draft';
DROP TYPE purchase_order_status_old;
```

### 7.3. `0005_import_warnings.sql`

```sql
CREATE TABLE import_warnings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source      TEXT NOT NULL,
    entity      TEXT,
    severity    TEXT NOT NULL DEFAULT 'warning'
                CHECK (severity IN ('info','warning','error')),
    message     TEXT NOT NULL,
    payload     JSONB,
    resolved    BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_import_warnings_unresolved ON import_warnings(created_at DESC)
    WHERE resolved = FALSE;
CREATE INDEX ix_import_warnings_source ON import_warnings(source, created_at DESC);
```

### 7.4. `0006_assistant_sessions.sql`

```sql
CREATE TABLE assistant_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT,                       -- auto-summarised from first user message
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_assistant_sessions_user ON assistant_sessions(user_id, last_message_at DESC);

CREATE TABLE assistant_messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('user','model','tool')),
    content     TEXT,                       -- text content; null for pure tool call
    tool_name   TEXT,                       -- set when role='tool' or model emits function call
    tool_args   JSONB,
    tool_result JSONB,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    latency_ms  INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_assistant_messages_session ON assistant_messages(session_id, created_at);
```

`gen_random_uuid()` uchun `pgcrypto` extension talab qilinishi mumkin —
migratsiyaning birinchi qatorida `CREATE EXTENSION IF NOT EXISTS pgcrypto`.

### 7.5. `0007_refresh_tokens.sql`

```sql
CREATE TABLE refresh_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    ip          TEXT
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX ix_refresh_tokens_active ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
```

---

## 8. Ochiq savol va qarorlar

### 8.1. Hal qilingan qarorlar (egasi, 2026-05-23)

| Qaror | Holat |
|---|---|
| AI provayder = Vertex AI Gemini, EMAS Claude API. | ✅ Hal qilindi. SDK `@google-cloud/vertexai`. |
| Region = `europe-west1` (Belgium). | ✅ Hetzner deploy bilan past latency. |
| Model = `gemini-2.5-flash`. | ✅ Function calling + 1–2s + arzon. |
| AI Faza-2 da read-only. | ✅ Write Faza-3 da. |
| Dinamik min/max formula = TZ §8.3. | ✅ `min = avg_daily × lead_time × safety`. |
| Default: `lead_time=2`, `review=2`, `safety=1.3`. | ✅ PM tahrirlaydi. |

### 8.2. Faza-2 ichida hal qilinishi kerak (texnik, bloklamaydi)

- **Vertex SDK auth strategiyasi:** service account JSON `.env` ichida
  inline base64 ko'rinishida (`VERTEX_SERVICE_ACCOUNT_JSON`) yoki path
  (`GOOGLE_APPLICATION_CREDENTIALS`)? Tavsiya: VPS deploy uchun **path**
  (`/etc/adia/vertex-sa.json`, `0600` permission); local dev uchun
  inline base64 ham qabul qilinadi. `backend-engineer` aniqlaydi.
- **AI session retention:** qancha vaqt saqlaydi? Tavsiya: `assistant_messages`
  90 kun (PM uchun `audit_log` doim qoladi); 90 kundan keyin
  `assistant_sessions` va `assistant_messages` nightly cleanup cron orqali
  o'chiriladi. Egasi tasdig'i kutiladi.
- **Vertex narx monitoringi:** kunlik token sarf'i `audit_log` dan
  hisoblanib, dashboard'da PM ga ko'rsatish kerakmi? Tavsiya: `GET
  /api/admin/ai-usage` (per day) — Faza-2 oxirida agar ehtiyoj bo'lsa
  qo'shiladi.
- **Min/max recalc cheklovi:** har do'kon × mahsulot ~ 5 000 qator = ~5 000
  UPDATE har tun. Bu PostgreSQL uchun yengil, lekin agar 50 000 qator
  bo'lsa — recalc batching kerak. Faza-2 boshida `EXPLAIN ANALYZE` bilan
  o'lchov.

### 8.3. Faza-3 ga qoldiriladigan ochiq savollar

- AI write buyruqlar — qaysi tools (`create_transfer`, `create_production_order`),
  qanday tasdiq oqimi (chat ichida tugma vs Telegram).
- Hot/cold product strategiya — mavsumiy koeffitsent, kunlik sotuv farqi
  (dushanba vs yakshanba).
- EMA (exponential moving average) `avg_7d` o'rniga.
- Telegram inline tasdiq tugmasi.
- Poster write-back.

---

## 9. Faza-2 yetkazib berish ketma-ketligi

> Bu — `planning-and-task-breakdown` uchun ko'rsatkich, to'liq reja
> emas. Tafsilot: team lead `system-architect` va `backend-engineer` /
> `frontend-engineer` orasida taqsimlaydi.

**Sprint 1 (1 hafta) — Texnik qarz cleanup**
- `0003`, `0004`, `0005`, `0007` migratsiyalar.
- JWT refresh oqimi (backend + frontend axios interceptor).
- `window.prompt` migratsiya (frontend).
- Import warnings paneli (frontend).

**Sprint 2 (1 hafta) — Dinamik min/max**
- `sales-aggregate.ts` cron.
- `minmax-recalc.ts` cron.
- `PATCH /api/stock/minmax-mode` + frontend toggle UI.
- `POST /api/admin/recalc-minmax`.
- E2E test: sotuv 2× → recalc → min/max 2×.

**Sprint 3 (2 hafta) — AI assistant**
- `0006_assistant_sessions.sql` migratsiya.
- Vertex client (`apps/backend/src/integrations/vertex/`).
- 6 ta tool implementatsiyasi.
- `POST /api/assistant/query` + multi-turn oqim.
- System prompt builder + RBAC scope.
- Frontend chat panel (dashboard tepasida).
- Audit + rate limit.
- AC2.2.1..AC2.2.6 testlari.

**Sprint 4 (3 kun) — Polish & launch**
- Hujjatlash (`docs/adia-poster-api.md` yangilanishi, ADR yakuniy).
- `code-reviewer` to'liq audit.
- Egaga `/ship` checklist.
