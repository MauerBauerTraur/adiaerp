# ADR-0010 — Sales Forecasting Approach (Prophet Sidecar)

> Status: **Accepted** · Date: 2026-05-23 · Author: system-architect
> Relates: TZ §14 (Faza-3 "chuqur analitika, bashorat"), spec
> `docs/specs/phase-3.md` §2.4, ADR-0007 (dinamik min/max).
> Owners decision (2026-05-23): ML asosida bashorat; arxitekt
> aniq texnologiyani tanlasin.

## Kontekst

Faza-3 reja "forecasting + chuqur analitika" ni o'z ichiga oladi
(TZ §14). Talab:
- Har `(location_id, product_id)` juftligi uchun keyingi N kunlik
  sotuv bashorati.
- Asosiy chiqarish: **"X kunda tugaydi"** sanasi (`expected_stockout_date`).
- AI tool `get_forecast` modelga yetkazib beradi.
- Dashboard widget — Top 10 tez tugaydigan tovarlar.
- Mavsumiy davriylik (haftalik — dushanba/yakshanba farqi; yillik —
  bayramlar) e'tiborga olinsin.

**Bizning vaziyatimiz:**
- ~5 do'kon × ~300 mahsulot = ~1500 vaqt qatori.
- Har qator 30–365 kunlik tarix (Poster'dan keladi).
- Loyiha Node.js + PostgreSQL ustida; Python tajribasi cheklangan
  (lekin tushunilgan).
- Deploy — Hetzner VPS, Docker mavjud.

## Variantlar (uchta haqiqiy)

### Variant A — Vertex AI Forecasting (Google managed)

- **Texnologiya:** Vertex AI Tabular Forecasting (BQML yoki AutoML
  Forecasting).
- **Auth:** bizda allaqachon SA — ADR-0006 dan kelgan.
- **Narx (jadval):**
  - AutoML Forecasting training: ~$22/model/training (1 model =
    barcha qatorlar — Vertex tabular schema). Kuniga 1 re-train
    ~$22/kun = ~$660/oy. Bizning hajmga juda qimmat.
  - BQML ARIMA_PLUS: ~$0.02/yokin model + BigQuery storage (10
    GB free, keyin $0.02/GB/oy). 1500 model ~$30/kun
    ~$900/oy.
- **Plus:**
  - Boshqaruvsiz (managed).
  - Avtomatik feature engineering (mavsum, bayram).
  - Vertex API'da kelajakdagi modellar.
- **Minus:**
  - Narx — bizning byudjetdan tashqari (oy boshiga ~$600+).
  - GCP'ga yana bog'liqlik (assistant'dan tashqari yana xizmat).
  - Sozlash murakkab (BigQuery import, schema, training job).
  - Real-time forecast — har so'rovga query latency 1–3s + narx.

### Variant B — Prophet (Python sidecar) ⭐ TANLANGAN

- **Texnologiya:** Facebook (Meta) Prophet `prophet@^1.1`,
  Python 3.12, FastAPI mikroservis, Docker.
- **Avtorizatsiya:** ichki tarmoq + shared secret.
- **Narx:** $0 (OSS, MIT) + ~50 MB RAM, ~5–10 daqiqa CPU har
  kunlik full recompute (1500 qator × ~0.3s).
- **Plus:**
  - **Mavsumiylik native** — haftalik va yillik komponentlar
    avtomatik (bizning do'kon savdosi aniq haftalik tsiklga ega:
    dam olish kunlari savdosi yuqori).
  - **Confidence interval** — `yhat_lower`, `yhat_upper` natively
    (uncertainty quantification).
  - **Kichik dataset'da yaxshi** — 30 kun tarixda ham foydali
    natija (LSTM 200+ kun talab qiladi).
  - **OSS, faol** — Meta tomonidan davom etadi.
  - **Tushunarli** — model parametrlari (trend, seasonality)
    interpretatsion.
- **Minus:**
  - Python kerakli (Node ekotizimidan tashqari).
  - Docker konteyner qo'shimcha deploy ish.
  - Python ↔ Node integratsiya (HTTP) — qo'shimcha qadam.
  - Tashqi rasm'lar (bayramlar) qo'l bilan qo'shilishi kerak.
- **Implementatsiya:**
  - Sidecar `apps/forecaster/` — FastAPI app, `POST /forecast`,
    `GET /healthz`.
  - Backend `forecastCron.ts` kunlik chaqiradi, natija
    `forecasts` DB'ga.
  - AI tool va dashboard DB'dan o'qiydi (real-time emas).

### Variant C — TensorFlow.js LSTM (Node-native)

- **Texnologiya:** `@tensorflow/tfjs-node`, LSTM tarmoq.
- **Narx:** $0 + GPU/CPU. CPU only: ~30s/qator training, 1500
  qator = ~12 soat har kunlik retrain. Bu juda uzun.
- **Plus:**
  - Node ekotizimida qoladi — Python kerak emas.
  - To'liq nazorat (custom arxitektura).
- **Minus:**
  - **Kichik dataset uchun yomon** — LSTM 1000+ data point talab
    qiladi; bizda 30–365 kun (max ~365 nuqta/qator). Overfit
    xavfi katta.
  - Mavsumiylik **manual** — fourier feature'larni qo'lda
    qo'shish kerak.
  - Confidence interval native emas — Bayesian dropout va h.k.
    qo'shimcha murakkablik.
  - CPU'da sekin; GPU Hetzner'da yo'q.
  - Maintenance — biz ML expert emasmiz.

### Variant D — Statik moving average (ML emas)

> Egasi "ML asosida" so'radi — bu rasmiy variant emas, lekin
> baseline sifatida ko'rib chiqildi.

- Oddiy `avg_7d` × kunlar = bashorat.
- ADR-0007 (dinamik min/max) allaqachon shu strategiyani min/max
  uchun ishlatadi.
- **Yetishmaydi:** haftalik tsikl yo'q (dushanba va shanba bir xil
  bashorat), bayramlar yo'q, ishonch oralig'i yo'q.

## Qaror — Variant B (Prophet Python sidecar)

### Asoslar:

1. **Dataset hajmi mos** — 30–365 kun Prophet'ning eng yaxshi
   diapazoni; Vertex'ning afzalligi yo'q.
2. **Narx** — $0 vs $600+/oy. Bizning byudjet uchun katta farq.
3. **Mavsumiy native** — bizning domen (do'kon savdosi) haftalik
   davriylikni aniq talab qiladi.
4. **Maintenance** — Prophet API barqaror (5+ yil), Meta tomonidan
   ta'minlanadi.
5. **Interpretabillik** — PM `trend + weekly + yearly` komponentlarni
   alohida ko'rishi mumkin (Prophet'ning kuchli tomoni).

### Cheklov va riskler:

- Python sidecar deploy — Docker compose entry; DevOps ish
  qo'shadi.
- Sidecar ishlamasa — backend cron `import_warnings`'ga `error`
  yozadi, eski `forecasts` qatorlari saqlanadi (24h gacha
  to'g'ri).
- Yangi mahsulot / yangi do'kon (< 30 kun tarix) — `insufficient_data`
  qaytaradi, `forecasts` yozilmaydi.

### Architectural diagram:

```
┌──────────────┐     daily 04:30 UTC      ┌──────────────────┐
│  forecast    │ ─────────────────────→   │ Prophet sidecar  │
│   cron       │  POST /forecast (batch)  │  (Python+FastAPI)│
│ (Node)       │                          │   Docker         │
└──────────────┘                          └────────┬─────────┘
       │                                            │
       │  ◄── { location_id, product_id, predictions: [...] }
       ▼
┌──────────────┐
│ PostgreSQL   │  forecasts table (cache)
│              │
└──────┬───────┘
       │
       ├── AI tool get_forecast (read)
       └── Dashboard widget (read)
```

## Cache strategiyasi

- **Yangilanish chastotasi:** kuniga 1 marta (`04:30 UTC` —
  `sales-aggregate` (03:00) va `minmax-recalc` (04:00) dan
  keyin).
- **Saqlash:** `forecasts(location_id, product_id)` PK — har
  juftlik uchun **bitta qator**, har kuni overwrite.
- **TTL:** 24h. Yangilanish muvaffaqiyatsiz bo'lsa, dashboard
  `computed_at > 24h` bo'lsa "ESKI" badge ko'rsatadi.
- **Recalc trigger:** `POST /api/admin/forecasts/recalc` (PM
  qo'lda).

## AI tool `get_forecast`

```ts
{
  name: 'get_forecast',
  description: 'Returns sales forecast and expected stockout date for products. Use when the user asks "when will X run out", "predict sales for product Y", or "how long will current stock last".',
  parameters: {
    type: 'OBJECT',
    properties: {
      product_id: { type: 'NUMBER' },
      location_id: { type: 'NUMBER' },
      days_ahead: { type: 'NUMBER', description: 'Forecast horizon (1..30). Default 30.' },
    },
  },
}
```

Executor:
```ts
async execute(args, principal, db) {
  const scopedLocationId = principal.role === 'pm'
    ? args.location_id ?? null
    : principal.locationId;
  return db.query(`
    SELECT f.location_id, l.name AS location_name,
           f.product_id, p.name AS product_name, p.unit,
           f.current_qty,
           f.expected_stockout_date,
           f.total_predicted_demand,
           f.confidence_low, f.confidence_high,
           f.computed_at
      FROM forecasts f
      JOIN locations l ON l.id = f.location_id
      JOIN products  p ON p.id = f.product_id
     WHERE ($1::bigint IS NULL OR f.location_id = $1)
       AND ($2::bigint IS NULL OR f.product_id  = $2)
     ORDER BY f.expected_stockout_date ASC NULLS LAST
     LIMIT 200
  `, [scopedLocationId, args.product_id ?? null]);
}
```

`days_ahead` — `daily_predictions` JSONB'dan birinchi N kun
kesib olinadi (Faza-3 sodda — har doim 30 kun cache; subset
backend formatlash).

## Edge case'lar

| Holat | Xulq | Sabab |
|---|---|---|
| Yangi mahsulot (< 30 kun tarix) | `forecasts` qatori yo'q; AI tool "yetarli ma'lumot yo'q" | Prophet ishonchsiz |
| Yangi do'kon | Xuddi shunday | Xuddi shunday |
| 0 sotuv (mahsulot tugagan) | `expected_stockout_date = today` (allaqachon tugagan) | Foydali signal |
| Sotuv juda kichik (~0.01/kun) | Bashorat yoziladi, `stockout_date` `null` (30 kunda tugamaydi) | Tabiiy holat |
| Sidecar timeout | Cron retry × 3, keyin `import_warnings` | Resilience |
| Prophet model fit muvaffaqiyatsiz (NaN, divergent) | Skip — `forecasts` qatori yangilanmaydi, eski saqlanadi + warning | Graceful degradation |

## Test strategiyasi

- **Sidecar unit test (Python):** sintetik dataset (konstant
  10/kun) → bashorat `yhat ≈ 10`.
- **Backend cron integration test:** mock sidecar response →
  `forecasts` qatorlari yozilishini tasdiqlash.
- **AI tool test:** RBAC scope, `insufficient_data` holati.
- **Acceptance:**
  - 30 kun konstant 10/kun + `stock.qty=100` → bashorat
    `stockout_date ≈ today + 10`.
  - Haftalik tsikl (dushanba 5, shanba 50) → Prophet tsiklni
    "tutsin" — keyingi shanba `yhat ≈ 50`, dushanba `yhat ≈ 5`.

## Narx va mavjudlik

- **Sidecar resurs:** ~512 MB RAM, ~1 vCPU har kunlik run
  (10 daqiqa).
- **Hetzner VPS hozirgi paket:** yetadi (ortiqcha sig'im bor).
- **Docker image hajmi:** ~800 MB (Python slim + Prophet
  bog'liqliklari). Hetzner registry yoki public Docker Hub.

## Deploy eslatma (Sprint-4 implementatsiyasi)

- **Bitta instance.** Prophet fit CPU-bound; horizontal scaling kunlik
  batch'ga foyda bermaydi. `docker-compose.yml` da
  `restart: unless-stopped` qo'yildi — crash bo'lsa avtomatik qaytadi.
- **Tarmoq.** Sidecar `127.0.0.1:8000` ga bind qilingan — tashqi tarmoqdan
  hech qachon ko'rinmaydi. Backend loopback (yoki compose ichki tarmog'i)
  orqali murojaat qiladi.
- **Auth.** `FORECASTER_SHARED_SECRET` env'i. Python tomon `hmac.compare_digest`
  (Node ekvivalenti: `crypto.timingSafeEqual`).
- **Feature gate.** Backend `config.forecaster.enabled` faqat URL VA
  shared secret ikkalasi sozlangandagina true. Sozlanmagan bo'lsa:
  cron startda no-op, `/api/forecasts/recalc` 503, `GET /api/forecasts`
  cache'dan o'qiy beradi (oxirgi muvaffaqiyatli yozuv saqlanadi).

## Oqibatlar

**Yaxshi:**
- $0 ML stack — byudjet siqilmaydi.
- Mavsumiy tabiiy — bizning domen bilan moslashadi.
- Cache strategiyasi sodda — real-time DB query, ML kechikishi
  yo'q.
- Confidence interval — PM ishonchsizlikni ko'radi.
- Faza-4 da hot/cold product strategiyasini Prophet'ning
  `cap`/`floor` parametrlari bilan kengaytirish mumkin.

**Yomon / cheklov:**
- Python ekotizimi qo'shildi — DevOps yangi tajriba.
- Sidecar **deploy noyozlik** — agar Hetzner Docker o'zgarsa
  yoki Python kutubxonalari yangilansa, fit bo'lishi mumkin
  emas. CI'da har deploy oldidan smoke.
- Real-time **emas** — `forecasts` 24h kechikishi mumkin.
  Sprint'da auto-recalc trigger qo'shilishi mumkin (yangi
  stock_movement → forecast invalidatsiya), lekin Faza-3 da
  YO'Q.
- Bayramlar qo'lda — `prophet.holidays` ga O'zbekiston bayramlari
  kerak. Sprint 4 da bir martalik konfiguratsiya.

## Muqobillar (rad etilgan)

1. **Vertex AI Forecasting** — narx (~$600/oy) + sozlash
   murakkabligi.
2. **TF.js LSTM** — kichik dataset uchun yomon, training time
   noaqlli.
3. **Statik moving average** — mavsumiy davriylik yo'q (egasi
   "ML asosida" deb so'radi).
4. **Real-time forecast** (cache yo'q) — sidecar resurslari va
   latency oshadi; bizning use case kunlik yetarli.

## Bog'liq

- `docs/TZ.md` §14 (Faza-3 forecasting).
- ADR-0007 (dynamic minmax) — sotuv stat'lari bir manba'dan.
- Spec — `docs/specs/phase-3.md` §2.4, §5.3.
- Prophet docs: <https://facebook.github.io/prophet/>.
- FastAPI docs: <https://fastapi.tiangolo.com/>.
