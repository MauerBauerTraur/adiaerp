# Dashboard ma'lumotlar inventari — bo'g'inlar bo'yicha

> Sana: 2026-05-25
> Maqsad: Dashboard'ni qayta tuzish uchun har bir bo'g'in (location type) bo'yicha **qanday raqamlar va ma'lumotlar mavjud** ekanligini ko'rsatish. Bu API hujjati emas — DB'da bor narsa.

## 0. Umumiy: ma'lumotlar manbalari

Har bo'g'in ma'lumotlari quyidagi 5 ta yadro jadvaldan keladi:

| Jadval | Mazmuni | Qatorlar (hozir) |
|---|---|---|
| `locations` | Bo'g'inlar (zanjir tugunlari) | 38 |
| `products` | Mahsulotlar (raw / semi / finished) | 783 |
| `stock` | (location, product) → qty, min, max | 2,448 |
| `stock_movements` | Harakatlar (kirim/chiqim/o'tkazma) | 2,637 |
| `sales` / `sales_stats_daily` | Savdo cheklari va kunlik agregat | 15,818 / 894 |

Bo'g'in turlari:
- `raw_warehouse` — 1 ta (Mahsulotlar Ombori)
- `production` — 4 ta (sexlar)
- `supply` — 1 ta (Ta'minot — Tort)
- `central_warehouse` — 26 ta (sklad bloklari, Poster `storage` lari)
- `store` — 6 ta (do'konlar, Poster `spot` lari)

---

## 1. Mahsulot Ombori (Xom-ashyo) — `raw_warehouse`

**Mazmuni:** Zanjirning kirish qismi. Bu yerga Poster'dan import qilingan raw ingredientlar (un, shakar, tuxum va h.k.) yetkazib beruvchilardan keladi. Bu yerdan ishlab chiqarish sexlariga chiqib ketadi.

### KPI / raqamlar

| Raqam | Manba | Formula |
|---|---|---|
| **Xom-ashyo turlari soni** | `products` JOIN `stock` | `COUNT(DISTINCT product_id) WHERE type='raw' AND location_id=<rw>` |
| **Ombordagi mahsulotlar soni** | `stock` | `COUNT(*) WHERE location_id=<rw> AND qty > 0` |
| **Umumiy ostatka qiymati (kg/l/dona)** | `stock` | birlik bo'yicha guruhlangan `SUM(qty)` |
| **Min'dan past pozitsiyalar** | `stock` | `COUNT(*) WHERE qty <= min_level AND min_level > 0` |
| **Ochiq sotib olish so'rovlari** | `purchase_orders` | `COUNT(*) WHERE target_location_id=<rw> AND status IN ('approved')` |
| **Yo'lda kelayotgan miqdor** | `purchase_orders` | `SUM(qty) WHERE status='approved'` (qabul kutmoqda) |
| **Bugun qabul qilingan** | `stock_movements` | `SUM(qty) WHERE to_location_id=<rw> AND reason='purchase' AND created_at::date = current_date` |
| **Bugun chiqarib berilgan** | `stock_movements` | `SUM(qty) WHERE from_location_id=<rw> AND reason='production_input' AND created_at::date = current_date` |

### Vaqt qatori (chart)

- **Ostatka tarixi** — `stock_movements` dan rekonstrukt qilish mumkin (har harakat keyin qoldiq qancha bo'lganini hisoblab).
- **Kunlik kirim/chiqim** — `stock_movements` dan kun bo'yicha agregat (`reason` ga ko'ra).
- **Eng faol mahsulotlar (7/30 kun)** — `stock_movements` da `from_location_id` bo'yicha eng ko'p chiqarilgan top-N.

### Holat ko'rsatkichlari

- Min'dan past mahsulotlar ro'yxati (table) — `qty`, `min_level`, `max_level`, oxirgi yangilangan vaqt.
- Sotib olish so'rovlari status taqsimoti (`pending` / `approved` / `received`).
- Yetkazib beruvchi bo'yicha guruhlash (`purchase_orders.supplier_id`).

### Hozirgi misol qiymatlar

- 378 ta raw mahsulot turi (lekin har biri har bo'g'inda alohida `stock` qatoriga ega)
- 26 ta central_warehouse bo'g'ini har xil omborlar sifatida — har biri o'z qoldig'i bilan

---

## 2. Ishlab Chiqarish — `production`

**Mazmuni:** Ishlab chiqarish sexlari. Bu yerga raw ombordan xom-ashyo kiradi (BOM/recipe asosida), bu yerdan semi/finished mahsulotlar ta'minot bo'limiga yoki to'g'ridan-to'g'ri sklad/do'konlarga chiqib ketadi.

### KPI / raqamlar

| Raqam | Manba | Formula |
|---|---|---|
| **Faol zayafkalar** | `production_orders` | `COUNT(*) WHERE status='in_progress'` |
| **Bugun tugatilgan** | `production_orders` | `COUNT(*) WHERE status='done' AND done_at::date = current_date` |
| **Muddati o'tgan zayafkalar** | `production_orders` | `COUNT(*) WHERE status='in_progress' AND deadline < current_date` |
| **Bugun ishlab chiqarilgan miqdor** | `stock_movements` | `SUM(qty) WHERE reason='production_output' AND to_location_id IN (<prod>)` kun bo'yicha |
| **Bugun ishlatilgan xom-ashyo** | `stock_movements` | `SUM(qty) WHERE reason='production_input' AND from_location_id=<raw_wh>` |
| **Reja bajarilish foizi** | `production_orders` | `done_qty / planned_qty` per order |
| **Sex yuklamasi** | `production_orders` | per `location_id` ochiq orderlar va planlangan miqdor |
| **Eng ko'p ishlab chiqarilgan mahsulotlar** | `stock_movements` | top-N `product_id` by `SUM(qty)` ma'lum davrda |

### Vaqt qatori

- **Kundalik ishlab chiqarish hajmi** — `stock_movements` dan `production_output` bo'yicha kun bo'yicha.
- **Sex bo'yicha solishtirish** — har sex (production location) uchun kundalik chiqim.
- **Eng ko'p talab qilingan resept** — `recipes` JOIN `production_orders`.

### Holat ko'rsatkichlari

- Faol zayafkalar ro'yxati: deadline, mahsulot, miqdor, status, sex.
- Tugagan/in_progress/cancelled taqsimoti.
- Sex bo'yicha tashqi joylashuv (`target_location_id`) — chiqim qaerga ketadi.

### Hozirgi misol qiymatlar

- 4 ta production location
- 185 ta recipe (BOM)
- 4 ta production_order (test seed) — statuslar: `in_progress`, `done`

### Cheklov

- `production_orders` jadvalida `planned_qty` va `done_qty` alohida emas — faqat `qty` (rejalashtirilgan) + `done_at` (tugagan vaqt). Real ishlab chiqarilgan miqdor `stock_movements.qty WHERE production_order_id = X AND reason='production_output'` orqali hisoblanadi.

---

## 3. Ta'minot Bo'limi — `supply`

**Mazmuni:** Ishlab chiqarish chiqimini do'konlarga jo'natish uchun oraliq markaz. Production'dan kelgan finished/semi mahsulotlarni saqlaydi va do'konlarga (yoki markaziy skladga) yo'naltiradi.

### KPI / raqamlar

| Raqam | Manba | Formula |
|---|---|---|
| **Joriy qoldiq** | `stock` | `SUM(qty) WHERE location_id=<supply>` mahsulot turi bo'yicha |
| **Ochiq jo'natma so'rovlari** | `replenishment_requests` | `COUNT(*) WHERE requester_location_id IN (do'konlar) AND status NOT IN ('CLOSED','CANCELLED')` ga supply javob beradi |
| **Bugun jo'natilgan miqdor** | `stock_movements` | `SUM(qty) WHERE from_location_id=<supply> AND reason='transfer' AND created_at::date=current_date` |
| **Bugun qabul qilingan (production'dan)** | `stock_movements` | `SUM(qty) WHERE to_location_id=<supply> AND reason='production_output'` |
| **Tugatilishi yaqin mahsulotlar** | `stock` | `qty <= min_level` |
| **O'rtacha turish vaqti (FIFO)** | `stock_movements` | kelgan vaqt → chiqib ketgan vaqt orasidagi farq (LIFO/FIFO loyihasi kerak) |

### Vaqt qatori

- **Oqim diagrammasi:** kunlik kirim (`production_output`) vs chiqim (`transfer`).
- **Do'kon bo'yicha jo'natma:** qaysi do'konga qancha jo'natilgan kun bo'yicha.

### Holat

- Faol jo'natma kuyish ro'yxati (`replenishment_requests` ga bog'liq).
- Mahsulot turi bo'yicha qoldiq taqsimoti (semi vs finished).

### Hozirgi misol qiymatlar

- 1 ta supply location ("Ta'minot — Tort")
- 3 ta replenishment_request (test seed, status `CLOSED`)

---

## 4. Markaziy Sklad — `central_warehouse`

**Mazmuni:** Asosiy saqlash markazi. Bizning DB'da bu 26 ta blok — Poster'dagi `storage` larga to'g'ri keladi. Har biri o'z qoldig'i va `poster_storage_id` siga ega.

### KPI / raqamlar

| Raqam | Manba | Formula |
|---|---|---|
| **Bloklar soni** | `locations` | `COUNT(*) WHERE type='central_warehouse'` → 26 |
| **Faol bloklar** | `locations` | `WHERE is_active=true` |
| **Umumiy mahsulot turlari** | `stock` | `COUNT(DISTINCT product_id) WHERE location_id IN (cw)` |
| **Umumiy ostatka qiymati** | `stock` | birlik bo'yicha `SUM(qty)` |
| **Min'dan past pozitsiyalar (zanjir bo'yicha)** | `stock` | `COUNT(*) WHERE qty <= min_level AND location_id IN (cw)` |
| **Bo'sh (qty=0) pozitsiyalar** | `stock` | `COUNT(*) WHERE qty = 0` |
| **Poster bilan oxirgi sinxron** | `poster_sync_log` | `MAX(finished_at) WHERE entity='stock'` |
| **Poster sinxron xatolari (24h)** | `poster_sync_log` | `COUNT(*) WHERE status='failed' AND started_at > now() - interval '24 hours'` |
| **Bloklar bo'yicha taqsimot** | `stock` | har blokda nechta mahsulot turi va qancha qoldiq |
| **Eng katta blok (qty bo'yicha)** | `stock` | `SUM(qty)` har location bo'yicha, top-1 |
| **Sinxron clamp qilingan qatorlar** | `poster_sync_log` | `error_detail` da clamped count |

### Vaqt qatori

- **Sinxron tarixi:** har 15 daqiqada poster sync — qancha qator yangilangan kun bo'yicha.
- **Qoldiq dinamikasi:** har blok uchun `stock.updated_at` qatorlari bilan kun bo'yicha o'zgarish.
- **Eng ko'p o'zgarayotgan SKU lar** — `stock_movements` da `to/from_location_id` IN (cw) bo'lganlar top-N.

### Holat

- 26 blokning har biri uchun: mahsulot turlari soni, min'dan past soni, oxirgi sinxron vaqti.
- Poster `last_sync_status` (`ok` / `partial` / `failed`).
- `lead_time_days`, `review_days`, `safety_factor` — har bo'g'in uchun dinamik min/max kirish qiymatlari (TZ 8.3).

### Hozirgi misol qiymatlar

- 26 central_warehouse bloki — har biri Poster `storage` ga bog'langan
- `poster_stock_sync` har 15 daqiqada ishlaydi; oxirgi sync 25 ta storage, 1 adjustment, 496 clamped, 3403 skipped (mahsulot mapping yo'q)
- `poster_sync_log` da 2,026 ta tarixiy sinxron yozuvi

---

## 5. Do'konlar — `store`

**Mazmuni:** Zanjirning chiqish nuqtasi. Bu yerda haqiqiy savdo amalga oshadi (Poster `spot` lariga to'g'ri keladi). Stock kamayadi → min'dan tushganda replenishment so'rovi.

### KPI / raqamlar

| Raqam | Manba | Formula |
|---|---|---|
| **Do'konlar soni** | `locations` | `COUNT(*) WHERE type='store'` → 6 |
| **Bugungi savdo (cheklar soni)** | `sales` | `COUNT(DISTINCT poster_transaction_id) WHERE sold_at::date = current_date` |
| **Bugungi savdo (miqdor)** | `sales` | `SUM(qty)` (har birlik bo'yicha) |
| **Bugungi savdo (so'm)** | `sales` | `SUM(qty * price)` (UZS) |
| **O'rtacha chek (so'm)** | `sales` | `SUM(qty*price) / COUNT(DISTINCT poster_transaction_id)` |
| **Eng ko'p sotilgan mahsulot (bugun)** | `sales` | `top-N WHERE sold_at::date = today GROUP BY product_id` |
| **Joriy qoldiq** | `stock` | `qty` har do'kon uchun |
| **Min'dan past pozitsiyalar** | `stock` | per do'kon |
| **Ochiq replenishment so'rovlari** | `replenishment_requests` | `WHERE requester_location_id IN (stores) AND status NOT IN ('CLOSED','CANCELLED')` |
| **Yo'lda kelayotgan (transit)** | `stock_movements` | `WHERE to_location_id IN (stores) AND replenishment_id IN (open)` |
| **Bashorat (kelajakdagi tugatilish kuni)** | `forecasts.expected_stockout_date` | hozir 0 qator — 30 kun tarix to'planganda paydo bo'ladi |

### Vaqt qatori (eng boy ma'lumot shu yerda)

- **Soatlik savdo profili** — `sales.sold_at` bo'yicha soat-soat agregat (qaysi soatda eng ko'p sotiladi).
- **Kunlik savdo 7/30 kun** — `sales_stats_daily` jadvalida tayyor agregat (har `(store_id, product_id, stat_date)` uchun `qty_sold`, `avg_7d`, `avg_30d`).
- **Hafta kunlari bo'yicha taqsimot** — `sales.sold_at` dan `EXTRACT(DOW)`.
- **Mahsulot bo'yicha kunlik trend** — top-N mahsulot uchun chiziq grafigi.
- **Mavsumlik analizi (oylik agregat)** — `sales_stats_daily` dan `date_trunc('month', stat_date)`.

### Holat

- Har do'kon uchun: bugungi savdo (so'm), ochiq so'rovlar, min'dan past pozitsiyalar.
- Poster `spot_id` mapping holati.
- Sotuvchi (do'kon manageri) — `locations.manager_user_id` orqali.

### Hozirgi misol qiymatlar

- 6 ta do'kon
- 15,818 ta savdo qatori (cheklarning satr-satr versiyasi)
- 894 ta kunlik agregat qator (5 kun × bir nechta mahsulot)
- `sales` jadvalining `sold_at` diapazoni: 1999-12-31 dan 2026-05-25 gacha (eng eski yozuvlar test seed)

---

## 6. Zanjir bo'yicha umumiy KPI (yuqori bar)

Dashboard yuqorisi uchun ushbu raqamlar zanjirning butun ko'rinishi:

| KPI | Hisob |
|---|---|
| **Bugungi savdo** | `SUM(qty * price)` from `sales` where `sold_at::date = today` |
| **Faol zayafkalar** | `production_orders` count where `status = 'in_progress'` |
| **Qizil pozitsiyalar** | `stock` count where `qty <= min_level AND min_level > 0` (butun zanjir) |
| **Tasdiq kutmoqda** | `purchase_orders` + `replenishment_requests` ochiq + tasdiq kutayotganlar |
| **Poster oxirgi sinxron** | `MAX(finished_at)` from `poster_sync_log` |
| **24h sinxron xatolari** | `poster_sync_log` count `status='failed'` last 24h |
| **Bashoratlar tayyorligi** | `forecasts` count > 0 ? yes : "30 kun tarix kerak" |

---

## 7. Vaqt diapazonlari (filter)

Backend `parseDateRange` qabul qiladi:
- `today` — bugun (UTC kun boshidan)
- `week` — oxirgi 7 kun
- `month` — oxirgi 30 kun
- `6m` — oxirgi 6 oy
- `custom` — `from=YYYY-MM-DD&to=YYYY-MM-DD`

Sales / stock_movements jadvallari `created_at` / `sold_at` bo'yicha filtrlanishi mumkin. `sales_stats_daily` `stat_date` (DATE) bo'yicha — TZ shift ehtiyot bo'lish kerak.

---

## 8. Cheklovlar / muhim eslatmalar

1. **Bashorat (`forecasts`):** Prophet 30+ kun tarix talab qiladi. Hozir maksimum 5 kun bor — 30 kun to'planguncha bashorat bo'sh qoladi. `poster:backfill` skripti orqali tarixiy savdolarni tortish mumkin.
2. **`replenishment_requests` faqat 3 ta yozuv** — test seed; real ish boshlanganda statuslar boyiydi (`NEW`, `PRODUCING`, `READY_TO_SHIP`, va h.k.).
3. **`sales_stats_daily` populate cron** har tongda 3:00 da ishlaydi; demo uchun `scripts/sales-agg-now.ts` ni qo'lda yurg'izish mumkin.
4. **Poster `storage` mapping:** 3,403 ta sinxron qatori "skipped" — bu Poster'dagi mahsulot ID lar bizning `products.poster_ingredient_id` ga bog'lanmagan. Bu seed jarayoni to'liqlanmagan.
5. **`location.lead_time_days`, `review_days`, `safety_factor`** — har location uchun dinamik min/max parametrlari. Faza-2 da minmaxRecalcCron shu maydonlardan foydalanadi.
6. **`stock_movements.reason` enum:** `production_input`, `production_output`, `transfer`, `purchase`, `adjust`. Boshqa harakat turlari yo'q.

---

## 9. Tavsiya: dashboard kompozitsiyasi

Bo'g'inlar uchun kelajakdagi dashboard'da quyidagi pattern tabiiy ko'rinadi:

1. **Yuqori bar** — zanjir KPI (4-5 kart): Bugungi savdo · Faol zayafka · Qizil pozitsiya · Tasdiq kutmoqda · Poster sinxron.
2. **Ekosistema chizig'i** — 5 bo'g'in birga (hozirgi `EcosystemHealthBar`), har birida: mahsulot soni, qoldiq holati, ogohlantirish belgi.
3. **Bo'g'in tafsil card'i** (5 ta) — har bo'g'inning o'z mini-dashboard'i:
   - **Raw Warehouse:** ostatka, qabul kutilmoqda, min'dan past
   - **Production:** faol zayafka, bugun ishlab chiqarilgan, sex yuklamasi
   - **Supply:** kirim/chiqim oqimi, do'kon bo'yicha jo'natma
   - **Central Warehouse:** 26 blok solishtirish, Poster sinxron holati
   - **Stores:** 6 do'kon savdosi, soatlik profil, eng faol mahsulot
4. **Savdo chart** — kun/hafta/oy trendi, do'kon bo'yicha.
5. **Bashorat paneli** — `forecasts` jadval tayyor bo'lganda.
