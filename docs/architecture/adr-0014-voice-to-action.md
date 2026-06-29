# ADR-0014 — Voice → AI → Action pipeline

> Holat: **Qabul qilindi** (2026-05-24, egasi tasdig'i)
> Faza: 4
> Bog'liqlik: ADR-0009 (AI write actions), ADR-0011 (Telegram inline),
> ADR-0013 (Yandex STT), `docs/specs/phase-4.md` §2.3.

---

## 1. Kontekst

Egasi (2026-05-24) yangi flow so'radi:

> *"Omborchi Telegram'ga ovozli xabar yuboradi: 'Bugun omborga 500 kg
> un va 50 l yog' keldi.' Tizim ovoz → matn → AI → harakat oqimini
> avtomatik tashkil qilsin. Foydalanuvchi har bir harakatni tasdiqlasa
> bajariladi."*

Bizda allaqachon mavjud:
- ADR-0009 — AI write actions (two-phase commit, F3.2).
- ADR-0011 — Telegram inline tugmalar (F3.3).
- ADR-0013 — Yandex STT.

Yangi qism: **Telegram voice → STT → Vertex parser → assistant_actions
pending** oqimi.

---

## 2. Qaror

Mavjud Faza-3 oqimini reuse qilamiz — voice fragmenti **front-end**
sifatida xizmat qiladi. Yangi ulushlar:

1. Telegram `message:voice` handler.
2. `yandex/stt.ts` chaqiruvi → transcript.
3. Vertex Gemini `parseStockMovementIntent(transcript, principal)`
   function-calling — 0..N ta `Intent` qaytaradi.
4. Har `Intent` uchun `assistant_actions` qatori (status `pending`)
   yaratiladi — F3.2 mavjud servisi.
5. Bot transkripsiya + har action uchun inline tugmalar (`apprv:act:<id>`,
   `rej:act:<id>`) yuboradi.
6. Qo'shimcha verb: `apprv_all:vmsg:<voice_message_id>` — bir bosishda
   shu voice'dan kelib chiqqan barcha pending'larni tasdiqlash.

### 2.1. Pipeline diagrammasi

```
Telegram voice message
   │  (user.is_active ? OK : reject + alert PM)
   ▼
bot.api.getFile(voice.file_id) → URL
   ▼
download → /tmp/voice-<update_id>.ogg
   ▼
INSERT voice_messages (user_id, telegram_update_id, duration_s, ...)
   ▼
yandex/stt.recognizeShort(buffer, {lang: 'uz-UZ', format: 'oggopus'})
   │
   ▼
transcript + confidence
   │
   ▼
UPDATE voice_messages SET transcript, stt_confidence
   ▼
vertex/voicePrompt.parseStockMovementIntent(transcript, principal)
   │   (function-calling: parse_movements)
   │
   ▼
intents: Intent[]  → har biri 1 ta {action, product_name, qty, unit, ...}
   │
   ▼
for each intent:
  ▪ resolveProduct(product_name) → product_id | candidates[]
  ▪ if unique:
      INSERT assistant_actions
        (user_id, tool_name='adjust_in|adjust_out|transfer',
         args, summary, status='pending', voice_message_id)
  ▪ if ambiguous:
      INSERT assistant_actions
        (tool_name='clarify_product', args={candidates}, status='pending')
   │
   ▼
ctx.reply(transcript + summaryList,
          reply_markup: inline_keyboard with apprv/rej + apprv_all)
   │
   ▼
UPDATE voice_messages SET intents_count
   ▼
finally: fs.unlink(tmp_file)
```

### 2.2. Vertex parser system prompt

`apps/backend/src/integrations/vertex/voicePrompt.ts`:

```
Siz ADIA ERP omborchi yordamchisisiz. Foydalanuvchi o'zbek yoki rus
tilida ostatkalar haqida xabar beradi. Sizning vazifangiz: gapni
parse qilish va `parse_movements` funksiyasini chaqirish bilan har
bir harakatni alohida ajratish.

Harakat turlari:
- "adjust_in"  — kirim ("keldi", "olib keldim", "tushdi" = + miqdor)
- "adjust_out" — chiqim ("yo'qoldi", "buzildi", "tashlandi")
- "transfer"  — bo'g'inlar orasida ("jo'natdim", "olib bordim", "berdim")

Birliklar: kg, l, dona, paket, qop. Birlikni aniq aytmasa — `unknown`
qaytaring (clarification kerak bo'ladi).

Lokatsiya hint: agar gap'da "Filial-2", "markaziy sklad", "shop №3"
deyilsa — `to_location_hint` yoki `from_location_hint` ga yozing.

QILMA: o'zingiz mahsulot nomini o'zgartirib yubormang. Foydalanuvchi
nimani aytsa o'shani product_name maydoniga qo'ying.
```

Function declaration:

```ts
{
  name: 'parse_movements',
  description: 'Extract stock movements from user utterance.',
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
          required: ['action','product_name','qty','unit'],
        }
      }
    },
    required: ['movements'],
  }
}
```

### 2.3. Product matching

```ts
async function resolveProduct(
  name: string,
  principal: AuthPrincipal,
): Promise<{ kind: 'unique'; productId: number }
       | { kind: 'ambiguous'; candidates: Product[] }
       | { kind: 'not_found' }> {
  // 1. Aniq mos
  const exact = await db.queryOne(
    `SELECT id FROM products WHERE LOWER(name) = LOWER($1)`,
    [name],
  );
  if (exact) return { kind: 'unique', productId: exact.id };
  // 2. ILIKE prefix
  const prefix = await db.query(
    `SELECT id, name FROM products WHERE name ILIKE $1 || '%' LIMIT 4`,
    [name],
  );
  if (prefix.length === 1) return { kind: 'unique', productId: prefix[0].id };
  if (prefix.length > 1) return { kind: 'ambiguous', candidates: prefix.slice(0,3) };
  // 3. pg_trgm similarity
  const sim = await db.query(
    `SELECT id, name, similarity(name, $1) AS sim
       FROM products
      WHERE similarity(name, $1) > 0.3
      ORDER BY sim DESC LIMIT 3`,
    [name],
  );
  if (sim.length === 0) return { kind: 'not_found' };
  if (sim.length === 1 && sim[0].sim > 0.7) {
    return { kind: 'unique', productId: sim[0].id };
  }
  return { kind: 'ambiguous', candidates: sim };
}
```

**Disambiguation flow**: agar `ambiguous` — bot foydalanuvchidan
tanlovni so'raydi:

```
Transkripsiya: "Bugun 50 kg un keldi"

Qaysi un? (tanlang)
[Un Oliy nav]  [Un I nav]  [Un II nav]
```

Tugma `callback_data` = `clarify:act:<action_id>:<product_id>` —
yangi verb. Bosilganda `assistant_actions.args.product_id` yangilanadi,
`tool_name` `adjust_in` ga o'tadi, status `pending` qoladi va foydalanuvchi
qayta tasdiq tugmalarini ko'radi.

### 2.4. "Hammasini tasdiqlash" verb

Yangi verb `apprv_all` Telegram callback dispatcher uchun:

```
callback_data = "apprv_all:vmsg:<voice_message_id>"
```

Handler:
1. Voice message ga bog'liq `assistant_actions WHERE status='pending'`
   tanlanadi.
2. Har biri uchun mavjud F3.2 `confirmAction(actionId, principal)`
   chaqiriladi (RBAC + canExecute saqlanadi).
3. Bot natijani xabar sifatida yuboradi: "5 ta harakat bajarildi,
   2 ta rad etildi (sabab: insufficient stock)".

### 2.5. Active location resolution

Voice flow da foydalanuvchining `activeLocationId` ni qaysi qiymatga
qo'yamiz? Telegram bot'da `X-Active-Location` header yo'q.

Qaror:
- Default = `principal.locationId` (primary).
- Intent'da `from_location_hint` yoki `to_location_hint` matn topilsa
  — uni `locations.name` ga `ILIKE` orqali resolve qilamiz va action
  args ga yozamiz (`from_location_id`).
- M:N principal: agar foydalanuvchi 3 do'konga biriktirilgan bo'lsa va
  hint yo'q bo'lsa — primary ishlatiladi. Agar boshqa lokatsiya
  kerak bo'lsa — egasi voicega lokatsiya hint qo'shishi shart
  ("Filial-2 dan 5 ta tort jo'natdim").

---

## 3. Xavfsizlik

### 3.1. User identification
- `ctx.from.id` → `users.telegram_id` aniq match.
- `is_active = false` → rad etiladi.
- Notanish telegram_id → bot kursiv javob beradi va PM ga `notifications`
  qator (potansial spam/hujum signal).

### 3.2. Voice fayl xavfsizligi
- Tmp fayl `finally { fs.unlink }` bilan o'chiriladi.
- Crash holatida nightly cron (`apps/backend/src/workers/tmpCleanup.ts`)
  5 daqiqadan eski fayllarni tozalaydi.
- Voice buffer faqat memory'da; STT ga to'g'ridan-to'g'ri yuboriladi
  (short API uchun bucket kerak emas).

### 3.3. Transcript saqlash
- `voice_messages.transcript` — audit uchun.
- PII filtirlash Faza-5 da; hozir transcript "as is" saqlanadi.
- DB qatlami: faqat pm va o'zi (`user_id = principal.userId`) o'qiy
  oladi (`GET /api/voice-messages`).

### 3.4. Hallucination guard
- Vertex parser **mahsulot id qaytarmaydi** — faqat matn nomi.
- Product ID DB qatlamida `resolveProduct` orqali aniqlanadi → AI
  noto'g'ri ID ni "uydirishi" mumkin emas.
- `qty` raqami — agar Vertex katta noto'g'ri raqam qaytarsa, F3.2
  `canExecute` step'da `insufficient_stock` bilan rad etiladi.

### 3.5. RBAC
- Har action `principal` ostida yaratiladi va tasdiq paytida F3.2
  RBAC matritsasi (Faza-3 §4) ishlaydi.
- store_manager voice'da "raw warehouse'ga 500 kg un keldi" desa →
  action yaratish bosqichida `canExecute` rad etadi (store_manager
  raw_wh ga `adjust_in` qila olmaydi).

---

## 4. Audit chain

```
voice_messages.id = 42
  ├── transcript = "500 kg un va 50 l yog' keldi"
  ├── stt_confidence = 0.93
  ├── intents_count = 2
  │
  └── assistant_actions
        ├── id=101 voice_message_id=42 tool=adjust_in args={product_id:5,qty:500,unit:'kg'} status=executed
        │     └── audit_log entry=stock_movement_id=999 caused_by=assistant_action_101
        └── id=102 voice_message_id=42 tool=adjust_in args={product_id:8,qty:50,unit:'l'} status=executed
              └── audit_log entry=stock_movement_id=1000 caused_by=assistant_action_102
```

Forensic so'rov: *"Bu 500 kg un kim qaysi voice xabardan kelgan?"* —
`audit_log` → `assistant_actions` → `voice_messages.transcript` ↔
telegram update.

---

## 5. Edge case'lar

| Holat | Behavior |
|---|---|
| Transkripsiya bo'sh | Bot "Ovozni tushuna olmadim" |
| Intent yo'q ("Salom, qalaysiz") | Bot "Amal aniqlanmadi" (transkripsiya ko'rsatiladi) |
| Birlik noaniq ("bir oz un keldi") | Vertex `unit='unknown'`, qty=null → bot "Aniq miqdor ayting" |
| Product ko'p nomzod | clarify verb |
| Product topilmadi | Bot "Bu mahsulotni topa olmadim. Mahsulot ro'yxati: /products" |
| Lokatsiya hint topilmadi | Default primary; transfer da `to_location_hint` shart |
| STT crash | Bot "Texnik xato, qayta sinab ko'ring" |
| Vertex crash | Same + PM ga notification |
| Voice > 30s | Long API (bucket upload) |
| 1 voice'da 10+ intent | OK, lekin bot xabar uzunligi cheklangan — top 5 tugma + "Boshqalar +5" |

---

## 6. Acceptance / verifikatsiya

AC4.3.1..AC4.3.8 (phase-4.md §2.3). Asosiylari:
- AC4.3.1: Bir intent — bir pending + tugmalar.
- AC4.3.2: Ikki intent — ikki action + "Hammasini tasdiqlash".
- AC4.3.4: Disambiguation — clarify tugmalar.
- AC4.3.6: Notanish telegram_id rad etiladi.
- AC4.3.7: F3.2 confirm normal ishlaydi.

---

## 7. Ochiq savol

- **Voice tilini avtomatik aniqlash** (uz/ru) — Faza-5.
- **Aktiv lokatsiya bot orqali switch** — hozircha primary; future
  `/switch_location` bot command.
- **Long voice (> 30s) optimallashtirish** — kamdan kam, hozir bucket
  upload sodda yetadi.
- **Multi-intent paralel confirm** — F3.2 invariant ("bitta pending")
  voice flow uchun **bekor qilinadi**: voice'dan kelgan barcha actionlar
  paralel pending bo'lishi mumkin. Bu istisno phase-4 §1.3 da yozildi.

---

## 8. References

- `docs/specs/phase-4.md` §2.3, §5.2.
- ADR-0009 (AI write actions — F3.2).
- ADR-0011 (Telegram inline actions — F3.3).
- ADR-0013 (Yandex STT — F4.2).
- TZ.md §6.9, §12.
