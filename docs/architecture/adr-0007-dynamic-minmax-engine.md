# ADR-0007 — Dynamic Min/Max Recompute Engine

> Status: **Accepted** · Date: 2026-05-23 · Author: system-architect
> Relates: spec `docs/specs/phase-2.md` §2.1, §5, TZ §8.3, decision D3.

## Kontekst

ADIA ERP'da har `(location_id, product_id)` juftligi uchun `min_level` va
`max_level` belgilangan. Faza-1 da bu qiymatlar **manual** — PM/manager
qo'lda kiritadi (`stock.minmax_mode='manual'`).

Faza-2 da TZ §8.3 ga ko'ra **dinamik min/max** joriy etiladi: tungi cron
sotuv tarixiga qarab har qatorni qayta hisoblaydi. Decision D3 ga muvofiq —
**barcha bo'g'inlarda** (faqat do'konlarda emas).

Formula (TZ §8.3):
```
min_level = avg_daily × lead_time_days × safety_factor   (ROP — Reorder Point)
max_level = min_level + avg_daily × review_days
```

Egasi default'larni belgiladi (2026-05-23):
- `lead_time_days = 2`
- `review_days    = 2`
- `safety_factor  = 1.3`

PM keyin lokatsiya-darajasida o'zgartiradi (`locations.lead_time_days`,
`review_days`, `safety_factor` — Faza-1 schema'da allaqachon mavjud).

## Qaror

### 1. Ikki bosqichli cron arxitekturasi

**Bosqich 1 — Sales aggregate (`sales-aggregate.ts`, `0 3 * * *`):**
- `sales` jadvalidan oxirgi 31 kunlik sotuvlarni `(store_id, product_id,
  stat_date)` bo'yicha guruhlab `sales_stats_daily` ga yozadi.
- Har qatorga `avg_7d` (so'nggi 7 kun) va `avg_30d` (so'nggi 30 kun)
  o'rtacha kunlik sotuv hisoblanadi.
- Idempotent — `INSERT ... ON CONFLICT DO UPDATE`.

**Bosqich 2 — Min/Max recompute (`minmax-recalc.ts`, `0 4 * * *`):**
- `stock` jadvali bo'ylab `minmax_mode='dynamic'` qatorlarini topadi.
- Har qator uchun `avg_daily` ni `sales_stats_daily` dan oladi.
- Formula qo'llaydi → `UPDATE stock SET min_level, max_level`.
- Har qator alohida tranzaksiya; audit yoziladi.

**Nima uchun ikki bosqich:** agregat og'ir (full table scan oxirgi 31
kunda); recalc yengil (PK update). Ikkalasini ajratish operatsion
osonlik (biri muvaffaqiyatsiz bo'lsa — boshqasi ishlamaydi). Sales
aggregate'ni `dash.getTransactions` poll bilan ham almashtirish mumkin
edi, lekin `sales` jadvali allaqachon Poster sync'dan to'ldiriladi.

### 2. Sales aggregate algoritmi

To'liq SQL — `phase-2.md` §5.1.

**Asosiy ikki bosqich:**
1. Kunlik agregat: `INSERT ... ON CONFLICT DO UPDATE` so'nggi 31 kun.
2. Moving average: har qator uchun `avg_7d` va `avg_30d` ni 7/30 kunlik
   oyna ichida hisoblash.

**Performance hisob:**
- 5 do'kon × ~500 mahsulot × 31 kun = ~77 500 qator.
- `INSERT ... ON CONFLICT` — ~1s (idempotent).
- Moving average `UPDATE ... FROM (correlated subquery)` — ~3–5s.
- Jami ~5s — tunda muammo emas.

**Edge case'lar:**
- **Yangi mahsulot:** birinchi sotuv kuni `avg_7d` = `qty_sold / 7`
  (kichik) — bu OK, formula ehtiyotkorlik bilan kichik min/max beradi.
- **Sotuv to'xtagan mahsulot:** so'nggi 7 kun = 0 → `avg_7d = 0` → recalc
  cron qator o'tkazib yuboradi (`avg_daily < EPSILON` guard, §4).
- **Mahsulot delete qilingan:** `sales` qatorlari `ON DELETE RESTRICT` —
  product o'chmaydi (Faza-1 schema kafolatlaydi).

### 3. `avg_7d` vs `avg_30d` — qaysi ustun?

Strategiya: **`avg_7d` ustun manba**, fallback `avg_30d`.

Asos:
- `avg_7d` — eng so'nggi yaqin o'tmish, mavsumiy/haftalik dinamikani aks
  ettiradi.
- Agar `avg_7d` 0 yoki `NULL` bo'lsa (so'nggi 7 kun sotuv yo'q), lekin
  `avg_30d > 0` — mahsulot "uzoq" sotiluvchi bo'lishi mumkin (oyiga 2-3
  marta). Bu holda `avg_30d` ga o'tamiz.
- Ikkalasi ham `NULL`/`0` → recalc qator o'tkazib yuboradi.

**EMA (Exponential Moving Average) muqobili (rad etilgan Faza-2 da):**
- EMA — yangi kunlarga ko'proq vazn beradigan formula. Yaxshi, lekin
  Faza-2 da murakkab — PM uchun "nima nima" tushunarsiz bo'lib qoladi.
- Faza-3 da hot/cold product strategiyasi bilan birga ko'rib chiqiladi.

### 4. Recalc algoritmi (atomar, audit'li)

To'liq pseudo-code — `phase-2.md` §5.2. Asosiy qoidalar:

**Atomicity per row:**
- Har `stock` qatori alohida tranzaksiyada yangilanadi.
- Bitta qator failure butun cron'ni yiqitmaydi — error log yoziladi va
  keyingi qatorga davom.
- Race guard: `UPDATE ... WHERE minmax_mode = 'dynamic'` — agar manager
  bir paytda `manual` ga almashtirgan bo'lsa, recalc o'sha qatorga ta'sir
  qilmaydi.

**Guard: avg_daily epsilon:**
```ts
const EPSILON = 0.001;
if (avg_daily === null || avg_daily < EPSILON) {
  // skip + write import_warning info "no sales history"
  continue;
}
```

Bu — sotuvi to'xtagan mahsulot uchun min/max ni 0 ga tushirib yubormaslik
uchun. PM ko'rsatib turadi va istasa qator-darajada `manual` ga o'tkazadi.

**Guard: zero output:**
```ts
if (max_new < EPSILON) {
  // Suspicious — preserve old, log warning
  insertWarning('warning', 'dynamic recalc would zero out min/max', ...);
  continue;
}
```

**Audit format:**
```json
{
  "entity": "stock.minmax",
  "payload": {
    "location_id": 5,
    "product_id":  42,
    "old": {"min_level": 30.0, "max_level": 60.0},
    "new": {"min_level": 42.0, "max_level": 84.0},
    "formula": {
      "avg_daily": 7.0,
      "source": "avg_7d",
      "lead_time_days": 2.0,
      "review_days": 2.0,
      "safety_factor": 1.3
    }
  },
  "actor_user_id": null
}
```

### 5. `manual` vs `dynamic` mode

**Mode tanlash — qator-darajada:**
- Default: `manual` (Faza-1 da har qator shunday yaratilgan).
- Manager `PATCH /api/stock/minmax-mode {mode:'dynamic'}` orqali yoqadi.
- PM butun zanjir uchun yoqishi mumkin: `POST /api/admin/recalc-minmax`
  + manual UI script (Faza-2 da to'liq UI yo'q — terminal one-liner).

**Nima uchun qator-darajada (location-darajada emas):**
- Bir do'konda asosiy mahsulotlar (non, pirog) — dinamik foydali.
- O'sha do'konda kam sotiladigan mahsulot (masalan, mavsumiy tort) —
  dinamik formula uni 0 ga tushiradi. PM uni `manual` da saqlaydi.
- Bu boshqarish granularligi — UX talab.

**Manual'ga qaytarish:**
- `PATCH ... mode='manual'` — keyingi recalc qator'ga tegmaydi.
- Joriy `min_level`/`max_level` saqlanadi.

### 6. Yangi do'kon / yangi mahsulot

- Sotuv tarixi yo'q (`sales_stats_daily` da qator yo'q yoki `avg_*` `NULL`).
- Recalc o'tkazib yuboradi → default qator saqlanadi.
- PM qo'lda kiritgan boshlang'ich `min_level=10, max_level=20` ishlaydi;
  sotuv to'planganidan keyin (~7 kun) dinamik formula avtomatik ishga
  tushadi.

### 7. Performance va monitoring

**O'lchamlar (estimate):**
- 5 do'kon + 5 ombor = 10 location.
- ~500 mahsulot.
- 10 × 500 = 5 000 stock qator (asosiy holat).
- Hammasi `dynamic` bo'lsa: 5 000 UPDATE × 1ms = ~5s. OK.

**Agar 50 000 qatorga o'sa (kelajakda):**
- Batching: 1 000 qator per transaction.
- Lock contention — har qator alohida tx, ko'p paralleldan saqlanish.
- `EXPLAIN ANALYZE` recalc query va kerak bo'lsa partial index qo'shish.

**Monitoring:**
- Cron run davomida `import_warnings` ga `severity=info` (skip'lar) va
  `severity=warning` (zero output, error) yoziladi.
- PM dashboard'da "So'nggi recalc — N qator yangilandi, M skip, K xato"
  paneli (Faza-2 oxirida qo'shiladi).

### 8. Faza-3 ga qoldiriladigan

- **Hot/Cold product strategiyalar** — mavsumiy koeffitsent, kunlik
  variatsiya (dushanba sotuv yakshanbadan boshqa).
- **EMA** o'rniga SMA.
- **Forecast-based min/max** — Prophet/Holt-Winters bilan kelgusi sotuv
  bashorat.
- **Per-product override** — formula koeffitsentlari mahsulot darajasida
  (hozir faqat location darajada).

## Oqibatlar

**Yaxshi:**
- Self-correcting tizim — sotuv o'sganda min/max o'zi ko'tariladi (TZ
  §15 AC#3).
- Manual override saqlanadi — PM ehtiyotkorlik qila oladi.
- Atomar — bitta failure butun tizimni buzmaydi.
- Audit har o'zgarish uchun (compliance + ishonch).

**Yomon / cheklovlar:**
- Sotuv 0 ga tushgan mahsulot — formula min/max ni 0 ga tushirib
  yuboradi (Guard bilan ushlab qolinadi, lekin PM kuzatishi kerak).
- Yangi mahsulot uchun 7 kun "ko'r" davri — default'lar bilan ishlaydi.
- Kunlik variatsiya (dushanba sotuv ko'p, juma sotuv kam) — formula bunga
  bee'tibor. Faza-3.

## Muqobillar

- **Real-time recalc** (har sotuvda) — rad: og'ir, har sotuvda 5 000
  UPDATE.
- **Haftalik recalc** — rad: TZ §8.3 "har kechasi" deydi; sotuv tez
  o'zgarsa, hafta — uzoq.
- **Manual only (dinamik yo'q)** — rad: D3 va TZ §15 AC#3 majburiy
  qiladi.

## Bog'liq

- `docs/TZ.md` §8.3, §15 AC#3.
- `docs/architecture/decisions.md` D3.
- `docs/specs/phase-2.md` §2.1, §5.
- `docs/architecture/adr-0006-ai-tool-layer.md` (qo'shni Faza-2 ADR).
