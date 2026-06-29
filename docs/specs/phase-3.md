# ADIA ERP — Faza-3 Spetsifikatsiyasi

> Versiya: 1.0 · Sana: 2026-05-23 · Muallif: system-architect
> Asos: `docs/TZ.md` (§6.8, §6.9, §12, §14), `docs/specs/phase-2.md`,
> `docs/architecture/adr-0006-ai-tool-layer.md`,
> `docs/architecture/adr-0008-vertex-sdk-migration.md`,
> egasining 2026-05-23 qarorlari (4 modulning hammasi + ML forecasting).
> Holat: jamoa rahbari va loyiha egasi tasdig'iga.

Bu hujjat ADIA ERP **Faza-3** ning to'liq spetsifikatsiyasi. Faza-2 ishlab
chiqarishga chiqarildi (read-only AI assistant, dinamik min/max,
texnik qarz cleanup). Faza-3 to'rt yo'nalishni qamrab oladi:

1. **F3.1 — Vertex SDK migratsiya** (`@google-cloud/vertexai` →
   `@google/genai`, ADR-0008, **muddat 2026-06-24**).
2. **F3.2 — AI write actions** (TZ §12): tasdiq oqimi orqali write
   tools (transfer, zayafka, ostatka, min/max, PO tasdiq).
3. **F3.3 — Telegram inline tugmalar** (TZ §6.9): "Tasdiqlash / Rad
   etish / Boshladim / Ko'rish" tugmalari Telegram xabarda.
4. **F3.4 — Forecasting + chuqur analitika** (TZ §14): ML asosida
   "X kunda tugaydi" bashorat, dashboard widget, AI tool
   `get_forecast`.

Arxitektura qarorlari:
- `docs/architecture/adr-0009-ai-write-actions.md`
- `docs/architecture/adr-0010-forecasting-approach.md`
- `docs/architecture/adr-0011-telegram-inline-actions.md`

---

## 1. Qamrov (scope)

### 1.1. Faza-3 ga KIRADI

- **F3.1 Vertex SDK migration:**
  - `@google-cloud/vertexai@^1.12.0` → `@google/genai@^latest`.
  - Affected: `apps/backend/src/integrations/vertex/{client.ts,tools.ts,systemPrompt.ts}`,
    `apps/backend/src/services/assistant.ts`, testlar va mock'lar.
  - **Yangi feature qo'shilmaydi** — bu pure refactor; foydalanuvchi UI
    o'zgarmaydi.
  - Muddat: **2026-06-24** (eski SDK deprecated bo'ladi).
  - Reja: ADR-0008 §4 ning 5 qadami.
- **F3.2 AI write actions:**
  - 6 ta yangi write tool: `create_replenishment_request`,
    `transfer_stock`, `mark_production_order_done`,
    `approve_purchase_order`, `update_minmax`,
    `create_production_order`.
  - **Tasdiq oqimi (two-phase commit)**: model write tool chaqirsa,
    server haqiqiy yozish o'rniga `assistant_actions` qatori yaratadi
    (status `pending`) va `pending_action` ni response'da qaytaradi.
    Foydalanuvchi UI'da "Tasdiqlaysizmi?" dialogini ko'radi →
    `POST /api/assistant/actions/:id/confirm` realda bajaradi yoki
    `/reject`.
  - **Timeout:** pending action 5 daqiqada `expired` ga o'tadi (cron yoki
    lazy-check).
  - **RBAC pre-check:** action yaratish bosqichida foydalanuvchi roli
    write tool'ni bajara olishi tekshiriladi; bo'lmasa action yaratilmaydi.
  - Audit har action va har exekutsiya uchun.
  - Yangi jadval: `assistant_actions` (§5.1).
- **F3.3 Telegram inline tugmalar:**
  - Grammy bot endi long polling (`bot.start()`) yoki webhook
    rejimida ishlaydi. Hozirgi outbox-only oqim saqlanadi (yo'naltirilgan
    push), lekin `callback_query` handler qo'shiladi.
  - Har xabar bilan birga **inline keyboard** yuborilishi mumkin
    (`notifications.inline_callback JSONB` maydoni).
  - Callback payload qisqa kod (`act:rid`, masalan `apprv:1234`) —
    Telegram'da `callback_data` 64 bayt limiti tufayli.
  - Foydalanuvchi tugma bossa → bot `from.id` ni `users.telegram_id` ga
    moslab `principal` ni yig'adi → RBAC tekshiruv → action bajariladi →
    bot `answerCallbackQuery` bilan foydalanuvchiga tasdiq beradi.
  - Audit: `telegram_callback_actions` jadval.
- **F3.4 Forecasting + analytika:**
  - **Yondashuv (ADR-0010 tavsiyasi):** **Prophet Python sidecar**
    (FastAPI mikroservis, Docker konteynerida, ichki tarmoqda) —
    qisqacha asos:
      - Bizning hajm kichik (~5 do'kon × ~300 mahsulot × kunlik = ~1
        500 ta vaqt qatori, har biri 30–365 kunlik). Bu Prophet'ning
        eng yaxshi ishlaydigan diapazoni.
      - Vertex AI Forecasting "tabular" sifatida ishlatish mumkin,
        lekin minimal ~$0.20/oy/qator + sozlash narxi va GCP'ga yana
        bog'liqlik beradi (~$300/oy faqat forecasting uchun).
      - TF.js LSTM — Node-native, lekin kichik datasetda Prophet'dan
        sezilarli pastroq aniqlik; deploy yengilroq, lekin
        boshqaruv/monitoring oson emas.
      - Prophet — Facebook OSS, MIT, **mavsumiy va trendni**
        tabiiy bo'lishi (haftalik/yillik komponentlar) — bizning
        domen (do'kon savdosida hafta tipidagi davriylik) bilan
        moslashadi.
  - **Cache strategiya:** har kuni `04:30 UTC` (recalc dan keyin)
    Python sidecar `(location_id, product_id)` har bir ochiq juftlik
    uchun **30 kunlik bashorat** chiqaradi → backend natijani
    `forecasts` jadvalga yozadi. Dashboard va AI tool DB'dan o'qiydi
    — Python sidecar real-time chaqirilmaydi.
  - **AI tool:** `get_forecast(product_id, location_id, days_ahead?)`
    DB'dagi `forecasts` ni o'qiydi.
  - **Dashboard widget:** "X kunda tugaydi" — har do'kon-mahsulot
    juftligi uchun `forecasts.expected_stockout_date` ko'rsatiladi.
  - **Edge case:** yangi mahsulot/do'kon, **30 kundan kam tarix** —
    sidecar `insufficient_data` qaytaradi; `forecasts` qatori
    yaratilmaydi; AI tool "yetarli ma'lumot yo'q" deydi.

### 1.2. Faza-3 ga KIRMAYDI (Faza-4 yoki keyingi)

- **Poster write-back** (ADIA → Poster) — keyingi faza.
- **Multi-tenant** — TZ §1 ga muvofiq, har doim bitta kompaniya.
- **Chuqur mavsumiy strategiya** (hot/cold product koeffitsenti) —
  Prophet seasonality bunga qisman javob beradi; aniq business rule
  Faza-4 da ko'riladi.
- **AI assistant chat ichida chart render** — Faza-2 §1.2 da
  qoldirilgan; Faza-3 ham ochiq qoldiramiz.
- **Vertex AI Forecasting** — bu Faza ichida muqobil sifatida ko'rib
  chiqildi, rad etildi (ADR-0010).
- **EMA `avg_7d` o'rniga** — minmax engine'ning takomillashuvi
  Faza-3 chegarasidan tashqarida.
- **AI write actions auto-execute** (tasdiqsiz) — har doim tasdiq
  zarur; "Yashil ro'yxat" (low-risk auto-confirm) Faza-4.

### 1.3. Asosiy invariantlar (buzilmaydi — CLAUDE.md §6, Faza-2 davom)

1. Har `stock_movement` — atomar tranzaksiya.
2. Bitta `(product, location)` uchun bitta ochiq `replenishment_request`.
3. `stock.qty` hech qachon manfiy emas.
4. min/max har `(location_id, product_id)` juftligida.
5. RBAC har endpointda va har AI tool javobida.
6. **AI write tool tasdiq talab qiladi** — model bevosita real DB
   o'zgarishini chaqira olmaydi.
7. AI raqamlari tool javobidan keladi (hallucination guard).
8. **Action idempotent** — `assistant_actions.id` bo'yicha bir action
   ikki marta `executed` ga o'tkazib bo'lmaydi.
9. **Telegram callback `from.id` → `users.telegram_id` mosligi
   majburiy** — agar mos kelmasa, action rad etiladi (spoofing
   himoyasi).
10. **Forecast cache** — model real-time ML chaqirmaydi; `forecasts`
    jadval DB-da kunlik yangilanadi.

---

## 2. Modullar

Har modul: scope + acceptance criteria.

### 2.1. F3.1 — Vertex SDK migration

**Scope (ADR-0008 §4 dan):**
- `npm install @google/genai && npm uninstall @google-cloud/vertexai`.
- `client.ts` ni qayta yozish:
  ```ts
  // Eski
  import { VertexAI } from '@google-cloud/vertexai';
  const vertex = new VertexAI({ project, location });
  const model = vertex.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const resp = await model.generateContent({ contents, tools, ... });

  // Yangi
  import { GoogleGenAI } from '@google/genai';
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const resp = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
    config: { tools, systemInstruction },
  });
  ```
- `extractToolCalls` va `extractResponse` (services/assistant.ts) —
  yangi response shape:
  - **Eski:** `resp.response.candidates[0].content.parts[].functionCall`.
  - **Yangi:** `resp.candidates[0].content.parts[].functionCall`
    (response wrap'i yo'q) yoki helper `resp.functionCalls`.
- **`FunctionDeclaration`** shape — Google standart, deyarli o'zgarmaydi
  (`name`, `description`, `parameters` JSON schema). `tools.ts` da
  `FunctionDeclarationSchemaType` enum nomi `Type` ga o'zgarishi
  mumkin — `source-driven-development` skill bilan rasmiy hujjat
  cross-check.
- Mock'lar va testlar (`apps/backend/test/services.assistant.test.ts`,
  `routes.assistant.test.ts`) yangi shape ga moslashtiriladi.
- `npm run vertex:test` real smoke — tool calling + nominal javob
  ishlashini tasdiqlash.
- Auth (`GOOGLE_APPLICATION_CREDENTIALS`) o'zgarmaydi.

**Acceptance:**
- AC3.1.1: `package.json` da `@google/genai` bor;
  `@google-cloud/vertexai` yo'q.
- AC3.1.2: `npm test` 100% o'tadi; coverage threshold pasaymaydi.
- AC3.1.3: `npm run vertex:test` real Vertex'ga ulanib tool-calling
  javobini muvaffaqiyatli qaytaradi.
- AC3.1.4: Foydalanuvchi UI o'zgarmadi (smoke: login + chat'da bir
  savol).
- AC3.1.5: Muddat 2026-06-24 dan oldin merge.

### 2.2. F3.2 — AI write actions

**Scope:**
- 6 ta yangi write tool (declarations va executors —
  `apps/backend/src/integrations/vertex/tools/`):

| Tool nomi | Argumentlar | Yo'nalish (DB amal) | RBAC pre-check |
|---|---|---|---|
| `create_replenishment_request` | `{product_id, requester_location_id, qty_needed}` | yangi `replenishment_requests` qatori (status `NEW`) | pm yoki shu `requester_location_id` manageri |
| `transfer_stock` | `{product_id, from_location_id, to_location_id, qty}` | `stock_movement` (reason `transfer`) | pm yoki `from_location_id` manageri |
| `mark_production_order_done` | `{production_order_id}` | PO status `done`, BOM chiqim + ishlab chiqilgan tovar kirimi (state machine) | pm yoki PO `location_id` (production) manageri |
| `approve_purchase_order` | `{purchase_order_id, role: 'manager'\|'keeper'}` | PO `manager_approved_by` yoki `keeper_approved_by` to'ldiriladi | pm yoki PO target_location manageri (manager); central_warehouse_manager (keeper) |
| `update_minmax` | `{location_id, product_id, min_level, max_level}` | `stock.min_level`/`max_level` yangilanadi; `minmax_mode` `manual` ga o'tadi | pm yoki shu location manageri |
| `create_production_order` | `{product_id, qty, location_id, deadline?}` | yangi `production_orders` qatori (status `planned`) | pm yoki production location manageri |

- **Action lifecycle (two-phase commit):**
  ```
  user → AI chat ("Filial-2 ga 5 ta tort jo'nat")
   ↓
  model → functionCall: transfer_stock {product_id:42, from:1, to:2, qty:5}
   ↓
  server: action_pending_check (RBAC pre-check) → 
        INSERT INTO assistant_actions (status='pending', args, summary='Markaziy sklad → Filial-2: 5 ta Tort #42')
   ↓
  server response: { response: 'Quyidagi amalni tasdiqlaysizmi?', pending_action: { action_id, tool_name, args, summary } }
   ↓
  UI dialog "Tasdiqlaysizmi?" → 
   ├─ POST /api/assistant/actions/:action_id/confirm
   │    → executor.executeWrite(args, principal) (real DB amal)
   │    → status='executed', result jsonb
   │    → audit_log
   │    → response: { ok, result }
   └─ POST /api/assistant/actions/:action_id/reject
        → status='rejected', audit_log
  ```
- **Timeout:** action `created_at + 5 min` ichida tasdiqlanmasa,
  status `expired`. Implementatsiya: confirm endpoint `created_at >
  now() - interval '5 min'` ni tekshiradi; alohida cron har 5 daqiqada
  pending → expired ga ko'chiradi (UI ham timer ko'rsatadi).
- **Concurrent confirm guard:** `UPDATE assistant_actions SET status =
  'executed' WHERE id = $1 AND status = 'pending' RETURNING *` —
  PostgreSQL row-lock atomar. Agar `0 rows affected`, deyarli
  bajarilgan/expired/rejected.
- **Multi-action paralel:** bitta session ichida bir vaqtda **bitta
  pending action** — yangi action yaratilsa, eski pending'lar
  avtomatik `superseded` ga o'tadi (yangi qaror ustun).
- **Tool executor interface kengayadi:**
  ```ts
  interface WriteToolExecutor<Args> {
    declaration: FunctionDeclaration;
    summarize(args: Args, principal: Principal): Promise<string>;
    canExecute(args: Args, principal: Principal): Promise<true | { reason: string }>;
    execute(args: Args, principal: Principal, db: Db): Promise<unknown>;
  }
  ```
  - `summarize` — o'zbekcha qisqa tasdiq matnini yaratadi (UI
    dialogida ko'rsatiladi). Misol: "Markaziy sklad → Filial-2:
    5 ta **Tort Napoleon** (32 → 27 / 5 ga)".
  - `canExecute` — RBAC + business invariant pre-check (masalan,
    `qty > from_location.stock.qty` bo'lsa rad).
  - `execute` — haqiqiy DB amal, audit.

- **AI tool declarations** modelga ko'rsatiladi, lekin server
  modelning chaqiruv natijasini **tasdiq oqimi** bilan ushlaydi.
- **Audit chain:**
  - `assistant_actions` qator — tool intent.
  - `audit_log` qator — `entity='assistant_action', entity_id=action.id,
    payload={tool, args, principal, summary, status}`.
  - Real action o'zining audit qatorini ham qoldiradi (masalan,
    `stock_movement` audit).
  - Chain: assistant_action → real action audit `caused_by` field
    bilan link.

**Acceptance:**
- AC3.2.1: `pm` "Filial-2 ga 5 ta Tort jo'nat" deydi → response'da
  `pending_action` keladi, `assistant_actions` da `pending` qator
  bor, `stock_movements` da **yangi qator yo'q**.
- AC3.2.2: PM `/confirm` chaqiradi → `stock_movements` da yangi qator,
  manba `stock.qty` kamaydi, qabul `stock.qty` oshdi,
  `assistant_actions.status='executed'`, audit yozildi.
- AC3.2.3: PM `/reject` chaqiradi → `status='rejected'`, hech qanday
  DB o'zgarish yo'q.
- AC3.2.4: 5 daqiqadan keyin tasdiqlash urinishi `410 ACTION_EXPIRED`
  qaytaradi.
- AC3.2.5: store_manager "Boshqa do'konga jo'nat" deb so'rasa, action
  yaratish bosqichida `canExecute` rad etadi va AI "Sizga ruxsat
  yo'q" javobini beradi (RBAC pre-check).
- AC3.2.6: Bitta action ni ikki marta `/confirm` chaqirilsa — ikkinchi
  marta `409 ACTION_NOT_PENDING` (idempotency).
- AC3.2.7: Negative stock himoyasi — `transfer_stock` `qty > stock.qty`
  bilan → action yaratiladi (model bilmaydi), lekin `/confirm`
  da `canExecute` rad etadi → `422 INSUFFICIENT_STOCK`.

### 2.3. F3.3 — Telegram inline tugmalar

**Scope:**
- Grammy bot rejimi:
  - **Dev:** long polling (`bot.start()`).
  - **Prod:** webhook (`bot.api.setWebhook(...)` + Express endpoint
    `POST /api/telegram/webhook`). Nginx tomonidan
    `https://api.adia-erp.uz/api/telegram/webhook` ga proxy.
- `notifications` jadvalga yangi maydon `inline_callback JSONB`:
  - Schema: `[{label: string, callback_data: string}]` (max 8 ta tugma).
  - Misol qator:
    ```json
    [
      {"label": "Ko'rish", "callback_data": "view:req:1234"},
      {"label": "Tezda bajarish", "callback_data": "fast:req:1234"}
    ]
    ```
- **Callback data format:** `<verb>:<entity>:<id>`, max 64 bayt
  (Telegram limit). Verbs: `view`, `apprv`, `rej`, `start`, `done`,
  `fast`. Entity: `req` (replenishment), `po` (purchase order),
  `prod` (production order).
- `telegramOutbox` worker xabarni yuborganda `inline_callback` bor
  bo'lsa, `reply_markup: { inline_keyboard: [[...]] }` qo'shadi.
- **`callback_query` handler:**
  ```ts
  bot.on('callback_query:data', async (ctx) => {
    const tgId = ctx.from.id;
    const user = await db.queryOne('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    if (!user) return ctx.answerCallbackQuery({ text: 'Foydalanuvchi topilmadi', show_alert: true });
    const principal = { userId: user.id, role: user.role, locationId: user.location_id };
    const [verb, entity, id] = ctx.callbackQuery.data.split(':');
    const result = await dispatchCallback(verb, entity, Number(id), principal);
    await db.insertOne('INSERT INTO telegram_callback_actions ...', { ... });
    await ctx.answerCallbackQuery({ text: result.message });
  });
  ```
- **Action turlari per entity:**

| Verb | Entity | Maqsad | RBAC |
|---|---|---|---|
| `view` | `req`, `po`, `prod` | Tafsilotni xabar sifatida qaytarish | har rol o'z scope ichida |
| `apprv` | `po` | Purchase order tasdiq (manager yoki keeper) | manager (request target), keeper (central wh) |
| `rej` | `po` | Purchase order rad | pm yoki manager |
| `start` | `prod` | Production order `in_progress` | production manager |
| `done` | `prod` | Production order `done` (state machine boshqa qadami) | production manager |
| `fast` | `req` | Replenishment requestni keyingi bosqichga (advance) | pm yoki target location manager |

- **Spoofing himoyasi:**
  - Telegram `callback_query.from.id` server tomonidan
    `users.telegram_id` ga aniq mos kelishi tekshiriladi.
  - Agar mos kelmasa — `answerCallbackQuery({text: "Ruxsat yo'q",
    show_alert: true})`.
  - Audit log har callback'ni yozadi (muvaffaqiyatli ham, rad
    etilgan ham).
- **`telegram_callback_actions` jadvali** (§5.2) har callback'ni
  yozadi: kim bossa, qachon, qaysi xabar uchun, natija.
- **Idempotency:** Telegram callback `update_id` ni cache qilamiz —
  agar bir xil update ikkinchi marta kelsa, faqat `answerCallbackQuery`
  qaytaramiz va real action ni qaytarmaymiz.

**Acceptance:**
- AC3.3.1: PO yaratilganda manager Telegram'ga "Tasdiq / Rad et"
  tugmali xabar oladi.
- AC3.3.2: Manager "Tasdiq" bossa → `purchase_orders.manager_approved_by`
  uning `user_id` si bilan to'ladi, `manager_approved_at` keladi.
  Bot "Tasdiqlandi" javobini beradi.
- AC3.3.3: Boshqa rolda bo'lgan foydalanuvchi (masalan store_manager)
  bot orqali "apprv:po:5" yuborsa (callback hujum) — bot rad etadi,
  audit'da `denied_by_rbac` qator.
- AC3.3.4: Production order "Boshladim" tugmasi → status `in_progress`.
- AC3.3.5: Bir xil `update_id` ikki marta kelsa — DB faqat bitta
  marta o'zgaradi.
- AC3.3.6: `telegram_callback_actions` da har callback yozilgan:
  `update_id, callback_data, from_telegram_id, user_id, decision, executed_at`.

### 2.4. F3.4 — Forecasting + analytika

**Scope:**
- **Python sidecar** (`apps/forecaster/`):
  - FastAPI (Python 3.12), Prophet (`prophet@^1.1`), PostgreSQL
    klient (`psycopg2-binary` yoki `asyncpg`).
  - Endpoint `POST /forecast` — argumentlar `{location_id?, product_id?,
    horizon_days?: 30}` → har `(location, product)` juftligi uchun
    Prophet fit + predict.
  - Endpoint `GET /healthz` — liveness.
  - Avtorizatsiya: ichki tarmoq + `Authorization: Bearer <SHARED_SECRET>`
    (env var `FORECASTER_SHARED_SECRET`).
  - Faqat ichki tarmoqdan (Nginx tashqariga ochmaydi).
- **Backend cron** (`apps/backend/src/workers/forecastCron.ts`):
  - Vaqt: `30 4 * * *` (har kuni `04:30 UTC` = `09:30 Toshkent`).
    `sales-aggregate` va `minmax-recalc` dan keyin.
  - Algoritm:
    1. `SELECT DISTINCT location_id, product_id FROM stock WHERE
       product_type = 'finished' OR product_type = 'semi'` (sotuv
       yoki produktsiya bor mahsulotlar).
    2. Sidecar'ga POST yuboradi (batch).
    3. Sidecar Prophet bilan har juftlik uchun:
       - **Input:** `SELECT stat_date, qty_sold FROM sales_stats_daily
         WHERE location_id=$1 AND product_id=$2 ORDER BY stat_date`.
       - **Pre-check:** `count >= 30` (30 kundan kam = insufficient).
       - **Prophet model:** weekly + yearly seasonality (yillik faqat
         tarix >= 365 kun bo'lsa).
       - **Output:** har keyingi 30 kunga `yhat` (predicted qty_sold),
         `yhat_lower`, `yhat_upper`.
    4. Backend `forecasts` jadvalga `INSERT ... ON CONFLICT DO
       UPDATE`.
    5. **`expected_stockout_date` hisoblanadi:**
       ```
       cumulative_demand = 0
       for d in next_30_days:
           cumulative_demand += yhat[d]
           if cumulative_demand >= current_stock.qty:
               stockout_date = d
               break
       ```
       Agar 30 kun ichida tugamasa — `null`.
- **`forecasts` jadvali** (§5.3):
  - Bitta qator: `(location_id, product_id)` — eng so'nggi 30 kunlik
    bashorat va `expected_stockout_date`. Eski qatorlar overwrite
    qilinadi.
- **AI tool `get_forecast`:**
  - Argumentlar: `{product_id?, location_id?, days_ahead?: 30}`.
  - Javob: `[{location_id, location_name, product_id, product_name,
    current_qty, expected_stockout_date, total_predicted_demand,
    confidence_low, confidence_high, computed_at}]`.
  - Edge: agar `forecasts` da yo'q — qatorda
    `forecast_status: 'insufficient_data'` qaytariladi.
  - RBAC: non-pm scope shu lokatsiyaga.
- **Dashboard widget** ("Tez tugaydigan tovarlar"):
  - Top 10: `SELECT ... FROM forecasts WHERE
    expected_stockout_date <= current_date + interval '7 days'
    ORDER BY expected_stockout_date ASC LIMIT 10`.
  - Recharts'da kichik bar yoki "shimcha" list.
- **Recalc trigger:** ixtiyoriy `POST /api/admin/forecasts/recalc`
  (PM) — sidecar'ni qo'lda chaqiradi.

**Acceptance:**
- AC3.4.1: Cron har tunda ishlaydi, `forecasts` jadvalda
  `(location, product)` juftliklar uchun yangi qatorlar (`computed_at`
  ko'tariladi).
- AC3.4.2: Yetarli tarix (>= 30 kun): `expected_stockout_date` aniq
  sana yoki `null` (30 kunda tugamaydi).
- AC3.4.3: Yetmaydigan tarix (< 30 kun): `forecasts` qatori
  yaratilmaydi (yoki status `insufficient`).
- AC3.4.4: AI tool `get_forecast` modelga kerakli qatorlarni
  qaytaradi; "X kunda tugaydi" javobida sana to'g'ri.
- AC3.4.5: Dashboard widget'da Top 10 tez tugaydigan tovarlar.
- AC3.4.6: Sidecar ishlamasa — backend cron `import_warnings` ga
  `severity='error'` yozadi, oxirgi `forecasts` qatorlari saqlanadi
  (degraded, not broken).
- AC3.4.7: Forecast aniqligi smoke test — sintetik dataset
  (30 kunlik konstant sotuv 10 unit/kun, `stock.qty=100`) → bashorat
  `expected_stockout_date ≈ today + 10 kun`.

---

## 3. API kontrakti (yangi endpointlar)

Format: Faza-2 §4 ga mos. JWT, RBAC, audit. Xato kodlari §3.6.

### 3.1. AI write actions

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| POST | `/api/assistant/query` | pm, *_manager | Faza-2'dan **kengayadi**: response `pending_action?: {action_id, tool_name, args, summary, expires_at}` bo'lishi mumkin. |
| POST | `/api/assistant/actions/:action_id/confirm` | action egasi (yaratuvchi) | → `{action_id, status:'executed', result: ...}` |
| POST | `/api/assistant/actions/:action_id/reject` | action egasi | → `{action_id, status:'rejected'}` |
| GET  | `/api/assistant/actions` | action egasi (pm hamma) | `?session_id=&status=` → `{items: [...], total}` |
| GET  | `/api/assistant/actions/:action_id` | egasi, pm | tafsilot |

Audit: `audit_log` (`entity='assistant_action'`).

Cheklov: bitta sessiyada bir vaqtda bitta `pending` action; yangisi
yaratilsa eskisi `superseded`.

### 3.2. Telegram webhook

| Metod | Endpoint | Auth | Request → Response |
|---|---|---|---|
| POST | `/api/telegram/webhook` | Telegram secret token (`X-Telegram-Bot-Api-Secret-Token`) | Grammy update payload → 200 OK |

Dev rejimi (long polling) endpoint ishlatilmaydi — bot `bot.start()`
ichki worker sifatida.

### 3.3. Forecasting

| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/forecasts` | pm, *_manager (scoped) | `?location_id=&product_id=&days_ahead=` → `[{...}]` |
| POST | `/api/admin/forecasts/recalc` | pm | `{location_id?, product_id?}` → `{queued: true, started_at}` (async) |
| GET  | `/api/admin/forecasts/health` | pm | sidecar'ning `/healthz` ni proxy qiladi |

### 3.4. Yangi xato kodlari

- `ACTION_NOT_FOUND` (404) — action ID mavjud emas.
- `ACTION_NOT_PENDING` (409) — action allaqachon executed/rejected/expired.
- `ACTION_EXPIRED` (410) — 5 daqiqa o'tdi.
- `ACTION_FORBIDDEN` (403) — action egasi emas.
- `INSUFFICIENT_STOCK` (422) — write action `canExecute` da rad etildi.
- `FORECAST_UNAVAILABLE` (503) — sidecar ishlamayapti.
- `INSUFFICIENT_FORECAST_DATA` (422) — yetarli tarix yo'q.
- `TELEGRAM_CALLBACK_DENIED` (403) — `from.id` mos kelmaydi yoki RBAC rad.

### 3.5. Tool declarations (AI write tools)

To'liq schema namunasi `tools/transfer_stock.ts`:
```ts
{
  name: 'transfer_stock',
  description: 'Transfer stock between two locations. Requires confirmation. Use when user says "send X to Y" or "transfer".',
  parameters: {
    type: 'OBJECT',
    properties: {
      product_id: { type: 'NUMBER', description: 'Product to transfer' },
      from_location_id: { type: 'NUMBER', description: 'Source location' },
      to_location_id: { type: 'NUMBER', description: 'Target location' },
      qty: { type: 'NUMBER', description: 'Quantity in product units' },
    },
    required: ['product_id', 'from_location_id', 'to_location_id', 'qty'],
  },
}
```

---

## 4. RBAC kengaytmasi

Faza-2 §6 matritsasi davom etadi. Yangi qatorlar:

| Resurs | pm | raw_wh | production | supply | central_wh | store | tg_callback |
|---|---|---|---|---|---|---|---|
| `/api/assistant/actions/:id/confirm` | W (har action) | W (o'z amal qila olishi) | W | W | W | W | – |
| `/api/assistant/actions/:id/reject` | W | W (o'z) | W | W | W | W | – |
| `/api/forecasts` | R (hamma) | R(own) | R(own) | R(own) | R(own) | R(own) | – |
| `/api/admin/forecasts/recalc` | W | – | – | – | – | – | – |
| `/api/telegram/webhook` | – | – | – | – | – | – | bot only |

**Write tool RBAC pre-check matritsasi** (kim qaysi tool'ni
chaqirsa bo'ladi):

| Tool | pm | raw_wh | production | supply | central_wh | store |
|---|---|---|---|---|---|---|
| `create_replenishment_request` | ✓ | ✓(own loc) | ✓ | ✓ | ✓ | ✓ |
| `transfer_stock` | ✓ | ✓(from=own) | ✓(from=own) | ✓(from=own) | ✓(from=own) | – |
| `mark_production_order_done` | ✓ | – | ✓(own loc) | – | – | – |
| `approve_purchase_order` | ✓ | – | – | – | ✓(keeper role) | ✓(manager role) |
| `update_minmax` | ✓ | ✓(own) | ✓(own) | ✓(own) | ✓(own) | ✓(own) |
| `create_production_order` | ✓ | – | ✓(own) | – | – | – |

**Telegram callback** har doim foydalanuvchi roli ostida (callback
`from.id` → `users.telegram_id` orqali lookup), shuning uchun action
ham shu rol matritsasiga bo'ysunadi.

---

## 5. Migratsiyalar

Tartib:
1. `0009_assistant_actions.sql` — yangi jadval.
2. `0010_telegram_callbacks.sql` — `notifications.inline_callback`
   ustun + `telegram_callback_actions` jadvali.
3. `0011_forecasts.sql` — `forecasts` jadval.

### 5.1. `0009_assistant_actions.sql`

```sql
CREATE TYPE assistant_action_status AS ENUM (
    'pending','executed','rejected','expired','superseded'
);

CREATE TABLE assistant_actions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_name       TEXT NOT NULL,
    args            JSONB NOT NULL,
    summary         TEXT NOT NULL,
    status          assistant_action_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at    TIMESTAMPTZ,
    executed_at     TIMESTAMPTZ,
    expired_at      TIMESTAMPTZ,
    rejected_at     TIMESTAMPTZ,
    result          JSONB,
    error           TEXT
);
CREATE INDEX ix_assistant_actions_session ON assistant_actions(session_id, created_at DESC);
CREATE INDEX ix_assistant_actions_user_pending
    ON assistant_actions(user_id, created_at DESC)
    WHERE status = 'pending';
CREATE INDEX ix_assistant_actions_pending_expiry
    ON assistant_actions(created_at)
    WHERE status = 'pending';
```

### 5.2. `0010_telegram_callbacks.sql`

```sql
ALTER TABLE notifications
    ADD COLUMN inline_callback JSONB;

COMMENT ON COLUMN notifications.inline_callback IS
    'Array of [{label, callback_data}] for Telegram inline keyboard. '
    'Phase 3 only — older rows have NULL.';

CREATE TABLE telegram_callback_actions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    update_id           BIGINT NOT NULL UNIQUE,
    callback_data       TEXT NOT NULL,
    from_telegram_id    BIGINT NOT NULL,
    user_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
    notification_id     BIGINT REFERENCES notifications(id) ON DELETE SET NULL,
    decision            TEXT NOT NULL
                        CHECK (decision IN ('executed','denied_by_rbac','denied_unknown_user','error','duplicate')),
    target_entity       TEXT,
    target_id           BIGINT,
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_tg_cb_user ON telegram_callback_actions(user_id, created_at DESC);
CREATE INDEX ix_tg_cb_target ON telegram_callback_actions(target_entity, target_id);
```

### 5.3. `0011_forecasts.sql`

```sql
CREATE TABLE forecasts (
    location_id             BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    product_id              BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    horizon_days            INTEGER NOT NULL DEFAULT 30,
    daily_predictions       JSONB NOT NULL,  -- [{date, yhat, yhat_lower, yhat_upper}, ...]
    total_predicted_demand  NUMERIC(14,4) NOT NULL,
    expected_stockout_date  DATE,            -- NULL if no stockout in horizon
    current_qty             NUMERIC(14,4) NOT NULL,
    confidence_low          NUMERIC(14,4),
    confidence_high         NUMERIC(14,4),
    computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    model_version           TEXT,            -- 'prophet@1.1.5' etc
    PRIMARY KEY (location_id, product_id)
);
CREATE INDEX ix_forecasts_stockout
    ON forecasts(expected_stockout_date)
    WHERE expected_stockout_date IS NOT NULL;
CREATE INDEX ix_forecasts_computed_at ON forecasts(computed_at DESC);
```

---

## 6. Ochiq savol va qarorlar

### 6.1. Hal qilingan qarorlar (egasi, 2026-05-23)

| Qaror | Holat |
|---|---|
| Faza-3 to'rt modulning hammasi (F3.1..F3.4) ham bajariladi. | ✅ Hal qilindi. |
| Forecasting yondashuvi = ML asosida (Prophet / LSTM / Vertex). Arxitekt tanlasin. | ✅ ADR-0010: Prophet sidecar tanlandi (asos: kichik dataset, OSS, mavsumiy seasonality, narx). |
| AI write — har doim tasdiq bilan. | ✅ Faza-2 §1.2 dan davom (tasdiqsiz "yashil ro'yxat" Faza-4 ga). |
| Telegram inline tugmalar = TZ §6.9 ("keyingi faza" Faza-3 deb e'lon qilindi). | ✅ Hal qilindi. |

### 6.2. Faza-3 ichida hal qilinishi kerak (texnik, bloklamaydi)

- **Sidecar deploy:** Docker compose ichida `forecaster` xizmat
  bo'ladimi yoki alohida PM2 jarayon? Tavsiya: Docker (Python
  bog'liqliklari Node muhitiga sig'maydi). DevOps qaror.
- **Telegram webhook URL** (prod): `api.adia-erp.uz` domeni HTTPS
  kerak (Telegram majburiy). Nginx sertifikati DevOps ishi.
- **Sidecar SLA:** sidecar ishlamasa — dashboard widget'da
  "Forecast ma'lumotlari yangilanmadi (1 kun)" warning ko'rsatish
  kerakmi? Tavsiya: ha, frontend uchun `forecasts.computed_at` ni
  ko'rsatamiz; >24h eski bo'lsa "ESKI" badge.
- **Prophet model versionlash:** `model_version='prophet@1.1.5'` —
  v2 ga ko'tarsak `forecasts` qatorlari avtomatik invalidatsiya
  bo'lishi kerakmi? Tavsiya: keyingi cron run avtomatik
  overwrite — alohida invalidate kerak emas.
- **Action timeout (5 daqiqa)** — kerak bo'lsa egadan boshqa qiymat
  kiritish (10 daqiqa, soat). Tavsiya: hozir 5 min, monitor qilamiz.

### 6.3. Faza-4 ga qoldiriladigan ochiq savollar

- AI **auto-confirm** (low-risk yashil ro'yxat) — masalan
  `update_minmax` ni manual da PM avtomatik tasdiq qoldirsin.
- Poster **write-back** (ADIA → Poster).
- Hot/cold product koeffitsenti (Prophet'dan tashqari biznes rule).
- AI chat ichida chart render.
- Multi-pending actions (bitta sessiyada parallel).
- Vertex AI Forecasting'ga o'tish — agar dataset hajmi 10× ga oshsa.
- Real-time forecast (cache emas) — hozir kunlik yetadi.

---

## 7. Faza-3 yetkazib berish ketma-ketligi

> `planning-and-task-breakdown` uchun ko'rsatkich. Team lead
> taqsimlaydi.

**Sprint 0 (bu hujjat) — planning**
- Spec yozildi.
- 3 ta ADR yozildi.
- Egasi tasdig'i.

**Sprint 1 (1 hafta) — F3.1 Vertex SDK migration (MUDDAT 2026-06-24)**
- `@google/genai` o'rnatish, `@google-cloud/vertexai` olib tashlash.
- `client.ts` qayta yozildi.
- `extractToolCalls`, `extractResponse` refactor.
- Mock'lar va testlar yangilandi.
- `npm run vertex:test` smoke yashil.
- `code-reviewer` audit.

**Sprint 2 (2 hafta) — F3.2 AI write actions**
- `0009_assistant_actions.sql` migratsiya.
- 6 ta write tool executor (`WriteToolExecutor` interface).
- `summarize` va `canExecute` har biriga.
- Assistant service kengaytmasi (pending action oqimi).
- 3 ta yangi endpoint (`/confirm`, `/reject`, `/actions`).
- Pending expiry cron.
- Frontend tasdiq dialog (shadcn).
- Unit + integration testlar (AC3.2.1..AC3.2.7).
- `code-reviewer` audit.

**Sprint 3 (1.5 hafta) — F3.3 Telegram inline tugmalar**
- `0010_telegram_callbacks.sql` migratsiya.
- Grammy bot start + webhook konfiguratsiyasi.
- `callback_query` handler + dispatcher.
- Outbox `inline_callback` rendering.
- Spoofing himoyasi + idempotency (`update_id` UNIQUE).
- 6 ta callback verb (view, apprv, rej, start, done, fast).
- Testlar (AC3.3.1..AC3.3.6).
- `code-reviewer` audit.

**Sprint 4 (2 hafta) — F3.4 Forecasting**
- `0011_forecasts.sql` migratsiya.
- Python sidecar (FastAPI + Prophet) scaffold.
- Docker compose entry.
- Backend cron `forecastCron.ts`.
- `expected_stockout_date` hisoblash.
- `get_forecast` AI tool.
- Dashboard widget.
- AC3.4.1..AC3.4.7 testlar.
- `code-reviewer` audit.

**Sprint 5 (3 kun) — Polish & launch**
- Hujjatlash (ADR yakunlash, API doc yangilanishi).
- `ship` checklist.
- Hetzner deploy + sidecar Docker.
- Smoke + UAT.

---

## 8. Riskler va himoyalar

| Risk | Ehtimol | Ta'sir | Himoya |
|---|---|---|---|
| Vertex SDK migratsiya tool calling shape bug'i | O'rta | Yuqori (assistant ishlamaydi) | To'liq mock + smoke test + sprint-1 da prioritet |
| Write action paralel confirm race | Past | O'rta (duplicate amal) | PostgreSQL `UPDATE ... WHERE status='pending' RETURNING` atomar |
| Telegram callback spoofing | Past | Yuqori (boshqa rol PO tasdiqlaydi) | `from.id` ↔ `users.telegram_id` aniq match; audit log |
| Prophet sidecar ishlamayapti | O'rta | Past (dashboard widget bo'sh) | `import_warnings` + degraded mode; oxirgi `forecasts` qatori 24h saqlanadi |
| Forecast aniqligi past (kichik dataset) | Yuqori | O'rta (PM ishonchsizlik) | `confidence_low/high` UI'da ko'rsatish; `insufficient_data` rejimida `null` qaytarish |
| AI action timeout user UX'ga zarar | Past | Past | UI'da timer; 5 min default — egasi qaror keyinroq |
| `@google/genai` mavjudligi/relizlari ahromli | Past | Yuqori | Faza-3 sprint-1 boshida real install + smoke; agar paket muammoli — ADR-0008 da fallback |

---

## 9. References

- TZ.md §6.8, §6.9, §12, §14.
- ADR-0006 (AI tool layer).
- ADR-0008 (Vertex SDK migration).
- ADR-0009 (AI write actions) — yangi.
- ADR-0010 (Forecasting approach) — yangi.
- ADR-0011 (Telegram inline actions) — yangi.
- Faza-2 spec — `docs/specs/phase-2.md`.
