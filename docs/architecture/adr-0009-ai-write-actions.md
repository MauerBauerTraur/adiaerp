# ADR-0009 — AI Assistant Write Actions (Two-Phase Confirmation)

> Status: **Accepted** · Date: 2026-05-23 · Author: system-architect
> Relates: ADR-0006 (AI tool layer, read-only Faza-2), TZ §12, spec
> `docs/specs/phase-3.md` §2.2.
> Owners decision (2026-05-23): write tools Faza-3 da; har doim
> foydalanuvchi tasdig'i bilan.

## Kontekst

Faza-2 da AI assistant **faqat o'qiy oladi** — 6 ta read-only tool
(`get_stock`, `get_open_requests`, va h.k.). Foydalanuvchilar
(ayniqsa PM) tabiiy ravishda assistant'dan **harakat** so'rashga
intilishadi: "Filial-2 ga 5 ta tort jo'nat", "Bu zayafkani tayyor
deb belgila", "PO-7 ni tasdiqla".

TZ §12 va Faza-3 reja write tool'larni qo'shadi, **lekin har doim
foydalanuvchi tasdig'i bilan** (TZ: "tasdiqlangan buyruqni
bajaradi"). Bu ADR shu tasdiq oqimini, RBAC va xavfsizlik
qoidalarini, audit va idempotentlikni belgilaydi.

## Qaror

### 1. Two-phase commit (intent → confirm → execute)

Model write tool'ni chaqirsa, server **darhol DB'ni o'zgartirmaydi**.
O'rniga:

1. Server `assistant_actions` jadvalga `pending` qator yaratadi.
2. Response'da `pending_action: {action_id, tool_name, args, summary,
   expires_at}` qaytaradi.
3. UI tasdiq dialogini ko'rsatadi.
4. Foydalanuvchi tasdiqlasa → `POST /api/assistant/actions/:id/confirm`
   → server tool executor'ning `execute()` ni chaqiradi → DB
   o'zgartiriladi → audit.
5. Rad etsa → `POST .../reject`.
6. 5 daqiqada tasdiqlanmasa → `expired`.

```
┌──────────┐  query   ┌──────────┐ fc  ┌──────────┐
│  user UI │ ──────→ │ backend  │ ──→ │  Vertex  │
└──────────┘          └──────────┘     └──────────┘
     ▲                     │  ◄── functionCall: transfer_stock {...}
     │                     ▼
     │              pre-check + INSERT assistant_actions(status='pending')
     │                     │
     │                     ▼
     │              response: { pending_action: {...} }
     │                     │
     │  ◄──────────────────┘
     │  "Tasdiqlaysizmi?"
     │
     │  confirm
     ▼
┌──────────┐ ──→ POST /actions/:id/confirm
│  user UI │
└──────────┘ ──→  backend: UPDATE assistant_actions
                          SET status='executed' WHERE id=$1 AND status='pending'
                          → executor.execute() → audit_log → result
```

**Nega two-phase:**
- LLM hech qachon kechiktirilmagan DB yozishni boshlay olmaydi —
  ya'ni prompt injection bilan "transfer barchasini" deb yozsa ham,
  oraliq tasdiq bor.
- User uchun **shaffof undo** — har action audit'da ko'rinadi va
  rad qilingan amal hech qachon DB'ga tushmaydi.
- Asinxron Telegram callback'i ham xuddi shu jadvaldan
  foydalanishi mumkin (Faza-3 §2.3 — Telegram tugmalari).

### 2. Lifecycle va statuslar

`assistant_action_status` enum:

| Status | Ma'no | O'tish |
|---|---|---|
| `pending` | Model chaqirgan, user tasdig'ini kutmoqda | → executed / rejected / expired / superseded |
| `executed` | Real action bajarildi | terminal |
| `rejected` | User rad etdi | terminal |
| `expired` | 5 daqiqada tasdiqlanmadi | terminal |
| `superseded` | Yangi action yaratildi shu sessiyada — eski overridden | terminal |

**O'tish qoidalari:**
- Faqat `pending` → `executed | rejected | expired | superseded`.
- `executed` qatordan hech qachon orqaga qaytib bo'lmaydi (undo —
  yangi reverse action yaratish kerak).
- Superseded — sessiyaga **bir vaqtda bitta pending** prinsipi.

### 3. RBAC pre-check + execute-check (ikki bosqich)

**Pre-check (action yaratishda):**
- Tool executor `canExecute(args, principal)` ga ega.
- Misol: `transfer_stock` `from_location_id` foydalanuvchining
  bo'g'ini emasligini tekshiradi (non-pm). Agar rad etilsa, action
  **yaratilmaydi** va model `pending_action` qaytarmaydi —
  foydalanuvchiga "Sizga ruxsat yo'q" javobi.
- Bu **dastlabki himoya** — assistant noto'g'ri vakolatli
  amallarni tavsiya qilmaydi.

**Execute-check (confirm chaqirilganda):**
- `canExecute` qaytadan tekshiriladi. Sabab: action yaratilgandan
  beri foydalanuvchining roli o'zgargan bo'lishi mumkin (PM
  store_manager ga "pasaytirdi" va h.k.).
- Business invariant ham bu yerda — `qty > stock.qty` bo'lsa
  `INSUFFICIENT_STOCK`.

**Audit:** har `canExecute` rad etilishi `audit_log` ga yoziladi
(`entity='assistant_action', payload.canExecute_reason`).

### 4. Idempotentlik va concurrency

**Confirm-only-once garantiya** atomar SQL:

```sql
UPDATE assistant_actions
   SET status = 'executed', executed_at = now(), result = $2
 WHERE id = $1
   AND status = 'pending'
   AND created_at > now() - interval '5 minutes'
 RETURNING *
```

- `0 rows affected` → endpoint `409 ACTION_NOT_PENDING` yoki
  `410 ACTION_EXPIRED` (created_at tekshiruvi alohida) qaytaradi.
- Foydalanuvchi ikki marta tasdiq tugmasini bossa — birinchisi
  ishlaydi, ikkinchisi 409.
- Telegram callback va UI tasdiqlash bir vaqtda kelsa ham xavfsiz
  (atomar lock).

**Superseded:** yangi `pending` action shu sessiya'da yaratilsa:
```sql
UPDATE assistant_actions
   SET status = 'superseded'
 WHERE session_id = $1
   AND status = 'pending'
   AND id <> $2  -- yangi id
```

### 5. Audit chain

Har write action ikki audit qator yaratadi:

1. **Intent audit** (action yaratishda):
   ```sql
   INSERT INTO audit_log (actor, action, entity, entity_id, payload)
   VALUES ($principal, 'create', 'assistant_action', $action_id,
           jsonb_build_object('tool', $tool, 'args', $args,
                              'session_id', $session, 'summary', $summary))
   ```

2. **Execution audit** (confirm da):
   - `entity='assistant_action', action='execute', payload.result=...`.
   - **Bog'lash:** real domen audit (masalan, `stock_movement` audit)
     `payload.caused_by_action_id = $action_id` link saqlaydi. Bu
     forensic uchun — "bu stock movement qaysi AI action'dan
     keldi?" so'roviga javob.

### 6. Tool executor interface (kengaytma)

```ts
type Principal = { userId: number; role: Role; locationId: number | null };

interface WriteToolExecutor<Args> {
  readonly declaration: FunctionDeclaration;
  readonly kind: 'write';                          // diskriminator
  summarize(args: Args, principal: Principal): Promise<string>;
  canExecute(args: Args, principal: Principal): Promise<true | { reason: string; code: string }>;
  execute(args: Args, principal: Principal, db: Db): Promise<unknown>;
}

// Read tool — Faza-2 dan davom
interface ReadToolExecutor<Args> {
  readonly declaration: FunctionDeclaration;
  readonly kind: 'read';
  execute(args: Args, principal: Principal, db: Db): Promise<unknown>;
}

type ToolExecutor<Args = any> = ReadToolExecutor<Args> | WriteToolExecutor<Args>;
```

`summarize` natijasi **dialog matni**:
- O'zbekcha, lakonik.
- Argumentlar haqida konkret — "Markaziy sklad → Filial-2: 5 ta
  **Tort Napoleon**", emas "Stock transfer".
- DB'dan ism'larni keltirish (`product.name`, `location.name`).

Misol:
```ts
async summarize(args, principal) {
  const [from, to, product] = await Promise.all([
    db.queryOne('SELECT name FROM locations WHERE id=$1', [args.from_location_id]),
    db.queryOne('SELECT name FROM locations WHERE id=$1', [args.to_location_id]),
    db.queryOne('SELECT name, unit FROM products WHERE id=$1', [args.product_id]),
  ]);
  return `${from.name} → ${to.name}: ${args.qty} ${product.unit} ${product.name}`;
}
```

### 7. Frontend dialog UX

- shadcn `AlertDialog` (destructive variant — qaytarib bo'lmaydigan
  amal ekanligini ko'rsatish).
- Title: "Amalni tasdiqlaysizmi?"
- Body: `summary`.
- Tugmalar: "Rad etish" (default), "Tasdiqlash" (cta).
- Timer chizig'i (5:00 → 0:00).
- Esc — rad etish.

### 8. Edge case'lar

- **Multi-call**: bitta query'da model 2 ta write tool chaqirsa —
  faqat **birinchisi** action yaratiladi, qolganlar e'tiborga
  olinmaydi. Sabab: bir vaqtda bitta pending action invariant.
  Backend response'da `tool_calls_ignored: [...]` belgilanadi.
- **Tool not found**: model nomi noto'g'ri (`transfre_stock`) tool
  chaqirsa — assistant javobi `INVALID_TOOL_CALL` log + user'ga
  "Men bu amalni bajara olmadim".
- **Args type mismatch**: model `qty="5"` (string) yuborsa —
  Zod/JSON schema validator rad etadi → user'ga "Argument xato"
  (bu Gemini'ning nodir hodisasi).
- **Stale principal**: action yaratilganidan 5 daqiqa o'tib
  user rolini PM o'zgartirgan bo'lishi mumkin (kamdan-kam). Execute
  pre-check qayta tekshiradi.

### 9. Read va write tools birga ishlaydi

Model bitta query'da:
1. `get_stock` (read) — joriy ostatka.
2. `get_below_min` (read) — qaysi qizil.
3. `transfer_stock` (write) — taklif.

Read'lar darhol bajariladi va modelga qaytariladi (Faza-2
oqimi). Write — pending action ga aylanadi. Response'da
ikkalasi ham:
```json
{
  "response": "Filial-2 da non 2 kg qoldi. Markaziy skladdan 8 kg jo'natishni taklif qilaman.",
  "tool_calls": [
    {"name": "get_stock", "args": {...}, "ok": true},
    {"name": "get_below_min", "args": {...}, "ok": true}
  ],
  "pending_action": {
    "action_id": 1234,
    "tool_name": "transfer_stock",
    "args": {"product_id": 42, "from_location_id": 1, "to_location_id": 2, "qty": 8},
    "summary": "Markaziy sklad → Filial-2: 8 kg Non",
    "expires_at": "2026-05-23T08:35:00Z"
  }
}
```

### 10. Telegram callback'lar bilan birlik

Faza-3 §2.3 (Telegram inline tugmalar) ham `assistant_actions`
jadvalidan foydalanishi mumkin. Misol: bot xabar yuboradi "Yangi
PO #7 tasdiq talab qiladi" + "Tasdiqlash" tugmasi. Tugma bosilganda
bot:
```ts
INSERT INTO assistant_actions (user_id, tool_name='approve_purchase_order',
                                args={po_id: 7, role: 'manager'},
                                summary='PO-7 ni tasdiqlash (manager)',
                                status='executed', executed_at=now())
```

Telegram'da tasdiq darhol — UI dialog yo'q. Lekin audit shu
jadvalda, shu format'da, shu RBAC qoidalari bilan.

Eslatma: assistant chat va Telegram callback'lari uchun
**session_id** turli xil — Telegram'da `session_id IS NULL`
yoki maxsus "telegram" sentinel. Bu ADR'da `assistant_sessions.id`
nullable bo'lishi kerak emas — alohida `telegram_callback_actions`
jadvali bor (ADR-0011).

## Oqibatlar

**Yaxshi:**
- Foydalanuvchi har doim tasdiq beradi — assistant hech qachon
  "g'oyibdan" DB ni o'zgartirmaydi.
- Idempotency — atomar SQL bilan kafolat.
- Audit chain — har action sabab + natija bilan.
- LLM compromise (jailbreak, prompt injection) yopiqdir — server
  RBAC ham, two-phase ham, atomar lock ham.
- Telegram inline tugmalar bilan birlashtirish oson.

**Yomon / cheklov:**
- UX cheklovi — har amalga tasdiq dialog'i sekinroq. PM ko'p
  amalda "yashil ro'yxat" (auto-confirm) so'rashi mumkin —
  Faza-4 da ko'riladi.
- Multi-action paralel cheklangan (bir vaqtda bitta pending).
  Murakkab buyruq ("Filial-1, 2, 3 ga tortlar tarqat") faqat
  ketma-ket bajariladi.
- 5 daqiqali timeout qisqa bo'lishi mumkin — egasi monitor
  qiladi.

## Muqobillar (rad etilgan)

1. **Direct execute (tasdiqsiz)** — rad: TZ §12 talabi va
   xavfsizlik xavfi. Hatto "tasdiq" deb user yozsa ham,
   prompt injection chiqib ketishi mumkin.
2. **Chat ichida tasdiq** ("ha/yo'q" model'ga) — rad: model
   chalg'ishi va "ha" deb noto'g'ri talqin qilishi xavf. Server
   tomonida real dialog kuchli.
3. **JSON Patch oqimi** (PATCH HTTP semantics) — rad: REST'ga
   yaqinroq, lekin assistant ↔ user dialog kontekstida tushunchani
   "action" sifatida saqlash audit uchun toza.
4. **Action queue (kelin sajda)** — rad: bir vaqtda bitta
   pending invariant'ni murakkablashtirar; UX ham assistant'dan
   foydalanuvchini chalkashtirar.

## Bog'liq

- ADR-0006 (AI tool layer — read-only Faza-2).
- ADR-0008 (Vertex SDK migration — write tool deklaratsiyalari
  yangi SDK shape ostida yoziladi).
- ADR-0011 (Telegram inline actions — `assistant_actions`
  jadvalidan ham foydalanishi mumkin).
- Spec — `docs/specs/phase-3.md` §2.2, §5.1.
