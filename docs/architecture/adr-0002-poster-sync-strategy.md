# ADR-0002 — Poster POS sinxronizatsiya strategiyasi

- Status: Qabul qilingan (taklif — egaga tasdiqlashga)
- Sana: 2026-05-22
- Muallif: system-architect
- Bog'liq: D4, `docs/adia-poster-api.md`, `docs/specs/phase-1-mvp.md` §5

## Kontekst

D4 ga ko'ra savdo va ombor ma'lumotlari qo'lda kiritilmaydi — Poster POS dan
sinxronlanadi. ADIA — Poster ustidagi orkestratsiya ("miya") qatlami. Poster'da 5 ta
spot (filial) va 25 ta storage (ombor) bor. Bizga ishonchli, idempotent, kuzatiladigan
sinxronizatsiya kerak.

Cheklovlar:
- Poster rate limit hujjatda yo'q — amaliyotda ~5 req/sec.
- Poster ID lar ADIA ID laridan farq qiladi — mapping kerak.
- Webhook'lar yo'qolishi mumkin (tarmoq) — fallback kerak.
- Poster manfiy qoldiq qaytarishi mumkin (hisob xatosi belgisi).

## Qaror

### 1. Ikki yo'nakli mapping `poster_*` ustunlari orqali
ADIA jadvallarida Poster ID lar saqlanadi: `locations.poster_spot_id` /
`poster_storage_id`, `products.poster_ingredient_id` / `poster_product_id`,
`sales.poster_transaction_id`, `suppliers.poster_supplier_id`. Har biriga partial UNIQUE
indeks — bir Poster entity bir ADIA yozuvga.

**Mapping aniqligi (`research-analyst`, 2026-05-22 — muhim tuzatish).**
`storage.getStorageLeftovers` javobi **HAR DOIM `ingredient_id` qaytaradi** — ham
`type=1` (xom-ashyo), ham `type=2` (tayyor mahsulot) elementlari uchun. Shunга ko'ra:
- Ostatka sync ning yagona join kaliti — `products.poster_ingredient_id`. Leftovers
  dagi **barcha** element (type=1 va type=2) shu ustun orqali ADIA `products` ga
  bog'lanadi. Tayyor mahsulotda `poster_ingredient_id` ham to'ldiriladi.
- `products.poster_product_id` esa **faqat** `menu.getProducts` va savdo cheklarining
  (`dash.getTransaction` qator `product_id`) ID si uchun. Ostatka sync da ishlatilmaydi.
Bu ikki ID ni aralashtirib yuborish — ostatka sync ni butunlay buzadi; mapping
qatlami har birini o'z ustuniga aniq joylashtirishi shart.

### 2. Ostatka — davriy poll (10–15 daqiqa)
`storage.getStorageLeftovers` har `poster_storage_id` uchun. Poster `storage_ingredient_left`
va ADIA `stock.qty` farqi `adjust` reason'li `stock_movement` orqali moslanadi — to'g'ridan
to'g'ri `UPDATE qty` emas, **movement yoziladi** (audit invariantini buzmaydi). Manfiy
Poster qoldig'i `0` ga clamp + `negative_stock_detected` bildirishnoma.

### 3. Savdo — webhook birlamchi, poll fallback
- Birlamchi: `transaction.close` webhook → `/api/integrations/poster/webhook` → xom payload
  `poster_webhook_events` ga (tez javob, async ishlov). Worker chekni
  `dash.getTransaction(include_products=true)` bilan boyitadi, `sales` + `sale` movement yozadi.
- Fallback: har 30 daqiqada `dash.getTransactions` oxirgi oynani poll qiladi — yo'qolgan
  cheklarni qo'shadi.

### 4. Idempotentlik — DB UNIQUE constraint orqali
- `sales`: UNIQUE `(poster_transaction_id, product_id, poster_line_id)`.
- `stock_movements`: partial UNIQUE `(poster_transaction_id, product_id, from_location_id)`.
- `poster_webhook_events`: xom payload saqlanadi, qayta ishlov xavfsiz (idempotent insert).
Takroriy webhook yoki poll bir savdoni ikki marta yoza olmaydi.

### 5. Kuzatuv — `poster_sync_log` + `poster_webhook_events`
Har sync run (`poll`/`webhook`/`manual`) `poster_sync_log` ga (`entity`, `status`,
`records_in/applied`, `error_detail`) yoziladi. Xatolik bo'lsa PM ga `poster_sync_failed`
bildirishnoma. `poster_webhook_events.processed` flag replay imkonini beradi.

### 6. Faza-1 — faqat o'qish
Faza-1 da ADIA Poster ga hech narsa yozmaydi. `limit_value` faqat birinchi seed'da
`min_level` boshlang'ich qiymati sifatida olinadi; keyin ADIA `min_level` ustun manba
(`stock.minmax_mode='manual'`). Write-back — Faza 3.

`research-analyst` aniqladi: amaliyotda Poster `limit_value` **ko'pincha `"0"`**
qaytadi (minimal qoldiq Poster'da deyarli sozlanmagan). Demak ko'p mahsulot uchun
seed `min_level` ni `0` qoldiradi va PM uni `PATCH /api/stock/minmax` orqali qo'lda
kiritadi. Bu Faza-1 da kutilgan holat — sync xatosi emas.

### 8. BOM import (OS-3)
Retseptlar Poster'dan import qilinadi — agar API imkon bersa; aks holda qo'lda
fallback. `menu.getProducts` ingredient tarkibini qaytarmaydi; `menu.getProduct` va
`menu.getPrepacks` qaytarishi mumkin (hujjatda tasdiqlanmagan). To'liq strategiya —
spec §5.5. Real API tekshiruvi `backend-engineer` ning birinchi vazifasi.

### 7. Rate limit hurmati
Sync worker so'rovlarni ketma-ket, ~200ms interval bilan yuboradi (≤5 req/sec). 25 storage
poll'i bitta runda taxminan 5–7 soniya. Xatolikda eksponensial backoff bilan retry.

## Muqobillar

- **Faqat poll (webhooksiz):** rad etildi — savdo kechikadi (10+ daqiqa), real-time
  dashboard talabini buzadi.
- **Faqat webhook (pollsiz):** rad etildi — yo'qolgan webhook'lar ma'lumot bo'shlig'i
  yaratadi; fallback poll zarur.
- **Poster ostatkasini ADIA `stock.qty` ga to'g'ridan-to'g'ri yozish:** rad etildi —
  invariant 1 (har o'zgarish movement + audit) buziladi. `adjust` movement orqali.

## Rate-limit qatlami (C4 — Sprint 3 audit)

Webhook endpoint (`POST /api/integrations/poster/webhook[/:secret]`) JWTsiz
ishlaydi — yagona himoya URL secret. Sirloq oqib chiqsa yoki DoS bo'lsa
`poster_webhook_events` jadvalini yoritmaslik uchun ikki qatlam:

1. **Application qatlam:** `express-rate-limit` IP bo'yicha 60 so'rov/min
   (`routes/posterIntegration.ts`). Test rejimida o'chiriladi.
2. **Nginx qatlami (deploy paytida tavsiya):** `limit_req zone` 120 so'rov/min/IP.

Deploy cheklovlari (PM2 fork, 1 instance) — ADR-0005.

## Oqibatlar

- (+) Real-time savdo (webhook) + ishonchli to'ldirish (poll).
- (+) Idempotentlik DB darajasida — takror sync zararsiz.
- (+) To'liq kuzatuv; xato Telegram orqali ko'rinadi.
- (−) Poster storage → `location.type` klassifikatsiyasi qo'lda sozlanadi — egasi
  seed vaqtida beradigan konfiguratsiya (spec §8.2 Shablon A), arxitektura savoli emas.
- (−) Webhook autentifikatsiyasi hali aniq emas (spec OS-6) — endpoint himoyasi shunga
  bog'liq; `backend-engineer` real akkauntda aniqlaydi.
- Poster — yagona savdo manbai; Poster nosozligi ADIA savdo ma'lumotini to'xtatadi
  (poll fallback yumshatadi).
