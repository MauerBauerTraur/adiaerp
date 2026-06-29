# ADIA ERP — Faza-1 (Kengaytirilgan MVP) Spetsifikatsiyasi

> Versiya: 1.0 · Sana: 2026-05-22 · Muallif: system-architect
> Asos: `docs/TZ.md`, `docs/architecture/decisions.md` (D1–D6), `docs/adia-poster-api.md`
> Holat: jamoa rahbari va loyiha egasi tasdig'iga

Bu hujjat ADIA ERP ning Faza-1 to'liq spetsifikatsiyasi. DB sxemasi:
`docs/architecture/db-schema-phase-1.sql`. Arxitektura qarorlari: `docs/architecture/adr-0001..0004`.

---

## 1. Qamrov (scope)

### 1.1. Faza-1 ga KIRADI
- **Core ma'lumot modeli:** `locations`, `products`, `recipes` (BOM), `stock`, `stock_movements`.
- **Min/max + replenishment engine** + request **state machine** (TZ §8.2 to'liq tsikli).
- **Ishlab chiqarish:** `recipes` (BOM), `production_orders`, "tayyor" oqimi — xom-ashyo atomar chiqim, markaziy sklad atomar kirim.
- **BOM import (fallback: qo'lda):** retseptlar Poster'dan import qilinadi — agar API
  imkon bersa; aks holda qo'lda kiritiladi. Strategiya — §5.5.
- **Purchase orders** — ikki bosqichli tasdiq oqimi (D5: boshliq + skladchi — OS-5 hal qilingan).
- **Poster POS integratsiya:** ostatka (`storage.getStorageLeftovers`) + savdo (`dash.getTransactions` + `transaction.close` webhook) sinxronizatsiya.
- **Oddiy dashboard** (overview) + **Telegram bildirishnomalar**.

### 1.2. Faza-1 ga KIRMAYDI (keyingi fazalar)
- AI assistant (Faza 2) — chat, tool-calling.
- Dinamik min/max **avtomatik qayta hisob** cron (Faza 2). Sxema buni qo'llab-quvvatlaydi
  (`sales_stats_daily` jadvali, `locations.lead_time_days / review_days / safety_factor`,
  `stock.minmax_mode`), lekin kechki cron Faza-2 ga qoldiriladi.
- Poster ga **write-back** (POS ga ma'lumot yozish) — Faza 3.
- Telegram inline tugmalar bilan tasdiqlash — Faza 3 (Faza-1 da faqat bir tomonlama xabar).

### 1.3. Asosiy invariantlar (buzilmaydi — CLAUDE.md §6)
1. Har `stock_movement` — bitta atomar DB tranzaksiya (manba kamayadi, qabul oshadi, audit yoziladi).
2. Bitta `(product, location)` uchun bir vaqtda bitta ochiq `replenishment_request`.
3. `stock.qty` hech qachon manfiy emas — DB `CHECK (qty >= 0)` + ilova guard'i.
4. min/max har `(location_id, product_id)` juftligida.
5. `production_order` "tayyor" — BOM bo'yicha xom-ashyo kamayadi, sklad oshadi (atomar).
6. RBAC har endpointda; har o'zgarish `audit_log` ga yoziladi.

---

## 2. Modullar

Har modul: scope + acceptance criteria (TZ §15 asosida).

### 2.1. M1 — Locations & Users (core skelet)
**Scope:** zanjirning har bo'g'ini `locations` jadvalida (`raw_warehouse`, `production`,
`supply`, `central_warehouse`, `store`). Ta'minot bo'limlari — Tort, Perojniy va
**Yarim Fabrika** — uchalasi ham `type='supply'` location (OS-4). Har bo'g'inga
manager-foydalanuvchi biriktiriladi (D6). Poster spot/storage lar `locations` ga map qilinadi (§5).

**Acceptance:**
- AC1.1: Har `location` ning `type` aniq; `store` — `poster_spot_id`, ombor turlari — `poster_storage_id` bilan bog'langan.
- AC1.2: Har `location` ning kamida bitta manageri bor (`manager_user_id`); manager faqat o'z bo'g'inini ko'radi.
- AC1.3: `pm` roli butun zanjirni ko'radi; boshqa rollar — faqat o'z `location_id` si.

### 2.2. M2 — Products & Recipes (BOM)
**Scope:** `products` (`raw` / `semi` / `finished`), o'lchov birligi (`kg`/`l`/`pcs`).
`recipes` — 1 mahsulot = N komponent. `semi` (Yarim Fabrika) ham `product_id`, ham
`component_product_id` bo'la oladi (D2 — ikki tomonlama oqim).

**BOM manbai (OS-3 — egasi qarori):** retseptlar Poster'dan import qilinadi —
**agar mumkin bo'lsa**. `research-analyst` aniqladi: `menu.getProduct` (bitta
mahsulot) va `menu.getPrepacks` (yarim tayyorlar) ingredient tarkibini qaytarishi
**mumkin**, lekin hujjatda to'liq tasdiqlanmagan; `menu.getProducts` (ro'yxat) da
ingredient yo'q. Strategiya va real tekshiruv vazifasi — §5.5.

**Acceptance:**
- AC2.1: `finished`/`semi` mahsulot Poster menu `product_id` ga; `raw`/`semi`/stocked
  `finished` Poster `ingredient_id` ga map qilinadi (§5.1 mapping qoidasi).
- AC2.2: BOM o'zaro tsikl yaratmaydi (`product_id <> component_product_id`; chuqur tsikl ilova darajasida tekshiriladi).
- AC2.3: `semi` mahsulot boshqa retseptda komponent sifatida ishlatilishi mumkin.
- AC2.4: BOM import muvaffaqiyatli bo'lsa `recipes` Poster `menu.getProduct` /
  `menu.getPrepacks` dan to'ldiriladi; API ingredient qaytarmasa qo'lda kiritish
  (`PUT /api/products/:id/recipe`) bilan to'ldiriladi — ikkala yo'l ham qabul qilinadi.

### 2.3. M3 — Stock & Movements
**Scope:** `stock` — har `(location, product)` uchun `qty`, `min_level`, `max_level`.
`stock_movements` — append-only ledger. Har harakat atomar tranzaksiya.

**Acceptance:**
- AC3.1: Transfer/kirim/chiqim qilinganda manba kamayadi, qabul oshadi, `stock_movements` + `audit_log` yoziladi — yoki hammasi, yoki hech narsa.
- AC3.2: Manbada qty yetmasa harakat rad etiladi (`409 INSUFFICIENT_STOCK`), `stock` o'zgarmaydi.
- AC3.3: `stock.qty` hech qachon manfiy bo'lmaydi (DB `CHECK` + guard'li `WHERE qty >= :qty`).

### 2.4. M4 — Replenishment engine + state machine
**Scope:** har 5 daqiqada ishlaydigan cron worker `qty <= min_level` qatorlarni topadi,
ochiq request bo'lmasa `replenishment_request(qty_needed = max_level - qty)` yaratadi va
state machine bo'yicha `advance` qiladi. To'liq state machine — §3.

**Acceptance:**
- AC4.1: Ostatkani sun'iy ravishda min'dan pasaytirsak — to'liq tsikl avtomatik ishga tushadi va do'kon `max` gacha to'ladi.
- AC4.2: Bir `(product, location)` uchun ikkinchi ochiq request yaratilmaydi (debounce — partial UNIQUE index).
- AC4.3: Har state o'tishi `replenishment_transitions` jadvaliga yoziladi.

### 2.5. M5 — Production orders ("tayyor" oqimi)
**Scope:** `production_orders` — zayafka. Status: `new → in_progress → done`.
"Tayyor" (`done`) bosilganda BOM bo'yicha xom-ashyo/yarim tovar atomar chiqim, ishlab
chiqarilgan mahsulot markaziy skladga atomar kirim.

**Acceptance:**
- AC5.1: `done` ga o'tkazilganda BOM bo'yicha xom-ashyo `stock` kamayadi, target sklad `stock` oshadi (atomar).
- AC5.2: BOM komponentlaridan birortasi yetmasa `done` rad etiladi (`409`), hech narsa o'zgarmaydi.
- AC5.3: Replenishment dan kelgan zayafka `done` bo'lganda bog'liq request `PRODUCING → DONE_TO_WAREHOUSE` ga o'tadi.

### 2.6. M6 — Purchase orders (ikki bosqichli tasdiq — D5, OS-5)
**Scope:** xom-ashyo yetmaganda `purchase_order` (Yetkazib berishga so'rov) `draft` holatda
yaratiladi. Boshliq qadami (`manager_approved_*`) — `supply_manager`; skladchi qadami
(`keeper_approved_*`) — `raw_warehouse_manager`. Ikkala qadam to'ldirilsa `approved`
bo'ladi. `pm` har ikki qadamni ham bajara oladi (super-admin). `received` — tovar omborga kirgach.

**Acceptance:**
- AC6.1: `draft` holatdagi so'rov ikkala tasdiq bo'lmaguncha kuchga kirmaydi.
- AC6.2: `approved` holatga o'tish faqat ikkala `*_approved_by` to'ldirilgan bo'lsa mumkin (DB `CHECK`).
- AC6.3: `received` qilinganda xom-ashyo `stock` atomar oshadi va bog'liq request keyingi bosqichga o'tadi.

### 2.7. M7 — Poster POS integratsiya
**Scope:** §5 dagi mapping va sinxronizatsiya. Ostatka — davriy poll (`storage.getStorageLeftovers`);
savdo — webhook (`transaction.close`) + fallback poll (`dash.getTransactions`).

**Acceptance:**
- AC7.1: `transaction.close` webhook kelganda chek mahsulotlari `sales` ga yoziladi, do'kon `stock` kamayadi (idempotent — bir chek bir marta).
- AC7.2: Davriy ostatka poll Poster qoldig'ini ADIA `stock.qty` ga `adjust` movement orqali moslaydi.
- AC7.3: Har sync `poster_sync_log` ga yoziladi; xatolik bo'lsa `status='failed'` + `error_detail`.

### 2.8. M8 — Dashboard (overview)
**Scope:** `GET /api/dashboard/overview` — butun zanjir holati: qaysi bo'g'inda qancha
qizil (`qty <= min`) pozitsiya, ochiq requestlar soni statusbo'yicha, bugungi ishlab
chiqarish rejasi, oxirgi harakatlar. RBAC: PM — hammasi, boshqalar — o'z bo'g'ini.

**Acceptance:**
- AC8.1: Overview javobi < 1s (TZ §13) — agregatlar indeksli so'rovlardan.
- AC8.2: Do'kon menejeri overview da faqat o'z do'koni ma'lumotini ko'radi.

### 2.9. M9 — Telegram bildirishnomalar
**Scope:** Grammy bot. `notifications` jadvaliga yozilgan xabarni outbox-worker tegishli
rol/foydalanuvchiga yuboradi. Faza-1 — bir tomonlama (inline tugmalarsiz).

**Acceptance:**
- AC9.1: Ostatka min'dan tushganda tegishli location manageriga Telegram xabar boradi.
- AC9.2: Yangi zayafka, "tayyor", jo'natma, yangi supply request — har biri tegishli rolga xabar.
- AC9.3: Telegram yuborilmasa `notifications.telegram_sent=false` qoladi, retry qilinadi.

---

## 3. Replenishment Request State Machine (TZ §8.2 — to'liq)

To'liq dizayn asoslari: `docs/architecture/adr-0001-replenishment-state-machine.md`.

> **Sprint 2 audit aniqliklari (2026-05-23) — ADR-0001 §7–§12:**
> 1. `CHECK_PRODUCTION_INPUT → CREATE_PRODUCTION_ORDER` action'i endi `raw_warehouse → production` transferni o'z ichiga oladi (branch (b)/(c) ikkalasi).
> 2. Skip-state zanjirlash (SM-7) — bir `advance` chaqiruvi bir nechta forward o'tishni zanjir qiladi (masalan, `new → done` foydalanuvchi sakrashi).
> 3. `target_location_id` har doim zanjirdagi `central_warehouse` — `parent_id` emas; `production_order.target_location_id` ham xuddi shu.
> 4. `POST /api/replenishment/:id/advance` `200 OK` qaytaradi (oldingi `201` xato edi — yangi resurs yaratilmaydi).
> 5. `production_order` `cancelled` ga o'tish ruxsat etiladi (faqat `new`/`in_progress` dan).
> 6. Multi-shortage: sekvensial PO, `purchase_order_id` qayta yozilmasin (NULL → yangi PO), eski PO audit'da saqlanadi; M:N jadval Faza-2.

### 3.1. Holatlar (`replenishment_status` enum)

| Holat | Ma'nosi | Tur |
|---|---|---|
| `NEW` | Engine yaratdi, hali ishlanmagan | boshlang'ich |
| `CHECK_STORE_SUPPLIER` | Markaziy skladda yetarli tovar bormi tekshirilmoqda | oraliq |
| `SHIP_TO_REQUESTER` | Tovar bor — so'rovchiga jo'natma kerak | oraliq |
| `CHECK_PRODUCTION_INPUT` | Skladda yo'q — ishlab chiqarish uchun xom-ashyo bormi | oraliq |
| `CREATE_PURCHASE_ORDER` | Xom-ashyo yetmaydi — purchase order yaratildi, tasdiq kutilmoqda | oraliq (kutuv) |
| `CREATE_PRODUCTION_ORDER` | Xom-ashyo bor — zayafka yaratildi | oraliq |
| `PRODUCING` | Zayafka `in_progress` | oraliq (kutuv) |
| `DONE_TO_WAREHOUSE` | Zayafka `done` — tovar skladga kirdi | oraliq |
| `CLOSED` | So'rovchi `max` gacha to'ldirildi | **terminal** |
| `CANCELLED` | Qo'lda bekor qilingan / o'rnini bosilgan | **terminal** |

"Ochiq" = `CLOSED`/`CANCELLED` dan boshqa har qanday holat (invariant 2 uchun).

### 3.2. O'tishlar (transitions)

```
NEW
 └─► CHECK_STORE_SUPPLIER                          [guard: target = central warehouse aniqlandi]
      ├─ yetarli  ─► SHIP_TO_REQUESTER             [guard: central_wh.stock.qty >= qty_needed]
      └─ yetmaydi ─► CHECK_PRODUCTION_INPUT

CHECK_PRODUCTION_INPUT
 ├─ BOM xom-ashyosi yetarli  ─► CREATE_PRODUCTION_ORDER
 └─ xom-ashyo yetmaydi       ─► CREATE_PURCHASE_ORDER

CREATE_PURCHASE_ORDER
 └─► CREATE_PRODUCTION_ORDER                       [guard: bog'liq purchase_order.status='received']

CREATE_PRODUCTION_ORDER
 └─► PRODUCING                                     [guard: production_order.status='in_progress']

PRODUCING
 └─► DONE_TO_WAREHOUSE                             [guard: production_order.status='done']

DONE_TO_WAREHOUSE
 └─► SHIP_TO_REQUESTER

SHIP_TO_REQUESTER
 └─► CLOSED                                        [action: target→requester transfer; requester max gacha]

har qanday ochiq holat
 └─► CANCELLED                                     [faqat pm yoki manual; audit yoziladi]
```

### 3.3. Guard'lar va action'lar

> **Sprint 2 audit aniqliklari (2026-05-23):** quyidagi jadval ADR-0001 §7–§12 ga muvofiq aniqlashtirildi. Asosiy o'zgarishlar: `CHECK_PRODUCTION_INPUT → CREATE_PRODUCTION_ORDER` action'iga `raw_warehouse → production` transfer qo'shildi; `NEW` da `target_location_id` `parent_id` o'rniga zanjirdagi `central_warehouse` ga belgilanadi; multi-shortage uchun `purchase_order_id` qayta yozilmasligi qoidasi qo'shildi.

| O'tish | Guard | Action (atomar — bitta tranzaksiyada) |
|---|---|---|
| `NEW → CHECK_STORE_SUPPLIER` | zanjirda `type='central_warehouse'` location topildi (`resolveTopology(...).centralWarehouseLocationId`) | `target_location_id := <central_warehouse_id>` |
| `CHECK_STORE_SUPPLIER → SHIP_TO_REQUESTER` | `target.stock.qty >= qty_needed` | — |
| `CHECK_STORE_SUPPLIER → CHECK_PRODUCTION_INPUT` | `target.stock.qty < qty_needed` | — |
| `CHECK_PRODUCTION_INPUT → CREATE_PRODUCTION_ORDER` | BOM mavjud; har komponent uchun `raw_warehouse.stock.qty >= qty_per_unit * qty_needed` | **(1)** Har BOM komponenti uchun `applyMovement(reason='transfer', from=raw_warehouse, to=production, qty=qty_per_unit*qty_needed, replenishment_id=<id>)` — xom-ashyo `production` location'ga ko'chiriladi; **(2)** `production_order(status='new', location_id=production, target_location_id=<central_warehouse_id>, replenishment_id=<id>)` yaratiladi; **(3)** `request.production_order_id` belgilanadi. Hammasi bitta tranzaksiyada — birorta transfer `INSUFFICIENT_STOCK` bersa hammasi rollback. |
| `CHECK_PRODUCTION_INPUT → CREATE_PURCHASE_ORDER` | kamida bitta BOM komponenti `raw_warehouse` da yetmaydi | **(1)** Agar `request.purchase_order_id IS NOT NULL` (oldingi PO `received` bo'lgan, lekin boshqa komponent hali yetmaydi) — `purchase_order_id := NULL` ga tushiriladi + `audit_log` ga `replenishment.purchase_order.unlink` (oldingi PO ID payload'da); **(2)** Birinchi yetmaydigan komponent uchun `purchase_order(status='draft', product_id=<component>, qty=<shortfall>, target_location_id=raw_warehouse, replenishment_id=<id>)` yaratiladi; **(3)** `request.purchase_order_id := <new_po_id>`. |
| `CREATE_PURCHASE_ORDER → CREATE_PRODUCTION_ORDER` | `purchase_order.status='received'` (PO `received` action'i xom-ashyoni `raw_warehouse` ga atomar qo'shadi — M6 mas'uliyati) | Yana `CHECK_PRODUCTION_INPUT` shartlari tekshiriladi: agar barcha BOM komponentlari yetarli — yuqoridagi `CHECK_PRODUCTION_INPUT → CREATE_PRODUCTION_ORDER` action'i bajariladi (transfer + PO yaratish); agar yana shortage qolsa — `CHECK_PRODUCTION_INPUT → CREATE_PURCHASE_ORDER` action'i (PO unlink + yangi PO). |
| `CREATE_PRODUCTION_ORDER → PRODUCING` | `production_order.status IN ('in_progress','done')` | — (no-op transition; faqat status flip + audit) |
| `PRODUCING → DONE_TO_WAREHOUSE` | `production_order.status='done'` | — ("tayyor" oqimi — BOM `production` location'dan chiqim va `target_location_id` (central warehouse) ga kirim — M5 `production_orders.ts` da, `done` qilingan paytda atomar ravishda allaqachon bajarilgan; bu yerda faqat status flip + audit) |
| `DONE_TO_WAREHOUSE → SHIP_TO_REQUESTER` | — | — (no-op transition) |
| `SHIP_TO_REQUESTER → CLOSED` | `target.stock.qty > 0` | `applyMovement(reason='transfer', from=target (central_warehouse), to=requester, qty=min(qty_needed, target.qty), replenishment_id=<id>)`; `request.shipment_movement_id := <movement_id>`; `closed_at := now()`. |

**Skip-state zanjirlash (ADR-0001 §8):** Agar bitta `advance` chaqiruvi chog'ida bir holat o'tgandan keyin keyingi holatning guard'i ham **darhol** qondirilgan bo'lsa, state machine **o'sha tranzaksiya ichida** keyingi qadamga ham o'tadi. Asosiy holat: foydalanuvchi `PATCH /api/production-orders/:id {status:'done'}` qiladi (`in_progress` ni o'tkazib yuborib) — keyingi `advance` chaqiruvida `CREATE_PRODUCTION_ORDER → PRODUCING → DONE_TO_WAREHOUSE` zanjir bajariladi (har biri alohida `replenishment_transitions` qatori).

### 3.4. State machine invariantlari
- SM-1: Har o'tish `replenishment_transitions` ga `(from_status, to_status, reason, actor)` bilan yoziladi.
- SM-2: Faqat oldindan belgilangan o'tishlar ruxsat etiladi; noto'g'ri o'tish `409 INVALID_TRANSITION`.
- SM-3: `advance` operatsiyasi bitta tranzaksiyada — holat, bog'liq hujjat, movement, audit birgalikda.
- SM-4: `CREATE_PURCHASE_ORDER` va `PRODUCING` — "kutuv" holatlari; `advance` ularda guard bajarilmaguncha xatosiz "hali tayyor emas" qaytaradi (no-op).
- SM-5: Terminal holatda (`CLOSED`/`CANCELLED`) `advance` ishlamaydi.
- SM-6: `advance` ni cron ham, foydalanuvchi ham chaqira oladi; idempotent — bir holatda ikki marta chaqirilsa holat sakramaydi.
- **SM-7 (Sprint 2):** **Skip-state zanjirlash** — bitta `advance` chaqiruvi bir nechta o'tishni ketma-ket bajarishi mumkin, agar har o'tish ALLOWED_TRANSITIONS bo'yicha qonuniy bo'lsa va keyingi guard'i darhol qondirilsa. Asosiy holat: foydalanuvchi `production_order` ni `new → done` ga to'g'ridan o'tkazsa, `advance` `CREATE_PRODUCTION_ORDER → PRODUCING → DONE_TO_WAREHOUSE` ni bitta tranzaksiyada zanjir qiladi. Audit jurnali har bir oraliq o'tishni alohida saqlaydi (SM-1). To'liq dizayn — ADR-0001 §8.

---

## 4. API kontrakti (TZ §9 kengaytirilgan)

Barcha endpointlar: `Authorization: Bearer <JWT>`. Javob `application/json`.
Xato formati: `{ "error": { "code": "STRING_CODE", "message": "..." } }`.
RBAC: §6 matritsasi. Har write endpoint `audit_log` ga yozadi.

### Javob konvensiyalari (majburiy)

- **List endpointlar yalang'och massiv qaytaradi** (konvert YO'Q):
  `GET /api/products`, `GET /api/locations`, `GET /api/users`,
  `GET /api/stock` — to'g'ridan-to'g'ri `[...]`.
- **Yagona istisno — paginatsiyali list:** `GET /api/stock/movements`
  konvert qaytaradi: `{ items: [...], total, limit, offset }`.
  `total` — filtrlangan umumiy son (`COUNT(*)`), faqat joriy sahifa emas.
- Bitta resurs (`POST`/`PATCH`/`PUT`/`GET /:id`) o'z konvertini saqlaydi:
  `{ product }`, `{ location }`, `{ user }`, `{ stock }`, `{ movement_id }`.
- **Embed (JOIN)**: `GET /api/stock` har qatorga `product_name`,
  `product_unit` qo'shadi (`JOIN products`). `GET /api/stock/movements` har
  qatorga `product_name`, `product_unit`, `from_location_name`,
  `to_location_name` qo'shadi (`JOIN products` + `JOIN locations`).
- **Qo'lda movement `reason`**: `POST /api/stock/movement` mijozdan faqat
  `transfer` (ikki tomon: from+to) yoki `adjust` (bir tomon) qabul qiladi.
  Server `reason` ni endpoint shaklidan o'zi aniqlaydi; mijoz yuborsa
  derived qiymatga mos kelishi shart. `purchase`/`sale`/`production_input`/
  `production_output` — faqat tizim (M5/M6/M7) qo'yadi; mijoz yuborsa
  `422 VALIDATION_ERROR`.

### 4.1. Auth
| Metod | Endpoint | Rol | Tavsif |
|---|---|---|---|
| POST | `/api/auth/login` | hammasi | `{email,password}` → `{token, user}` |
| GET  | `/api/auth/me` | autentifikatsiyalangan | joriy foydalanuvchi |

### 4.2. Locations & Users
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/locations` | pm, *_manager | yalang'och massiv `[{id,name,type,parent_id,manager_user_id,...}]` (rol bo'yicha filtr) |
| GET  | `/api/locations/:id` | pm, o'z bo'g'ini | `{location}` |
| POST | `/api/locations` | pm | `{name,type,parent_id,poster_*}` → `201 {location}` |
| PATCH| `/api/locations/:id` | pm | tahrir; `name`, `manager_user_id`, `parent_id`, `is_active`, `lead_time_days`, `review_days`, `safety_factor` → `{location}` |
| GET  | `/api/users` | pm | yalang'och massiv `[{id,name,email,role,...}]` |
| POST | `/api/users` | pm | `{name,email,password,role,location_id,telegram_id}` → `201` |

### 4.3. Products & Recipes
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/products` | pm, *_manager | yalang'och massiv (filtr: `?type=`) |
| POST | `/api/products` | pm, raw_warehouse_manager | `{name,type,unit,sku,poster_*}` → `201` |
| GET  | `/api/products/:id/recipe` | pm, production_manager | BOM ro'yxati |
| PUT  | `/api/products/:id/recipe` | pm, production_manager | `[{component_product_id,qty_per_unit}]` → to'liq almashtirish |

### 4.4. Stock & Movements
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/stock?location_id=` | pm, o'z bo'g'ini | yalang'och massiv `[{location_id,product_id,qty,min_level,max_level,minmax_mode,updated_at,product_name,product_unit}]` |
| PATCH| `/api/stock/minmax` | pm, o'z bo'g'ini manageri | `{location_id,product_id,min_level,max_level}` → `{stock}`. Audit: `stock` kompozit PK — `entity_id=null`, payload da `location_id`+`product_id` |
| POST | `/api/stock/movement` | pm, ombor/sklad/ta'minot man', production | `{product_id,from_location_id?,to_location_id?,qty,reason?,note?}` → `201 {movement_id}`; atomar; yetmasa `409 INSUFFICIENT_STOCK`. `reason` faqat `transfer`/`adjust` (server o'zi aniqlaydi); tizim reasonlari `422` |
| GET  | `/api/stock/movements?location_id=&product_id=&limit=&offset=` | pm, o'z bo'g'ini | `{items,total,limit,offset}`; har item da `product_name,product_unit,from_location_name,to_location_name` |

### 4.5. Replenishment
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/replenishment?status=` | pm, *_manager | ochiq/filtrlangan requestlar (rol bo'yicha) |
| GET  | `/api/replenishment/:id` | pm, bog'liq bo'g'in | request + `transitions` tarixi |
| POST | `/api/replenishment` | pm, central_warehouse_manager | qo'lda request: `{product_id,requester_location_id,qty_needed}` → `201`; dublikat bo'lsa `409 OPEN_REQUEST_EXISTS` |
| POST | `/api/replenishment/:id/advance` | pm, bog'liq rol | state machine'ni keyingi bosqichga; `200 {advanced, status, reason, request}` (yangi resurs yaratilmaydi — transition jurnal yozuvi, audit). `advanced=false` (kutuv guard'i qondirilmagan, SM-4) — ham `200`, xato emas. Noto'g'ri o'tish `409 INVALID_TRANSITION`. Aniqlik: ADR-0001 §10. |
| POST | `/api/replenishment/:id/cancel` | pm | `→ CANCELLED` |

### 4.6. Production orders
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/production-orders?status=` | pm, production_manager | zayafkalar |
| POST | `/api/production-orders` | pm, production_manager, central_warehouse_manager | `{product_id,qty,location_id,target_location_id,deadline?}` → `201` |
| PATCH| `/api/production-orders/:id` | pm, production_manager | `{status}`: `in_progress` / `done` / `cancelled`; `done` da BOM chiqim + sklad kirim atomar; yetmasa `409 INSUFFICIENT_STOCK`. `cancelled` faqat `new` yoki `in_progress` holatdan ruxsat etiladi (`done → cancelled` taqiqlanadi — `409 INVALID_TRANSITION`); bog'liq `replenishment_request` avtomatik bekor qilinmaydi — `pm` qo'lda hal qiladi. Aniqlik: ADR-0001 §11. |

### 4.7. Purchase orders (ikki bosqichli tasdiq)
| Metod | Endpoint | Rol | Request → Response |
|---|---|---|---|
| GET  | `/api/purchase-orders?status=` | pm, supply_manager, raw_warehouse_manager | so'rovlar |
| POST | `/api/purchase-orders` | pm, supply_manager | `{product_id,qty,supplier_id?,target_location_id}` → `201 draft` |
| POST | `/api/purchase-orders/:id/approve` | pm; supply_manager (manager qadami); raw_warehouse_manager (keeper qadami) | `{step:'manager'|'keeper'}`; ikkala qadam bo'lsa → `approved` |
| POST | `/api/purchase-orders/:id/receive` | pm, raw_warehouse_manager | tovar kirimi; `approved → received`; xom-ashyo `stock` atomar oshadi |
| POST | `/api/purchase-orders/:id/reject` | pm, supply_manager | `→ rejected` |

### 4.8. Dashboard
| Metod | Endpoint | Rol | Response |
|---|---|---|---|
| GET | `/api/dashboard/overview` | pm (butun zanjir), *_manager (o'z bo'g'ini) | `{below_min:[...], open_requests:{by_status}, production_plan:[...], recent_movements:[...]}` ; < 1s |

### 4.9. Poster integratsiya (ichki / xizmat)
| Metod | Endpoint | Rol | Tavsif |
|---|---|---|---|
| POST | `/api/integrations/poster/webhook` | (HMAC/token bilan tasdiqlanadi, JWT emas) | Poster webhook qabul qiluvchi; payload `poster_webhook_events` ga yoziladi |
| POST | `/api/integrations/poster/sync` | pm | qo'lda to'liq sinxronizatsiya ishga tushirish |
| GET  | `/api/integrations/poster/status` | pm | oxirgi `poster_sync_log` yozuvlari |

### 4.10. Standart xato kodlari
`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`VALIDATION_ERROR` (422), `INSUFFICIENT_STOCK` (409), `OPEN_REQUEST_EXISTS` (409),
`INVALID_TRANSITION` (409), `POSTER_SYNC_ERROR` (502).

---

## 5. Poster POS ↔ ADIA mapping va sinxronizatsiya

To'liq strategiya: `docs/architecture/adr-0002-poster-sync-strategy.md`.

### 5.1. Entity mapping

> **Muhim aniqlik (`research-analyst`, 2026-05-22).** `storage.getStorageLeftovers`
> javobi **HAR DOIM `ingredient_id` qaytaradi** — ham `type=1` (xom-ashyo), ham
> `type=2` (tayyor mahsulot) elementlari uchun. Ya'ni Poster ostatkada tayyor
> mahsulot ham `ingredient_id` bilan ifodalanadi. Shundan kelib chiqib:
> - `storage.getStorageLeftovers` dagi **barcha element** (type=1 va type=2)
>   `products.poster_ingredient_id` ga map qilinadi — bu ostatka sync uchun
>   yagona join kaliti.
> - `products.poster_product_id` esa **faqat** `menu.getProducts` ro'yxati va
>   savdo cheklaridagi (`dash.getTransaction` qator `product_id`) ID uchun
>   ishlatiladi — ostatka sync da emas.
> - Tipik tayyor mahsulotda **ikkala** ustun ham to'ldiriladi: `poster_product_id`
>   (savdo cheki uchun) va `poster_ingredient_id` (ostatka uchun). Sof xom-ashyoda
>   faqat `poster_ingredient_id`.

| Poster | ADIA | Kalit maydon | Izoh |
|---|---|---|---|
| spot (filial) | `locations` (`type='store'`) | `locations.poster_spot_id` | 5 ta filial → 5 ta `store` location |
| storage (ombor) | `locations` (ombor turlari) | `locations.poster_storage_id` | 25 ta storage → `raw_warehouse` / `central_warehouse` / `production` / `supply` ga ajratiladi (egasi seed vaqtida beradi — §8) |
| `getStorageLeftovers` element — `ingredient_id` (type=1 **va** type=2) | `products` | `products.poster_ingredient_id` | ostatka join kaliti — **barcha** element shu ustunga; type=1 → `raw`/`semi`, type=2 → `finished` |
| menu product (`menu.getProducts`) | `products` (`type='finished'`/`semi`) | `products.poster_product_id` | sotiladigan mahsulotning menu ID si — faqat savdo/menu uchun |
| `storage.getStorageLeftovers` element | `stock` qatori | `(location_id, product_id)` orqali | `storage_ingredient_left` → `stock.qty`; `product_id` `poster_ingredient_id` orqali yechiladi |
| transaction (chek) qatori | `sales` qatori | `sales.poster_transaction_id` + chek qator `product_id` → `products.poster_product_id` | har chek mahsuloti — alohida `sales` qatori |
| `storage.getSuppliers` | `suppliers` | `suppliers.poster_supplier_id` | yetkazib beruvchilar |

### 5.2. `limit_value` ↔ `min_level` munosabati
Poster `storage.getStorageLeftovers` har element uchun `limit_value` (minimal qoldiq alert)
qaytaradi. **`research-analyst` aniqladi:** amaliyotda `limit_value` ko'pincha `"0"`
qaytadi — ya'ni Poster'da minimal qoldiq deyarli sozlanmagan. Demak ko'p mahsulot
uchun `min_level` Poster'dan kelmaydi, **PM qo'lda kiritadi**. Faza-1 da:
- Birinchi sinxronizatsiyada (seed) Poster `limit_value > 0` bo'lsa `stock.min_level`
  ning **boshlang'ich qiymati** sifatida olinadi; `limit_value = 0` (ko'pchilik holat)
  bo'lsa `min_level` `0` qoladi va PM `PATCH /api/stock/minmax` orqali qo'lda kiritadi.
  `max_level` boshida `min_level * 2` yoki PM qo'lda kiritadi.
- Keyin **ADIA `min_level` ustun manba** — Poster `limit_value` qayta o'qib ADIA ni
  yozib yubormaydi (ADIA — orkestratsiya qatlami, D4). `stock.minmax_mode='manual'`.
- Faza-2 da `minmax_mode='dynamic'` qatorlar uchun min/max ni kechki cron `sales_stats_daily`
  dan qayta hisoblaydi (TZ §8.3) — Poster `limit_value` e'tiborga olinmaydi.

### 5.3. Sinxronlash strategiyasi

**Ostatka (stock) — davriy poll:**
- Har 10–15 daqiqada cron har `poster_storage_id` uchun `storage.getStorageLeftovers` chaqiradi.
- Poster `storage_ingredient_left` va ADIA `stock.qty` farqi `adjust` reason'li
  `stock_movement` orqali moslanadi (audit qoladi). Manfiy Poster qoldig'i (`< 0`) —
  `stock.qty=0` ga clamp qilinadi + ogohlantirish `notifications` ga.
- Rate limit: ~5 req/sec dan oshmaydi; 25 storage ketma-ket.

**Savdo (sales) — webhook + fallback poll:**
- Asosiy: Poster `transaction.close` webhook → `/api/integrations/poster/webhook` →
  `poster_webhook_events` ga xom payload. Worker chekni `dash.getTransaction(include_products=true)`
  bilan to'liq oladi, `sales` qatorlarini yozadi, do'kon `stock` ni `sale` movement bilan kamaytiradi.
- Fallback: har 30 daqiqada `dash.getTransactions` bo'yicha oxirgi oynani poll qilib,
  webhook'da yo'qolgan cheklarni qo'shadi (idempotent — `uq_sales_poster_line`).

**Idempotentlik:** `sales` da `(poster_transaction_id, product_id, poster_line_id)` UNIQUE;
`stock_movements` da `(poster_transaction_id, product_id, from_location_id)` partial UNIQUE.

**Kuzatuv:** har run `poster_sync_log` ga (`entity`, `status`, `records_in/applied`, `error_detail`).

### 5.4. Yo'nalish
Faza-1 — **faqat o'qish (read-only)** Poster dan. ADIA Poster ga hech narsa yozmaydi
(write-back Faza 3). Manfiy qoldiq va sync xatoliklari faqat ADIA ichida hal qilinadi.

### 5.5. BOM import strategiyasi (OS-3 — egasi qarori)

**Qaror:** retseptlar (BOM) Poster'dan import qilinadi — **agar mumkin bo'lsa**;
aks holda qo'lda kiritishga fallback. Hujjatlash atamasi: **"import (fallback: qo'lda)"**.

**`research-analyst` topgan holat:**
- `menu.getProducts` (ro'yxat) — ingredient tarkibini **qaytarmaydi**.
- `menu.getProduct` (bitta mahsulot, `product_id` bilan) — ingredient tarkibini
  qaytarishi **mumkin**, lekin `docs/adia-poster-api.md` da to'liq tasdiqlanmagan.
- `menu.getPrepacks` (yarim tayyorlar — Yarim Fabrika ekvivalenti) — yarim tovar
  ingredient tarkibini qaytarishi **mumkin**, xuddi shunday tasdiqlanmagan.

**Faza-1 import oqimi:**
1. `menu.getProducts` bilan barcha menu mahsulotlari ro'yxati olinadi → `products`
   (`poster_product_id`) yaratiladi/yangilanadi.
2. Har bir `poster_product_id` uchun `menu.getProduct` chaqiriladi; javobda ingredient
   tarkibi bo'lsa — `recipes` qatorlari yoziladi (`component_product_id` Poster
   ingredient → `products.poster_ingredient_id` orqali yechiladi).
3. Yarim tayyorlar uchun `menu.getPrepacks` xuddi shunday ishlanadi.
4. Agar real API javobi ingredient tarkibini **qaytarmasa** — o'sha mahsulot BOM siz
   qoladi; PM/production_manager `PUT /api/products/:id/recipe` orqali qo'lda kiritadi.

**Birinchi backend vazifasi (spec talabi):** `backend-engineer` ning Faza-1 dagi
**birinchi ishi** — real API tekshiruvi: `.env` dagi `POSTER_TOKEN` bilan bitta
`product_id` uchun `menu.getProduct` (va bitta prepack uchun `menu.getPrepacks`)
chaqirilib, javob ingredient tarkibini qaytarish-qaytarmasligi aniqlanadi. Natija
`docs/adia-poster-api.md` ga qayd etiladi va shu spec'ning §5.5 holati yangilanadi.
Bu tekshiruv import-vs-qo'lda yo'lini yakuniy belgilaydi — boshqa M2/M5 ishlaridan oldin.

**HOLAT (backend-engineer, 2026-05-23 — Sprint 3, M7):** ✅ Tekshiruv **bajarildi
— BOM import to'liq imkoni bor**. To'liq qayd va real javob namunalari:
`docs/adia-poster-api.md` §8. Asosiy natija:
- `menu.getProduct?product_id=X` type=2 (oddiy taom) mahsulot uchun `ingredients`
  array qaytaradi — har element `ingredient_id` + `structure_brutto/netto` +
  `structure_unit` + `structure_type` bilan.
- `menu.getPrepacks` 1121 ta yarim tayyor qaytaradi — har biri ichida `ingredients`
  array to'liq beradi va `out` (batch yield) maydoni mavjud.
- type=3 mahsulotlar (84 ta — masalan tarif/porsiyali) `ingredients` qaytarmaydi;
  modifikatsiyalar orqali ishlaydi — ular uchun qo'lda yo'l ishlatiladi.

M7 import oqimi `menu.getIngredients` → `menu.getPrepacks` → `menu.getProducts`
ketma-ketligi bilan ishlaydi; qo'lda yo'l (`PUT /api/products/:id/recipe`)
saqlanib qoladi va PM override sifatida ishlatadi.

---

## 6. RBAC matritsasi (TZ §3)

Har rol faqat o'z `location_id` doirasidagi ma'lumotni ko'radi/o'zgartiradi; `pm` — butun zanjir.
`R` = o'qish, `W` = yozish, `–` = ruxsat yo'q, `own` = faqat o'z bo'g'ini.

| Resurs | pm | raw_wh_mgr | production_mgr | supply_mgr | central_wh_mgr | store_mgr | ai_assistant |
|---|---|---|---|---|---|---|---|
| locations / users | RW | R | R | R | R | R(own) | R |
| products / recipes | RW | RW(raw) | RW | R | R | R | R |
| stock (ko'rish) | R | R(own) | R(own) | R(own) | R(own) | R(own) | R |
| stock/movement | W | W(own) | W(own) | W(own) | W(own) | – | – |
| stock/minmax | W | W(own) | W(own) | W(own) | W(own) | W(own) | – |
| replenishment ko'rish | R | R(bog'liq) | R(bog'liq) | R(bog'liq) | R(bog'liq) | R(own) | R |
| replenishment advance | W | W(bog'liq) | W(bog'liq) | W(bog'liq) | W(bog'liq) | – | – |
| production-orders | RW | R | RW(own) | – | RW | – | R |
| purchase-orders | RW (ikkala tasdiq qadami) | RW(keeper qadami) | – | RW(manager qadami) | R | – | R |
| dashboard/overview | R(butun) | R(own) | R(own) | R(own) | R(own) | R(own) | R(butun) |
| Poster sync/status | RW | – | – | – | – | – | R |

Eslatma: `ai_assistant` Faza-1 da faol emas — matritsa Faza-2 ga tayyorlik uchun.
"Bog'liq" = request ning `requester_location_id` yoki `target_location_id` foydalanuvchi
bo'g'iniga teng bo'lsa.

---

## 7. Telegram xabar turlari

`notifications.type` qiymatlari va qabul qiluvchi rol:

| `type` | Trigger | Qabul qiluvchi |
|---|---|---|
| `stock_below_min` | `stock.qty <= min_level` (replenishment scan) | tegishli location manageri |
| `replenishment_created` | yangi `replenishment_request` | requester va target location manageri |
| `production_order_created` | yangi `production_order` | production_manager |
| `production_order_done` | zayafka `done` | central_warehouse_manager, PM |
| `shipment_created` | `SHIP_TO_REQUESTER → CLOSED` (transfer) | requester location manageri |
| `purchase_request_created` | yangi `purchase_order` (`draft`) | supply_manager, raw_warehouse_manager |
| `purchase_request_approved` | `purchase_order → approved` | raw_warehouse_manager, PM |
| `poster_sync_failed` | `poster_sync_log.status='failed'` | PM |
| `negative_stock_detected` | Poster qoldig'i `< 0` | tegishli ombor manageri, PM |

Faza-1 — bir tomonlama xabar (inline tugmasiz). Outbox-worker `telegram_sent=false`
yozuvlarni Grammy orqali yuboradi, muvaffaqiyatda `telegram_sent=true`.

---

## 8. Seed-time konfiguratsiya va qolgan ochiq savol

TZ §16 ochiq savollarining ko'pchiligi egasi tomonidan hal qilingan
(`docs/architecture/decisions.md` + egasining 2026-05-22 qarorlari). Quyida ularning
holati va seed bosqichida to'ldiriladigan konfiguratsiya.

### 8.1. Hal qilingan ochiq savollar

| Savol | Holat | Qaror |
|---|---|---|
| **OS-3 (BOM manbai)** | ✅ Hal qilindi | Poster'dan import (`menu.getProduct` + `menu.getPrepacks`), fallback — qo'lda. To'liq strategiya §5.5. Real API tekshiruvi — `backend-engineer` ning birinchi vazifasi. |
| **OS-4 (Yarim Fabrika lokatsiyasi)** | ✅ Hal qilindi | Yarim Fabrika — alohida `supply` location (`location.type='supply'`), Tort/Perojniy kabi. D2 ikki tomonlama oqim shu location'da kechadi. |
| **OS-5 (tasdiq rollari)** | ✅ Hal qilindi | Purchase order: boshliq qadami = `supply_manager`, skladchi qadami = `raw_warehouse_manager`. Ikkalasi tasdiqlagandan keyin `approved`. `pm` har ikki qadamni ham bajara oladi (super-admin). RBAC matritsasi §6 va state machine §3 shunga moslangan. |

### 8.2. Egasi seed vaqtida beradigan konfiguratsiya (sxemani bloklamaydi)

OS-1 va OS-2 — **arxitektura ochiq savoli emas**, balki seed-time konfiguratsiya.
DB sxema buni allaqachon qo'llab-quvvatlaydi: `locations.poster_storage_id` /
`poster_spot_id` (mapping) va `locations.parent_id` (topologiya). Egasi seed
skriptiga quyidagi ikki jadvalni to'ldirib beradi.

**Shablon A — Poster storage → `location.type` klassifikatsiyasi (OS-1):**
Poster'da 25 ta storage bor; har biri qaysi bo'g'in turiga tegishli ekanini egasi
belgilaydi. (`poster_storage_id` / nomlar real Poster akkauntidan olinadi.)

| poster_storage_id | Poster storage nomi | ADIA `location.type` | ADIA location nomi |
|---|---|---|---|
| _(to'ldiriladi)_ | _(masalan: Основной склад)_ | `central_warehouse` | Markaziy Sklad |
| _(to'ldiriladi)_ | _(masalan: Склад сырья)_ | `raw_warehouse` | Mahsulotlar Ombori |
| _(to'ldiriladi)_ | _(masalan: Производственный цех)_ | `production` | Ishlab chiqarish sexi |
| _(to'ldiriladi)_ | _(masalan: Цех Торт)_ | `supply` | Ta'minot — Tort |
| _(to'ldiriladi)_ | _(masalan: Цех Перожний)_ | `supply` | Ta'minot — Perojniy |
| _(to'ldiriladi)_ | _(masalan: Полуфабрикат)_ | `supply` | Yarim Fabrika |
| ... | ... (25 qatorgacha) | ... | ... |

**Shablon B — zanjir topologiyasi `locations.parent_id` (OS-2):**
Har bo'g'inning yuqori (ta'minlovchi) bo'g'ini. State machine
`NEW → CHECK_STORE_SUPPLIER` da requester ning `parent_id` si `target_location_id`
bo'ladi. (5 do'kon → markaziy sklad → ta'minot bo'limlari → ishlab chiqarish →
xom-ashyo ombori.)

| ADIA location | `type` | `parent_id` (yuqori bo'g'in) |
|---|---|---|
| Do'kon 1..5 | `store` | Markaziy Sklad |
| Markaziy Sklad | `central_warehouse` | Ta'minot bo'limi(lari) — yoki to'g'ridan ishlab chiqarish |
| Ta'minot — Tort / Perojniy / Yarim Fabrika | `supply` | Ishlab chiqarish sexi |
| Ishlab chiqarish sexi | `production` | Mahsulotlar Ombori |
| Mahsulotlar Ombori | `raw_warehouse` | _(yo'q — `NULL`; xariddan to'ldiriladi)_ |

> Eslatma: topologiyaning aniq shakli (markaziy sklad to'g'ridan ishlab
> chiqarishga bog'lanadimi yoki ta'minot bo'limlari oraliqdami) egasining seed
> qaroriga bog'liq. Sxema ikkala variantni ham qo'llab-quvvatlaydi.

### 8.3. Qolgan ochiq savol — egadan/tekshiruvdan tasdiq kerak

- **OS-6 (Poster webhook xavfsizligi):** Poster webhook'lari uchun imzo (HMAC) yoki
  maxfiy token mexanizmi `docs/adia-poster-api.md` da hali yoritilmagan.
  `/api/integrations/poster/webhook` endpoint himoyasi shunga bog'liq. Faza-1
  boshida `backend-engineer` Poster webhook autentifikatsiyasini real akkauntda
  aniqlashi va `docs/adia-poster-api.md` ga qayd etishi kerak; aniqlangunча
  endpoint maxfiy URL-token bilan vaqtincha himoyalanadi.

### 8.4. Sprint 2 audit — kelajakdagi migratsiya/cleanup ro'yxati

Quyidagilar joriy sxemada **mavjud**, lekin kod ulardan foydalanmaydi yoki Faza-1 cheklovi qoldirilgan. Alohida migratsiya bilan keyinroq hal qilinadi (hozir o'chirilmaydi — bu hujjat ishi).

- **Dead enum values — `purchase_order_status`:** `manager_approved` va `keeper_approved` qiymatlari sxemada bor (`db-schema-phase-1.sql`), lekin M6 implementatsiyasi `draft → approved → received` zanjirini ishlatadi (ikki bosqichli tasdiq DB enum holati orqali emas, `manager_approved_by` / `keeper_approved_by` ustunlari orqali bajariladi — har ikkalasi to'ldirilsa `approved` ga o'tadi, AC6.2). **Migratsiya rejasi:** kelgusi cleanup-migratsiya `manager_approved` va `keeper_approved` qiymatlarini `purchase_order_status` enumdan olib tashlaydi. Joriy Faza-1 da o'chirilmaydi — ehtimol Faza-2 da yangi migratsiya bilan birga (chunki PostgreSQL'da enum value'sini olib tashlash `ALTER TYPE ... RENAME TO + CREATE TYPE ... + UPDATE + DROP` ketma-ketligini talab qiladi). Vazifa: `system-architect` / `backend-engineer` Faza-2 boshida.
- **Multi-shortage M:N jadval — `replenishment_purchase_orders` (Faza-2):** Faza-1 da sekvensial sxema saqlanadi (ADR-0001 §12) — bir vaqtda bitta PO, eski PO'lar `audit_log` va `replenishment_transitions` orqali bog'lanadi. Faza-2 da bir requestga ko'p PO ni to'g'ri tasvirlash uchun `replenishment_purchase_orders(replenishment_id, purchase_order_id, created_at)` M:N jadvali qo'shiladi va `replenishment_requests.purchase_order_id` ustuni olib tashlanadi.
- **`production_order_status='cancelled'` ishlatish (Sprint 2 da qo'shildi):** §4.6 PATCH yangilangan — bu yangi qiymat emas (enumda allaqachon bor), faqat ishlatishga ruxsat berildi.
