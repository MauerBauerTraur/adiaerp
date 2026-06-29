# ADR-0011 — Telegram Inline Callback Actions

> Status: **Accepted** · Date: 2026-05-23 · Author: system-architect
> Relates: TZ §6.9 (Telegram bildirishnoma + inline tugmalar),
> spec `docs/specs/phase-3.md` §2.3, ADR-0009 (AI write actions).
> Owners decision (2026-05-23): Faza-3 da Telegram inline tugmalari
> joriy etiladi.

## Kontekst

Faza-1/2 da Grammy bot orqali Telegram **outbox-only push** ishlaydi:
- Yangi PO, replenishment, production tayyor — tegishli rolga
  xabar.
- 24h ichida dedupe (`telegramOutbox` worker).
- **Foydalanuvchi javob bera olmaydi** — bot bir yo'nalishli.

TZ §6.9 va Faza-3 reja **inline tugmali tasdiq** ni qo'shadi —
xabar ostida "Tasdiqlash / Rad etish / Ko'rish / Boshladim"
tugmalari, foydalanuvchi tugma bossa amal Telegram orqali
darhol bajariladi.

Texnik talablar:
- Grammy bot endi `callback_query` qabul qilsin.
- Spoofing himoyasi (boshqa Telegram foydalanuvchi callback
  yubora olmasin).
- RBAC — har callback foydalanuvchi roli ostida bajariladi.
- Audit — har callback `telegram_callback_actions` jadvalda.
- Idempotency — bir xil `update_id` ikki marta kelmasin.
- Long polling (dev) va webhook (prod) ikkala rejim ham.

## Qaror

### 1. Bot deploy rejimi

**Development:** Long polling (`bot.start()`).
- Pluslari: SSL kerak emas, lokal dev oson.
- `apps/backend/src/integrations/telegram/bot.ts` ichida
  `if (process.env.NODE_ENV !== 'production') await bot.start()`.
- Bot worker sifatida ishga tushiriladi (server qayta yuklanganda
  davom etadi).

**Production:** Webhook.
- Pluslari: cheksiz scalable, server resursini kam ishlatadi,
  Telegram yangi update'ni darhol push qiladi.
- `POST /api/telegram/webhook` Express endpoint —
  `bot.handleUpdate(req.body)`.
- `bot.api.setWebhook('https://api.adia-erp.uz/api/telegram/webhook',
    { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET })`.
- Telegram har webhook chaqiruvda `X-Telegram-Bot-Api-Secret-Token`
  header beradi — server tekshiradi.
- Nginx HTTPS proxy.

**Konfiguratsiya tanlovi (env):**
```env
TELEGRAM_MODE=webhook        # 'webhook' | 'longpoll'
TELEGRAM_WEBHOOK_URL=https://api.adia-erp.uz/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<random 64 char>
```

### 2. Outbox kengaytmasi — `inline_callback`

`notifications` jadvalga yangi ustun:
```sql
ALTER TABLE notifications ADD COLUMN inline_callback JSONB;
```

Format:
```json
[
  {"label": "Tasdiqlash", "callback_data": "apprv:po:7"},
  {"label": "Rad etish",  "callback_data": "rej:po:7"},
  {"label": "Ko'rish",    "callback_data": "view:po:7"}
]
```

`telegramOutbox` worker xabarni yuborganda:
```ts
const opts: SendMessageOptions = {
  parse_mode: 'HTML',
};
if (notification.inline_callback) {
  opts.reply_markup = {
    inline_keyboard: chunkButtons(notification.inline_callback, 2), // 2 per row
  };
}
await bot.api.sendMessage(user.telegram_id, notification.message, opts);
```

### 3. Callback data format

Telegram **`callback_data` 64 bayt limit** — qisqa kod kerak.

Format: `<verb>:<entity>:<id>`

| Verb | Ma'no | Misol |
|---|---|---|
| `view` | tafsilot ko'rsatish (alohida xabar) | `view:po:7` |
| `apprv` | tasdiqlash | `apprv:po:7` |
| `rej` | rad etish | `rej:po:7` |
| `start` | boshlash (production order) | `start:prod:42` |
| `done` | tugatish (production order) | `done:prod:42` |
| `fast` | replenishment requestni keyingi qadamga (advance) | `fast:req:101` |

| Entity | Ma'no |
|---|---|
| `po` | purchase_orders |
| `prod` | production_orders |
| `req` | replenishment_requests |
| `mov` | stock_movements (faqat `view`) |

Maksimal uzunlik: `done:prod:9999999` = 18 bayt — limit ichida.

### 4. Callback handler oqimi

```ts
bot.on('callback_query:data', async (ctx) => {
  // 1. Idempotency check
  const updateId = ctx.update.update_id;
  const dup = await db.queryOne(
    'SELECT id FROM telegram_callback_actions WHERE update_id = $1',
    [updateId]);
  if (dup) {
    await ctx.answerCallbackQuery({ text: 'Allaqachon qayta ishlangan' });
    return;
  }

  // 2. User lookup by telegram_id
  const tgId = ctx.from.id;
  const user = await db.queryOne(
    'SELECT id, role, location_id FROM users WHERE telegram_id = $1 AND active = TRUE',
    [tgId]);
  if (!user) {
    await db.insertOne(/* telegram_callback_actions */ {
      update_id: updateId,
      callback_data: ctx.callbackQuery.data,
      from_telegram_id: tgId,
      decision: 'denied_unknown_user',
    });
    await ctx.answerCallbackQuery({ text: 'Foydalanuvchi topilmadi', show_alert: true });
    return;
  }

  // 3. Parse + dispatch
  const [verb, entity, idStr] = ctx.callbackQuery.data.split(':');
  const targetId = Number(idStr);
  const principal = { userId: user.id, role: user.role, locationId: user.location_id };

  try {
    const result = await dispatchCallback(verb, entity, targetId, principal);
    await db.insertOne(/* telegram_callback_actions */ {
      update_id: updateId, callback_data: ctx.callbackQuery.data,
      from_telegram_id: tgId, user_id: user.id,
      target_entity: entity, target_id: targetId,
      decision: 'executed',
    });
    await ctx.answerCallbackQuery({ text: result.message });
    if (result.followUpMessage) {
      await bot.api.sendMessage(tgId, result.followUpMessage, { parse_mode: 'HTML' });
    }
  } catch (err) {
    const decision = err.code === 'RBAC' ? 'denied_by_rbac' : 'error';
    await db.insertOne(/* telegram_callback_actions */ {
      update_id: updateId, callback_data: ctx.callbackQuery.data,
      from_telegram_id: tgId, user_id: user.id,
      target_entity: entity, target_id: targetId,
      decision, error: err.message,
    });
    await ctx.answerCallbackQuery({ text: err.userMessage ?? 'Xato', show_alert: true });
  }
});
```

### 5. Dispatch matritsasi (verb × entity → action)

| verb:entity | Action | Required role |
|---|---|---|
| `view:po` | Send detail message (PO summary) | har kim (scope ichida) |
| `apprv:po` | `PATCH purchase_orders.manager_approved_by` yoki `keeper_approved_by` (rolga qarab) | manager (target loc), keeper (central wh) |
| `rej:po` | `purchase_orders.status='rejected'` | pm, manager |
| `view:prod` | Detail | har kim (scope) |
| `start:prod` | `production_orders.status='in_progress'` | production manager |
| `done:prod` | State machine advance (BOM chiqim + kirim) | production manager |
| `view:req` | Detail | har kim (scope) |
| `fast:req` | Replenishment request advance | pm, target loc manager |
| `view:mov` | Movement detail | har kim (scope) |

`dispatchCallback` ichida `canExecute` (ADR-0009'dan
qarz) chaqiriladi. Agar rad etilsa — `err.code='RBAC'`,
`decision='denied_by_rbac'`.

### 6. Spoofing himoyasi

**Hujum vektorlari:**
1. Yomon niyatli foydalanuvchi `callback_data` ni boshqa Telegram
   profil bilan yuborishi.
2. Eski xabarda tugma — boshqa user uchun mo'ljallangan.
3. Bot Telegram API'ga to'g'ridan-to'g'ri "fake" callback yuborish
   (Telegram ichkarisida emas, lekin server-side).

**Himoyalar:**
- **`from.telegram_id` ↔ `users.telegram_id` qattiq match** — agar
  user yo'q yoki `active=FALSE`, callback rad etiladi.
- **RBAC qayta tekshiruv** — har dispatch ichida `canExecute`.
  Hatto user bor bo'lsa ham, target_id uning rol/scope ichida
  emasligi tekshiriladi.
- **Webhook secret** (prod) — Telegram'dan kelganligini
  tasdiqlaydi.
- **Idempotency** — `update_id` UNIQUE, takror chiqishi yo'q.

Eslatma: bot xabarni `tg_id=A` ga yuboradi va `apprv:po:7` tugma
bilan. Agar A foydalanuvchi rolida shu PO ni tasdiqlay olmasa
(masalan, role o'zgargan) — RBAC rad etadi. Bu **rol o'zgarishi
posle xabarni yuborish** holatini ham yopib turadi.

### 7. RBAC matritsasi (Telegram callback)

Faza-3 spec §4 ga mos. Asosiy farq: bu yerda **agent yo'q**
(assistant emas), foydalanuvchi to'g'ridan-to'g'ri. Shuning uchun:

- `apprv:po` (manager) — bu PO target_location manageri.
  ```sql
  -- canExecute pseudo
  IF principal.role = 'pm' THEN allow
  ELSIF principal.role IN ('store_manager','supply_manager',...)
        AND principal.locationId = (SELECT requester_location_id FROM purchase_orders WHERE id=$1)
        THEN allow
  ELSE deny
  ```
- `apprv:po` (keeper) — bu central_warehouse_manager.
  Aniqlash: PO o'zining `manager_approved_by` allaqachon to'lganmi?
  Agar ha — keeper qadami; agar yo'q — manager qadami. Bot
  ikki marta yuborishi mumkin (avval manager'ga, manager bossa
  keyin keeper'ga).
- `start:prod`, `done:prod` — production manager (PO `location_id`).
- `fast:req` — pm yoki target loc manager.

### 8. Audit — `telegram_callback_actions` jadvali

```sql
CREATE TABLE telegram_callback_actions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    update_id           BIGINT NOT NULL UNIQUE,    -- idempotency key
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
```

**Maqsadi:**
- Forensic: kim, qachon, qaysi xabar bilan, qanday qaror.
- Idempotency: `update_id` UNIQUE — takror update kelmasin.
- Compliance: rad etilgan callback'lar ham yoziladi (kim hujum
  qildi).

`audit_log` ham yoziladi (`entity='telegram_callback',
entity_id=telegram_callback_actions.id`) — odatdagi audit chain.

### 9. UX detallari

- **`answerCallbackQuery`** — Telegram majburiy javob (aks holda
  tugma "yuklanmoqda" holatda qoladi).
- **Toast vs alert:** muvaffaqiyat — `show_alert: false` (kichik
  toast); xato/rad — `show_alert: true` (modal).
- **Follow-up xabar:** PO tasdiqlanganda foydalanuvchiga
  qo'shimcha "PO-7 keeper tasdig'ini kutmoqda" xabar yuborilishi
  mumkin (state machine'dan keladi).
- **Tugmalarni `notifications.delivered_at` dan keyin ham
  olib tashlamaslik** — Telegram tugmalarini "ishlatilgan" deb
  belgilash murakkab; aksincha, RBAC va idempotency himoyasi
  yetarli.

### 10. Eski xabarlar va tugmali xabarlar

Telegram tugmali xabarni qaytarib chaqirib (`editMessageReplyMarkup`)
tugmalarni olib tashlash mumkin — masalan, PO tasdiqlanganda
"Tasdiq" tugmasi kerak emas. Bu **kerakli**:
```ts
if (result.removeButtons && notification.telegram_message_id) {
  await bot.api.editMessageReplyMarkup(tgId, notification.telegram_message_id, {
    reply_markup: { inline_keyboard: [] }, // empty = remove
  });
}
```

Bu uchun outbox `telegram_message_id` ni saqlashi kerak (allaqachon
Faza-1 da bor — `notifications.telegram_message_id BIGINT`).

### 11. Implementatsiya rejasi

| Qadam | Fayl | Tafsilot |
|---|---|---|
| 1 | `migrations/0010_telegram_callbacks.sql` | jadval + ustun |
| 2 | `integrations/telegram/bot.ts` | `callback_query:data` handler |
| 3 | `integrations/telegram/dispatch.ts` | verb/entity dispatcher |
| 4 | `workers/telegramOutbox.ts` | `inline_callback` rendering |
| 5 | `services/notify.ts` | har xabar turi uchun default tugmalar |
| 6 | `routes/telegramWebhook.ts` | prod webhook endpoint |
| 7 | Testlar | unit (dispatcher), integration (mock bot + DB) |

## Oqibatlar

**Yaxshi:**
- PM va managerlar Telegram'da qoldi — UI'ga o'tmasdan
  amal qila olishadi (asosiy talab).
- Spoofing himoyasi qattiq — `from.id` + RBAC qayta tekshiruv +
  webhook secret.
- Audit to'liq — har callback yozilgan.
- Idempotency — `update_id` UNIQUE.

**Yomon / cheklov:**
- Bot endi ikki yo'nalishli — kod murakkabligi va xavf yuzasi
  oshdi.
- Webhook prod uchun HTTPS sertifikat kerak — DevOps qo'shimcha
  ish.
- `callback_data` 64 bayt limit — agar kelajakda murakkabroq
  parametrlar kerak bo'lsa, hash + DB lookup (qisqa `cb_token`)
  kerak bo'ladi.
- Eski xabardagi tugma ishlamasligi mumkin (RBAC o'zgargan, PO
  allaqachon tasdiqlangan) — UX qiyin. Yumshatish: `view`
  tugmasi har doim ishlaydi, holat tafsilotini ko'rsatadi.

## Muqobillar (rad etilgan)

1. **Inline tugmalardan butunlay voz kechish** (Telegram'da
   ko'rinish, UI'da amal) — rad: TZ §6.9 talabi, qulaylik
   yo'qoladi.
2. **Web app (Telegram Mini App)** — rad: UX gigant, hozircha
   ortiqcha; Faza-4 yoki keyingi.
3. **Deep link (Telegram'dan UI'ga)** — qiziq, lekin har action
   uchun browser ochish — Telegram qulayligi yo'qoladi. Faqat
   `view` uchun fallback bo'lishi mumkin.
4. **Bot komandalar (/approve_po_7)** — rad: foydalanuvchi
   qo'lda yozishi noqulay; inline tugmalar tabiiyroq.

## Bog'liq

- TZ §6.9.
- Spec — `docs/specs/phase-3.md` §2.3, §5.2.
- ADR-0009 (AI write actions — Telegram ham `assistant_actions`
  jadvalidan foydalanishi mumkin alternativa sifatida).
- Grammy docs: <https://grammy.dev/>.
- Telegram Bot API — Inline keyboards:
  <https://core.telegram.org/bots/api#inlinekeyboardbutton>.
