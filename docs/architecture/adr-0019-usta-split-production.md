# ADR-0019 — Ustalar bo'yicha ishlab chiqarish: otdel ichidagi usta-stansiyalar

> Holat: **Taklif** (egasi tasdig'ini kutmoqda)
> Sana: 2026-09-28
> Muallif: system-architect
> Pilot: "Оформления отдел" — 3 usta (Biskvitchi, Zagotovkachi, Ukrasheniye)
> Egasi tasdiqlagan maket: https://claude.ai/artifact/2FAXbjnMW5wcM18cfDkUzv
> Bog'liqlik: D2, D4, D6 (`decisions.md`); ADR-0012 (M:N foydalanuvchi↔lokatsiya),
> ADR-0015 (sex_storage), ADR-0016 (zagatovka → ukrasheniye, `stage_role`),
> ADR-0018 (retsept pariteti, bosqichlar); migration 0041 (`production_dispatches`),
> 0043 (manfiy qoldiq), 0044 (`products.production_location_id`),
> 0047 (`poster_workshop_id`), 0060 (yield-debt).

---

## 1. Kontekst

### 1.1 Egasining ehtiyoji

Ishlab chiqarish otdelida (pilot — "Оформления отдел") bir necha usta xom-ashyoni
**alohida** oladi va ishni bir-biriga topshiradi:

| Usta | Nima qiladi | Kimdan oladi | Kimga topshiradi |
|---|---|---|---|
| Biskvitchi | `бисквит…` yarim tayyorlari | ombordan xom-ashyo | Zagotovkachi |
| Zagotovkachi | `з/г…` zagotovkalar va `крем…` | ombordan xom-ashyo + Biskvitchidan biskvit | Ukrasheniye |
| Ukrasheniye | yakuniy `Г/П` mahsulot | ombordan bezak xom-ashyosi + Zagotovkachidan з/г va krem | Markaziy sklad |

Bugun bitta Г/П zayavka butun otdel uchun **bitta umumiy** xom-ashyo ro'yxatini
beradi — kim nima olgani va kim nimani qarzdorligi ko'rinmaydi.

Tasdiqlangan maket uch chiqishni talab qiladi:

1. **Har usta uchun alohida varaqa (slip):** "Oladi — ombordan" (xom-ashyo, miqdor,
   birlik, belgi katakchasi); "Oladi — <boshqa usta>dan"; "Topshiradi → <qabul qiluvchi>";
   imzo qatorlari.
2. **Omborchi matritsasi:** qatorlar — xom-ashyo, ustunlar — ustalar (egasining
   Excel'idagi kabi: otdellar va ular ichidagi ustalar, masalan "пир заг Мохира",
   "пир укр Дурдона", "торт заг Барно", "торт украш Барно"), "Jami" ustuni, nol
   katak — bo'sh, har ustun uchun imzo qatori.
3. **Kun yakuni hisobi (har usta):** kutilgan chiqim va haqiqatda topshirilgan,
   farq (kamomad — qizil).

`pcs` (tuxum kabi) xom-ashyolar varaqa va matritsada **yuqoriga butun songa
yaxlitlab** ko'rsatiladi; saqlangan miqdor o'zgarmaydi. Model keyinchalik boshqa
otdellarga qayta loyihalashsiz kengayishi shart (Excel'dagi Perojniy va Tort
otdellarida ham zag/ukr ustalari bor).

### 1.2 Bugun kod nima qiladi (tekshirilgan)

- Zayavka `POST /api/production-orders` (`routes/productionOrders.ts:1519`) bitta
  `location_id` bilan yaratiladi.
- Har `semi`/`finished` BOM komponenti uchun **har doim** sub-zayavka ochiladi
  (`createSubOrdersFromBom`, `:1809-1937`; egasi qarori 2026-09-09, `:1836-1843`).
  Sub-zayavka lokatsiyasi — komponentning `products.production_location_id`
  (`:1819-1823`); u bo'lmasa global `stage_role='zagatovka'` lokatsiya, u ham
  bo'lmasa asosiy zayavka lokatsiyasi (`:1795-1804`).
- Poster'dan sinxlangan har mahsulotning `production_location_id`i — uning Poster
  цех'iga mos `production` lokatsiya (`integrations/poster/seedSync.ts:91-170`,
  `:810-820`). Оформления mahsulotlarining hammasi bitta lokatsiyada → hamma
  sub-zayavka va xom-ashyo yozuvlari bitta joyga tushadi → bitta ro'yxat.

---

## 2. Taklif qilingan yo'nalishni tekshirish (dalillar bilan)

Yo'nalish: usta = otdel ostidagi bola `locations` qatori (`parent_id`), yarim
tayyor mahsulot `products.production_location_id` orqali ustaga yo'naltiriladi.

| # | Da'vo | Dalil | Xulosa |
|---|---|---|---|
| 1 | Sub-zayavkalar komponentning `production_location_id`iga tushadi | `productionOrders.ts:1819-1823` | To'g'ri. Nozik joy: fallback asosiy zayavka lokatsiyasi (`:1795`) — usta bo'lsa, tayinlanmagan komponent jimgina Ukrasheniye ishiga aylanadi |
| 2 | Xom-ashyo yozuvlari raw_warehouse → shu lokatsiya | `createDispatchRecords`, `:1699-1708` (faqat to'g'ridan-to'g'ri xom-ashyo); har sub-zayavka o'z yozuvlari bilan (`:1929`) | To'g'ri |
| 3 | Lokatsiyalararo semi topshirish yozuvlari allaqachon yaratiladi | `:1678-1697` | To'g'ri, lekin miqdor `node.qty` (`:1694`), sub-zayavka esa brutto (`:1834`) — varaqada "Topshiradi" bilan ustaning kutilgan chiqimi farq qilishi mumkin. Asosiy zayavkaning yozuvlari yaratilganda avtomatik ko'chiriladi va "qabul qilindi" bo'ladi (`:1739-1785`), ichki (nested) sub-zayavkalarniki esa `pending` qoladi |
| 4 | "Xomashyo berish" lokatsiya bo'yicha guruhlaydi | `WarehouseDispatchPage.tsx:47-63`, `dispatchContext.ts:225-247`, `openMatrixPrint :225-307` | To'g'ri — ustunlar avtomatik usta nomlariga aylanadi, **lekin** otdel guruhi yo'qoladi va production_manager filtri aniq `to_location_id` bo'yicha (`:1230`) — otdel boshlig'i usta yozuvlarini ko'rmay qoladi |
| 5 | Yield-debt reyestri usta kamomadini beradi | `services/yieldDebt.ts:30-79` — `(product, location)` bo'yicha | Mexanizm mos, **lekin ma'lumot kelmaydi**: `actual_qty` faqat `PATCH /:id {status:'done', actual_qty}` orqali (`:2040`, `:2062`), allaqachon `done` bo'lgan zayavkada e'tiborsiz qoldiriladi (`services/productionOrder.ts:165-168`). Sub-zayavkalar va `finished` bo'lmagan asosiy zayavkalar yaratilishi bilan avtomatik `done` bo'ladi (`:1954-1976`, `actual_qty = NULL`). Frontendda `actual_qty` kiritish UI'si yo'q (commit `c23bc09`: "frontend not included") |
| 6 | Poster sync ERP'dagi `production_location_id`ni saqlaydi | `seedSync.ts:311`, `:350` (COALESCE); `syncProductWorkshops :935-939`, `:958-962` faqat NULL'ni to'ldiradi | To'g'ri. Izoh "forcefully writes" (`:898-909`) noto'g'ri. Diqqat: qiymat NULL qilinsa, keyingi sync uni otdelga qaytaradi |
| 7 | `services/autoOrder.ts` o'chirilgan | cron izohga olingan (`workers/posterSalesSync.ts:67`, `:98`); qo'lda trigger bor (`routes/posterIntegration.ts:232-237`) | To'g'ri; u `production_location_id`ni to'g'ridan-to'g'ri ishlatadi — ustaga tushadi (mos) |
| 8 | Poster qoldiq sinxroni ustalarga tegmaydi | `stockSync.ts:42-48` — faqat `poster_storage_id IS NOT NULL`; workshop lokatsiyalarida ham, ustalarda ham yo'q | To'g'ri |

**Xulosa:** yo'nalish to'g'ri va mavjud mexanizmning ko'p qismi ishlaydi. Uch narsa
yetishmaydi: (a) ustani aniq belgilash (legacy "production ostidagi production"
qatorlaridan ajratish uchun), (b) otdel darajasiga yig'ish (roll-up) — RBAC va
guruhlashda, (c) topshirilgan miqdorni keyin yozish (avto-yakunlash sababli).

---

## 3. Variantlar

### Variant A — usta = otdelning bola `locations` qatori + `is_station` belgisi (tanlangan)
Usta — `type='production'`, `parent_id = otdel`, `is_station = TRUE` bo'lgan qator.
Stock, BOM iste'moli, dispatch, topshirish — hammasi mavjud "lokatsiya" o'qida ishlaydi.

**+** Mavjud marshrutlash, dispatch, stock, yield-debt mexanizmlari o'zgarishsiz ishlaydi.
**+** Boshqa otdellarga kengayish — faqat yangi usta qatorlari (qayta loyihalash yo'q).
**+** Usta yo'q joyda xatti-harakat 1:1 saqlanadi.
**−** Bitta kichik additive migratsiya (1 ustun, 1 CHECK, 1 indeks).
**−** Otdel bo'yicha guruhlaydigan/filtrlaydigan joylarni roll-up qilish kerak (§7).

### Variant A0 — xuddi shu, migratsiyasiz ("production ostidagi production" = usta)
**Rad etildi.** Migration 0016/0017 "Tort sexi / Perojniy sexi / Yarim Fabrika sexi"ni
"Ishlab chiqarish sexi" ostiga production→production juftligi sifatida qo'ygan. Ular usta
deb tan olinardi va RBAC roll-up hamda dashboard filtrlari jimgina o'zgarardi. Prod
ma'lumotini bu ishda o'qiy olmaymiz — bitta ustun arzonroq va aniqroq.

### Variant B — usta lokatsiya emas, "ijrochi" ustuni (`production_orders.station_id`, `production_dispatches.assignee`)
**Rad etildi.** Stock, BOM iste'moli (`consumeBomAndProduce` — `order.location_id`dan),
dispatch va topshirish lokatsiyaga bog'langan. Ikkinchi o'q har so'rovda ikki ustunni
tekshirishni talab qiladi (ADR-0015 Variant B rad etilgan sabab bilan bir xil).

### Variant C — har usta alohida yuqori darajadagi otdel (parent'siz)
**Rad etildi.** Otdel identifikatsiyasi yo'qoladi (Excel'da ustalar otdel ichida),
roll-up imkonsiz, Poster workshop bog'lanishi faqat otdelda.

### Variant D — mavjud `locations.stage_role` ustunidan foydalanish
**Rad etildi.** `SELECT id FROM locations WHERE stage_role='zagatovka' LIMIT 1`
(`productionOrders.ts:1797-1800`) global fallback'ni "o'g'irlaydi"; CHECK faqat
`final|zagatovka`ni qabul qiladi (0042).

---

## 4. Qaror

**Variant A.** Usta — otdel ostidagi `is_station = TRUE` production-lokatsiya
("stansiya"). Mahsulot ustaga `products.production_location_id` orqali tayinlanadi.
Hamma o'zgarishlar **usta mavjud bo'lmaguncha no-op** — deploy xavfsiz, xatti-harakat
egasi usta yaratib, mahsulotlarni taqsimlagan paytdan boshlab o'zgaradi.

Terminologiya (kodda):

| Domen | Kod |
|---|---|
| usta | station — `locations.is_station = TRUE` |
| otdel | `type='production'`, `is_station = FALSE` bo'lgan lokatsiya |
| lokatsiyaning otdeli (roll-up kaliti) | `otdel_id = CASE WHEN l.is_station THEN l.parent_id ELSE l.id END` |

---

## 5. Ma'lumot modeli

### 5.1 Migration `0063_location_station.sql` (aniq matn)

```sql
-- 0063_location_station.sql — ADR-0019: usta (work station) sub-locations.
-- Additive, idempotent. No existing row changes (every row gets FALSE).

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_station BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_locations_station_shape;
ALTER TABLE locations ADD CONSTRAINT chk_locations_station_shape CHECK (
  NOT is_station OR (
        type = 'production'
    AND parent_id IS NOT NULL
    AND stage_role IS NULL
    AND poster_storage_id IS NULL
    AND poster_spot_id IS NULL
    AND poster_workshop_id IS NULL
  )
);

CREATE INDEX IF NOT EXISTS ix_locations_station_parent
  ON locations (parent_id) WHERE is_station;

COMMENT ON COLUMN locations.is_station IS
  'ADR-0019 — usta work station: a production sub-location under its otdel '
  '(parent_id). ERP-only, never mapped to Poster; parent must be a non-station '
  'production location (enforced in the application).';
```

- PG 14.23: doimiy default bilan `ADD COLUMN` — faqat metadata, jadval qayta yozilmaydi.
  CHECK validatsiyasi ~30 qatorni skanerlaydi. `IF NOT EXISTS` / `DROP … IF EXISTS` —
  qayta ishga tushirish xavfsiz.
- **Deploy (DEPLOY.md §4):** `npm run migrate` ISHLATILMAYDI. Faqat bitta fayl:
  `python deploy/apply_migration.py 0063_location_station.sql` — **koddan oldin**
  (`is_station`ni o'qiydigan kod migratsiyadan keyin deploy qilinadi).
- **Rollback:** `ALTER TABLE locations DROP COLUMN is_station;` — faqat bironta usta
  qatori bo'lmasa. Usta qatorlari bo'lsa — qaytarib bo'lmaydigan amal, egasi tasdig'i
  kerak.

### 5.2 Ilova darajasidagi qoidalar (CHECK ifoda eta olmaydigan)

1. Ota (`parent_id`) — faol, `type='production'`, `is_station = FALSE` (chuqurlik = 1).
2. Hech bir lokatsiyaning `parent_id`i usta bo'la olmaydi (sex_storage ham).
3. `is_station` faqat yaratishda o'rnatiladi; `PATCH` uni o'zgartira olmaydi.
4. Nom: `"<otdel nomi> · <usta>"` ko'rinishida saqlanadi (masalan
   `"Оформления отдел · Biskvitchi"`), bir otdel ichida takrorlanmaydi (katta-kichik
   harfsiz). Sabab: backend va frontendda `location_name` ~300 marta uchraydi
   (bildirishnomalar, ro'yxatlar, print) — to'liq nom ularning hammasini o'zgartirmasdan
   tushunarli qiladi. Matritsa sarlavhasi otdel prefiksini olib tashlab ko'rsatadi.
   Poster workshop nomi bilan to'qnashuv yo'q (`upsertWorkshopLocation` aniq ILIKE
   tengligi bilan qidiradi, `seedSync.ts:104-117`).
5. `manager_user_id` ixtiyoriy; bo'lmasa bildirishnoma otdel boshlig'iga ketadi (D6).
6. Ustalarga `location_flows` va min/max qo'yilmaydi.
7. Faolsizlantirish (`is_active=false`) — ustaga tayinlangan mahsulot yoki ochiq
   (`new|in_progress`) zayavka bo'lsa 409 `CONFLICT` (sonlari bilan).

### 5.3 Ustadagi qoldiq (stock)

Ustadagi qoldiq — **tranzit/hisobdorlik** qoldig'i: xom-ashyo ustaga beriladi va
zayavka yakunlanganda BOM bo'yicha shu ustadan iste'mol qilinadi; yarim tayyor
ustada chiqariladi va topshirish yozuvi bilan iste'molchi ustaga ko'chadi. To'liq
tsikldan keyin qoldiq ≈ 0; manfiy qoldiq = "usta qarzdor" (ma'nosi 0043 bilan bir xil —
manfiy qoldiqqa ruxsat allaqachon mavjud). Poster sinxlanmaydi (`poster_storage_id`
yo'q). `min_level = max_level = 0` → replenishment skani o'tkazib yuboradi
(`max_level > 0` sharti).

---

## 6. Marshrutlash (routing)

### 6.1 Yakuniy Г/П zayavka Ukrasheniye'ga qanday tushadi

**Ikkalasi ham, lekin haqiqat manbai — server.**

- **Server (majburiy):** yangi `services/productionStations.ts` →
  `resolveProductionLocation(tx, requestedLocationId, productId)`:
  1. so'ralgan lokatsiya usta bo'lsa → o'zi;
  2. aks holda, mahsulotning `production_location_id`i **shu otdelning faol ustasi**
     bo'lsa → o'sha usta;
  3. aks holda → so'ralgan lokatsiya (masalan, mahsulot boshqa otdelda bir martalik
     tayyorlanyapti — tegilmaydi).

  Chaqiriladigan joylar: `POST /api/production-orders` (validatsiyadan keyin, INSERT
  oldidan, `:1528-1568`), AI `create_production_order` (`integrations/vertex/tools/write.ts:687-701`).
  Audit payload: `{ requested_location_id, location_id }`. Sabab: Telegram, AI va har
  qanday klient bir xil natija oladi; forma xatosi usta tartibini buzmaydi.
- **Forma (qulaylik):** ochiladigan ro'yxatda faqat otdellar (ustalar yashirin).
  Mahsulotning `production_location_id`i usta bo'lsa, forma uning **otdelini** tanlaydi
  va ostida izoh ko'rsatadi: *"Bu mahsulot «Оформления отдел · Ukrasheniye» ustasida
  tayyorlanadi"*. Hozirgi forma usta id'sini to'g'ridan-to'g'ri qo'yadi
  (`ProductionOrderFormDialog.tsx:315-331`) — scoped menejer ro'yxatida bu variant yo'q,
  shuning uchun otdelga xaritalanadi.
- `GET /bom-preview` (`:429-443`): `suggested_location_id` → otdel; yangi maydon
  `suggested_station: {id, name} | null`.

### 6.2 Sub-zayavkalar Biskvitchi / Zagotovkachi'ga

Mexanizm o'zgarmaydi: `createSubOrdersFromBom` komponentning `production_location_id`ini
oladi (`:1819-1823`) — `бисквит…` → Biskvitchi, `з/г…`, `крем…` → Zagotovkachi.
**Bitta tuzatish:** fallback bazasi `locationId` emas, `otdelOf(locationId)` bo'ladi
(`:1795`) — tayinlanmagan komponent Ukrasheniye'ga emas, "otdel (umumiy)"ga tushadi va
ko'rinadi.

### 6.3 Ustalararo topshirish (hand-off) qanday yoziladi

- `createDispatchRecords` (`:1678-1697`) iste'molchi zayavka uchun
  `from = ishlab chiqaruvchi usta`, `to = iste'molchi usta` bo'lgan
  `production_dispatches` qatorini yaratadi (sub-zayavka bilan 1:1 —
  `production_order_id = S.parent_production_order_id`, `product_id = S.product_id`,
  `from_location_id = S.location_id`).
- Stock harakati: `reason='transfer'`, `production_order_id = iste'molchi zayavka`,
  `allowNegative`. Asosiy zayavka qatorlari yaratilishi bilan ko'chiriladi
  (`:1739-1785`); ichki sub-zayavkalarniki `pending` qoladi va "Topshirildi" amali
  bilan yopiladi (§8.3).
- **Tuzatish:** topshirish qatori miqdori sub-zayavka miqdori bilan bir xil bo'ladi
  (`neededQty`, brutto qoidasi — `:1834`), `node.qty` emas (`:1694`).
- Yakuniy Г/П: mavjud "tayyor mahsulot" qatori `Ukrasheniye → Markaziy sklad`
  (`:1717-1732`) — o'zgarmaydi, markaziy sklad qabul qiladi.

### 6.4 Misol — "Г/П Медовик × 10" (pilot)

| Zayavka | Usta | Xom-ashyo yozuvi | Topshirish yozuvi |
|---|---|---|---|
| F: Г/П Медовик 10 | Ukrasheniye | bezak xom-ashyosi → Ukr (avto) | Ukr → Markaziy sklad (Г/П 10) |
| S1: з/г медовик 10 (ota F) | Zagotovkachi | xom-ashyo → Zag (pending) | Zag → Ukr (з/г 10, avto) |
| S2: крем 1.2 kg (ota F) | Zagotovkachi | xom-ashyo → Zag (pending) | Zag → Ukr (крем 1.2, avto) |
| S3: бисквит 2 kg (ota S1) | Biskvitchi | xom-ashyo → Bisk (pending) | Bisk → Zag (бисквит 2, pending) |

Bu maketning uch varaqasiga aynan mos keladi (§8.1).

### 6.5 `consumeBomAndProduce` / `stage_role` — marshrutlash nimani o'zgartiradi

- O'zgaradigan yagona narsa — **qayerda** iste'mol qilinishi: BOM `order.location_id`dan
  sarflanadi (`services/productionOrder.ts:106`) → endi usta; sub-zayavka chiqimi
  `target_location_id` NULL bo'lgani uchun ustaning o'ziga tushadi (`:82`).
- `stage_role` → `readBaseBom` / `readFinalBom` tanlovi (`:94-97`, `services/bom.ts:45-80`)
  **o'zgarmaydi**. Sub-zayavka `stage_role='zagatovka'` (`:1864`), yakuniy — `final`.
- **Oldindan mavjud nomuvofiqlik (ustalar uni ko'rinadigan qiladi):** dispatch va
  sub-zayavka yaratish `expandBom` orqali **barcha bosqichlarni** o'qiydi
  (`productionOrders.ts:95-107`), iste'mol esa bosqich bo'yicha filtrlanadi. Bo'lingan
  (decoration qatori bor) Г/П retseptida `base` bosqich xom-ashyosi Ukrasheniye
  varaqasida chiqadi, lekin u yerda iste'mol qilinmaydi. `readBaseBom` faqat `'base'`ni
  o'qiydi, UI esa `dough|cream|other` ham yozadi (`routes/products.ts:609-631`,
  migration 0059). Choralar: preview pilot Г/П'lari orasida bo'lingan retseptlarni
  ogohlantiradi; tuzatish — B9 (§13).

### 6.6 Replenishment va production dialog

- `resolveTopology` (`services/replenishment.ts:1294-1360`) so'rovchidan **yuqoriga**
  yuradi; ustalar barg (leaf), hech qachon ajdod emas → ta'sir yo'q. Replenishment
  zayavkalari zanjirning production lokatsiyasiga tushadi (pilotga tegmaydi).
- `createDialogForOrder` (`services/productionDialog.ts:226`) production kodida
  chaqirilmaydi (faqat testlarda). Qayta yoqilsa: sex_storage'ni ustadan emas,
  otdeldan izlash kerak (`:187-193`) — "Keyin".

---

## 7. Roll-up inventari — otdel bo'yicha guruhlaydigan/filtrlaydigan joylar

Umumiy mexanizm:
- `authenticate` (`middleware/authenticate.ts:60-64`) `locationIds`ga biriktirilgan
  otdellarning ustalarini ham qo'shadi (bitta so'rov, `UNION`); `principal`ga
  `stationsByOtdel` xaritasi (ixtiyoriy maydon — test fixture'lari buzilmaydi).
  Ustaga to'g'ridan-to'g'ri biriktirilgan foydalanuvchi otdelni **olmaydi** (faqat pastga).
- `getEffectiveLocationIds` (`lib/principal.ts:71-81`) → `[active, ...stations(active)]`.
  `requireLocationOperator` (`:103-126`) va `assertLocationAccess` (`:47-57`) avtomatik
  ishlaydi.
- O'qish modellari har qatorga `otdel_id`, `otdel_name`, `station_id`, `station_name`
  qo'shadi; frontend `user.location_id` bilan `otdel_id`ni solishtiradi.

| # | Joy (fayl:qator) | Hozir | Kerakli xatti-harakat | O'zgarish | Bosqich |
|---|---|---|---|---|---|
| 1 | `middleware/authenticate.ts:60-64` | `locationIds` = faqat `user_locations` | otdel + uning ustalari | UNION so'rov + `stationsByOtdel` | MVP |
| 2 | `lib/principal.ts:71-81` | `[activeLocationId]` | `[active, ...ustalari]` | helper | MVP |
| 3 | `routes/productionOrders.ts:207-216` (GET ro'yxat RBAC) | `po.location_id = primary` | `= ANY(effective)` | SQL | MVP |
| 4 | `productionOrders.ts:222-252` (ro'yxat SELECT) | `location_name` | + `otdel_id/otdel_name/station_id/station_name` | JOIN | MVP |
| 5 | `productionOrders.ts:322-351`, `:366-387` (daily-dispatch) | `to_location_name`, `from_location_type` | + `to_otdel_id/name`, `to_is_station`, `from_is_station`, `from_otdel_id` | JOIN | MVP |
| 6 | `productionOrders.ts:429-443` (bom-preview) | `suggested_location_id` = usta | otdel + `suggested_station` | helper | MVP |
| 7 | `productionOrders.ts:453-467`, `services/yieldDebt.ts:82-107` | aniq `location_id`, RBAC yo'q | otdel → otdel+ustalar; scoped menejer — faqat effective | SQL + RBAC | MVP |
| 8 | `productionOrders.ts:510-516`, `:537-557`, `:719-749` (cost-summary / Ishlab chiqarish hisoboti) | primary / aniq, lokatsiya bo'yicha guruh | otdel bo'yicha guruh, ichida `stations[]`; filtr otdel+ustalar | SQL + JS | MVP |
| 9 | `productionOrders.ts:1199-1242` (Telegram "Xomashyo berildi") | `to_location.manager_user_id` (usta → NULL → xabar yo'q) | usta menejeri ?? otdel menejeri; bitta xabar/otdel, ustalar bo'limlab | JS | MVP |
| 10 | `productionOrders.ts:1558-1566` + INSERT | RBAC so'ralgan lokatsiyada | + `resolveProductionLocation` | helper | MVP |
| 11 | `productionOrders.ts:1795-1804` (fallback) | asosiy lokatsiya | `otdelOf(locationId)` | 1 qator | MVP |
| 12 | `productionOrders.ts:1689-1695` (topshirish qatori) | `node.qty` | sub-zayavka `neededQty` | 1 qator | MVP |
| 13 | `routes/dashboard.ts:236-245`, `:338-373` (overview production plan) | primary | effective set | SQL | MVP |
| 14 | `dashboard.ts:953-1030` (chain flow tugunlari) | har production lokatsiya tugun | ustalar tugun emas (`AND NOT l.is_station`); otdel tugunidagi aktiv/bugun-tayyor sonlari ustalarnikini ham qo'shadi | SQL | MVP |
| 15 | `dashboard.ts:1312-1323` (`sex_count`) | barcha production | ustalarsiz | SQL | MVP |
| 16 | `dashboard.ts:1952-2005` (chain layer ro'yxati) | barcha production | ustalarsiz | SQL | MVP |
| 17 | `routes/dashboardDetail.ts:656-688` (sex load) | lokatsiya bo'yicha | otdel bo'yicha (ustalar yig'ilgan) | SQL | MVP |
| 18 | `routes/stock.ts:508-517` (Ostatka hisoboti) | scoped → faqat primary | effective set ichidagi istalgan lokatsiya (usta tanlash); otdel+ustalar agregati | RBAC / SQL | MVP (ruxsat) / Keyin (agregat) |
| 19 | `stock.ts:145-160` (GET /api/stock) | primary | effective set | RBAC | MVP |
| 20 | `stock.ts:894-960` (finished-by-location) | primary, ustalar ko'rinadi | ustalarsiz; effective | SQL | MVP |
| 21 | `routes/locations.ts:208-245`, `:264`, `:289`, `:383` | ro'yxatda hammasi; scoped → primary | default ustalarsiz (`include_stations=1` bilan); scoped → effective; POST/PATCH §5.2 qoidalari | SQL + validatsiya | MVP |
| 22 | `integrations/telegram/dispatch.ts:676-693`, `:1132-1146`, `:1301-1306` | `principal.locationId !==` | scope helper (`loadScopeLocationIds`) | JS | MVP |
| 23 | `telegram/commands/jonatishCommand.ts:58-63`, `zayavkalarCommand.ts:57-58` | `= primary` | `= ANY(scope)` | SQL | MVP |
| 24 | `integrations/vertex/tools/write.ts:197-200`, `:687-701` | primary; resolution yo'q | scope + `resolveProductionLocation` | JS | MVP |
| 25 | `integrations/vertex/tools.ts:87-90` (AI o'qish scope) | primary | effective | JS | Keyin |
| 26 | `routes/nakladnoy.ts:54-56` + `services/nakladnoy.ts` | `getEffectiveLocationIds` | #2 orqali avtomatik; servis o'zgarmaydi | — | — |
| 27 | `services/productionDialog.ts:187-193` | sex_storage — lokatsiyaning bolasi | otdeldan izlash | JS | Keyin (o'lik yo'l) |
| 28 | `services/replenishment.ts`, `services/autoOrder.ts` | — | o'zgarmaydi (§6.6, §2 #7) | — | — |
| 29 | `apps/frontend/src/pages/production-orders/WarehouseDispatchPage.tsx:47-63`, `:1206`, `:1228-1235`, `:1259-1268`, `:1438-1444`, `:309-470`, `:225-307` | lokatsiya bo'yicha guruh; aniq `to_location_id` filtri | otdel guruhi ichida usta bo'limlari; filtr `to_otdel_id`; matritsa §8.2; "Usta varaqalari" print §8.1 | UI | MVP |
| 30 | `pages/production-orders/dispatchContext.ts:225-247`, `:173-191` | nom bo'yicha ustunlar | ustun guruhlari; `buildStationSlips`; nom o'rniga id bo'yicha moslash | sof funksiya | MVP |
| 31 | `ZagotovkaPage.tsx:40-52`, `:517-531` | sub-zayavka / ota lokatsiyasi | otdel bo'yicha guruh, usta belgisi bilan | UI | MVP |
| 32 | `KremKaymokchiPage.tsx:420` | `parent.location_id` | `parent.otdel_id` | UI | MVP |
| 33 | `ProductionOrdersPage.tsx:489`, `:640-652`, `:268-300`, `:165-200` | aniq `location_id` | `otdel_id` bo'yicha filtr/chip/matritsa | UI | MVP |
| 34 | `ProductionCostReport.tsx:261-262` | `g.location_id === user.location_id` | otdel guruhi + usta tafsiloti | UI | MVP |
| 35 | `ProductionOrderFormDialog.tsx:283-331` | usta id'si qo'yiladi | otdel + izoh (§6.1) | UI | MVP |
| 36 | `pages/chain/ProductionPage.tsx:460-560` (sub-bo'lim daraxti) | `parent_id` daraxti | ustalar "usta" belgisi bilan | UI | Keyin |
| 37 | `pages/products/ProductsPage.tsx:147-160`, `:315-325` (bulk) | production lokatsiyalar | ustalar otdel ostida guruhlangan | UI | Keyin (MVP'da sehrgar §9) |

---

## 8. Chiqish shakllari

### 8.1 Usta varaqasi (slip)

Ma'lumot — `GET /api/production-orders/daily-dispatch` `dispatch_items` (§7 #5 maydonlari
bilan). Frontend sof funksiyasi `buildStationSlips(items, otdelId)` (`dispatchContext.ts`,
unit-testlanadi):

| Bo'lim | Filtr (usta `S` uchun) | Yig'ish |
|---|---|---|
| **Oladi — ombordan** | `to_location_id = S` va `from_location_type = 'raw_warehouse'` | mahsulot bo'yicha yig'indi; `pcs` → yuqoriga butun (§8.2) |
| **Oladi — X dan** | `to_location_id = S`, `from_location_id = X ≠ S`, `from_location_type = 'production'` | `(X, mahsulot)` bo'yicha; X nomi otdel prefiksisiz |
| **Topshiradi → Y** | `from_location_id = S`, `product_type ∈ {semi, gp, finished}` | `(Y, mahsulot)`; Y — boshqa usta yoki "Markaziy sklad" |
| Imzolar | "Berdi (omborchi)", "Oldi (usta)", "Topshirdi", "Qabul qildi" | — |

Har usta — alohida sahifa (A4, `page-break-after`), sarlavha: otdel · usta, sana,
zayavkalar soni. Katakcha — bo'sh (qog'ozda belgilanadi); holat (`dispatched/received`)
ekranda ko'rsatiladi. Bir usta ichidagi yarim tayyor (ishlab chiqaruvchi = iste'molchi)
topshirish yozuvi yaratmaydi → varaqada chiqmaydi (to'g'ri: ichki ish).

### 8.2 Omborchi matritsasi

- Qatorlar — xom-ashyo (`raw` tab elementlari), ustunlar — guruhlangan:
  - ustasi yo'q otdel → bitta ustun (hozirgidek);
  - ustali otdel → sarlavha guruhi (`colspan`) + har usta ustuni + faqat otdelning o'ziga
    yo'naltirilgan yozuv bo'lsa `"(umumiy)"` ustuni.
- "Jami" ustuni, nol katak bo'sh, `tfoot`da "Imzo" qatori (har ustun uchun bo'sh katak).
- **Yaxlitlash:** `displayQty(q, unit) = unit === 'pcs' ? Math.ceil(Math.round(q * 1e4) / 1e4) : q`
  — avval `(ustun, mahsulot)` bo'yicha yig'iladi, keyin yaxlitlanadi; faqat xom-ashyo
  bo'limlarida (yarim tayyor `pcs` o'zgarmaydi). **Jami = ko'rsatilgan kataklar yig'indisi**
  (ombordan jismonan chiqadigani). Misol: 2.3 + 1.2 tuxum → 3 va 2, Jami 5.
  Saqlangan miqdor va stock harakatlari o'zgarmaydi; xom-ashyo ombori Poster'dan
  sinxlanadi va farqni o'zi to'g'rilaydi.

### 8.3 Kun yakuni hisobi (har usta)

**`actual_qty` bugun qanday yoziladi (tekshirildi):** faqat `PATCH /:id {status:'done', actual_qty}`
(`productionOrders.ts:2040`, `:2062`); allaqachon `done` zayavkada e'tiborsiz
(`services/productionOrder.ts:165-168`); sub-zayavkalar va `finished` bo'lmagan asosiy
zayavkalar yaratilishi bilanoq avtomatik yakunlanadi (`:1954-1976`). Demak bugungi
yo'l bilan usta topshirgan miqdorni yozib **bo'lmaydi**.

**Qaror — "topshirildi"ni keyin yozish (post-hoc):**

`POST /api/production-orders/:id/delivery { delivered_qty }` (va batch). Bitta
tranzaksiyada:
1. Zayavka `FOR UPDATE`; `cancelled` → 409 `INVALID_TRANSITION`.
2. `new|in_progress` → `completeProductionOrder(id, actor, tx, delivered_qty)` (PATCH done
   yo'lidan ajratilgan umumiy servis: BOM **buyurtma** miqdorida sarflanadi, chiqim =
   delivered, yield delta, replenishment advance, allocations, tayyor mahsulot yozuvi).
3. `done` → tuzatish: `prev = COALESCE(actual_qty, qty)`, `delta = delivered − prev`;
   `delta ≠ 0` bo'lsa chiqim lokatsiyasida (`target_location_id ?? location_id`)
   `reason='adjust'` harakati (`delta<0` — chiqim, `allowNegative`; `delta>0` — kirim),
   `applyYieldDelta(product, order.location_id, delta)`, `actual_qty = delivered`.
4. Sub-zayavka bo'lsa: shu **otdel ichidagi** `pending|dispatched` topshirish qatorlarini
   yopadi (`movement_id` NULL bo'lsa bir marta `transfer` harakati, so'ng `received`).
   Otdellararo qatorlar qabul qiluvchiga qoladi; Г/П → markaziy sklad qatoriga tegilmaydi.
5. Audit: `production_order.delivery` `{before, after, delta, handoffs_closed}`.

Natija: qarz ishlab chiqaruvchi ustada qoladi (manfiy qoldiq + ochiq yield-debt =
"usta X ta qarzdor"); keyingi ortiqcha ishlab chiqarish qarzni FIFO yopadi (mavjud mantiq).

**Ko'rinish** (`GET /api/production-stations/accounting?otdel_id&from&to`):

| Ustun | Manba |
|---|---|
| Kutilgan | `Σ production_orders.qty`, `location_id = S`, `status <> 'cancelled'`, `COALESCE(deadline, created_at::date)` oraliqda (daily-dispatch bilan bir xil sana qoidasi) |
| Topshirildi | `Σ COALESCE(actual_qty, qty)`; `actual_qty IS NULL` → "tasdiqlanmagan" (kulrang) |
| Farq | topshirildi − kutilgan; manfiy — qizil |
| Oldingi qarz | ochiq `production_yield_debts` `(product, S)` |

Kiritish `(usta, mahsulot)` bo'yicha; bir nechta zayavka bo'lsa frontend sof funksiyasi
`distributeDelivered` FIFO taqsimlaydi (har biriga `min(qty, qolgan)`, ortig'i
oxirgisiga). "Hammasi to'liq topshirildi" tugmasi tasdiqlanmaganlarni `delivered = qty`
bilan yopadi. `(umumiy)` bo'limi — otdelning o'ziga tushgan zayavkalar.

**Rad etilgan muqobil:** ustadagi zayavkalarni avtomatik yakunlamaslik (usta topshirganda
yakunlash). Toza reyestr beradi, lekin yaratish oqimida ikki xil xatti-harakat paydo
bo'ladi, unutilgan zayavkada iste'mol umuman yozilmaydi va 2026-09-09 qarori bilan
qurilgan ekranlar (Krem kaymokchi, Zagotovka) holatlari o'zgaradi.

**Qo'shimcha ta'sir:** "Ishlab chiqarish hisoboti" (cost-summary) `SUM(qty)` o'rniga
`SUM(COALESCE(actual_qty, qty))` ishlatadi — haqiqiy topshirilgan qiymat.

---

## 9. Sozlash UX (egasi uchun, faqat UI orqali)

Joy: otdelning "Lokatsiya" sahifasi → yangi **"Ustalar"** bo'limi (faqat `pm`/`super_admin`).

1. **Ustalar ro'yxati:** nom, boshliq (ixtiyoriy), tayinlangan mahsulotlar soni, holat.
   "Usta qo'shish" (bitta) yoki **"Standart 3 usta"** shabloni (Biskvitchi, Zagotovkachi,
   Ukrasheniye) — avval ko'rinish, keyin "Yaratish". Nom avtomatik
   `"<otdel> · <usta>"` bo'ladi (odam ismini qo'shish mumkin: "· Biskvitchi (Dilnoza)").
2. **"Mahsulotlarni ustalarga taqsimlash"** sehrgari:
   - **1-qadam — qoidalar** (oldindan to'ldirilgan, tahrirlanadi):
     `Г/П` (turi `gp|finished` yoki nomi `Г/П` bilan boshlanadi — `lib/productCategory.ts`
     `hasReadyPrefix`) → Ukrasheniye; nomi `бисквит` bilan boshlanadi → Biskvitchi;
     `з/г` (`з/г`, `з\г`, `з / г`) yoki `крем` bilan boshlanadi → Zagotovkachi.
     Tartib: Г/П → бисквит → з/г → крем. Solishtirish: NFC, kichik harf, bo'shliqsiz.
   - **Nomzodlar:** `production_location_id` = shu otdel yoki uning ustasi; va shu otdel
     Г/П'larining BOM daraxtidagi (rekursiv, chuqurlik ≤ 6) tayinlanmagan komponentlar.
     Boshqa otdeldagi komponentlar alohida "Boshqa otdelda" ro'yxatida, **belgilanmagan**.
   - **2-qadam — ko'rib chiqish:** mahsulot, turi, hozirgi joyi → taklif, qaysi qoida;
     ogohlantirishlar: (a) boshqa otdel Г/P'lari ham ishlatadi, (b) qoida mos kelmadi —
     otdelda qoladi, (c) Г/П retsepti bosqichlarga bo'lingan (§6.5), (d) `крем каймак`
     oilasi (egasi qarori Q1). Har qatorni o'chirish/ustasini almashtirish mumkin.
     Hozirgi ochiq zayavkalar soni: "N ta ochiq zayavka eski tartibda qoladi".
   - **3-qadam — tasdiq:** bitta tranzaksiya; har mahsulot uchun "preview paytidagi joy
     hali ham shu" tekshiruvi (o'zgargan bo'lsa o'tkazib yuboriladi, sababi bilan);
     bitta audit qatori `production_station.assign.apply` — har mahsulot uchun
     `{before, after}` (ADR-0018 snapshot yondashuvi).
3. **Bekor qilish:** "Oxirgi taqsimotni bekor qilish" — faqat hali ham `after`
   qiymatida turgan mahsulotlar `before`ga qaytadi; ikkinchi marta — "allaqachon
   tiklangan". NULL'ga qaytarilmaydi (Poster sync uni qayta to'ldirishi sabab).
4. **Yangi mahsulotlar:** Poster'dan yangi mahsulot otdelga tushsa, "Ustalar" bo'limida
   ogohlantirish: "3 ta yangi mahsulot ustaga tayinlanmagan — Taqsimlash".

---

## 10. API kontrakti (yangi / o'zgargan)

Hammasi JWT + RBAC; xatolar mavjud `AppError` kodlari bilan (`VALIDATION_ERROR` 422,
`FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `INVALID_TRANSITION` 409).

```
GET  /api/locations/:id/stations                      pm, super_admin, production_manager(scope)
  200 [{ id, name, short_name, manager_user_id, is_active, product_count, open_order_count }]

POST /api/locations/:id/stations                      pm, super_admin
  body { stations: [{ name: string, manager_user_id?: number }] }   (1..10)
  201 { stations: Location[] }
  422 parent not a non-station active production location | duplicate name

PATCH /api/locations/:id                              (mavjud) — is_station o'zgarmaydi;
  parent_id usta bo'lishi mumkin emas; usta faolsizlantirish → 409 CONFLICT {products, open_orders}

GET  /api/locations?type=production[&include_stations=1]   default — ustalarsiz

POST /api/production-stations/assignments/preview     pm, super_admin
  body { otdel_id, rules: [{ kind:'gp'|'prefix', patterns?: string[], station_id }] }
  200 { items: [{ product_id, name, type, current_location_id, current_location_name,
                  proposed_station_id|null, rule|null, selected: boolean,
                  warnings: ('used_by_other_otdel'|'other_otdel'|'no_rule'|'split_recipe'|'kaymak')[] }],
        open_orders_at_otdel: number }

POST /api/production-stations/assignments/apply       pm, super_admin
  body { otdel_id, items: [{ product_id, expected_current_location_id, station_id|null }] }
  200 { audit_id, applied: number, skipped: [{ product_id, reason:'changed'|'invalid_station' }] }

POST /api/production-stations/assignments/:auditId/revert   pm, super_admin
  200 { restored: number, skipped: [{ product_id, reason:'changed'|'already_restored' }] }

POST /api/production-orders/:id/delivery              pm, super_admin, production_manager(scope) [+ Q2]
  body { delivered_qty: number >= 0 }
  200 { production_order, delta, yield: { opened: number, settled: number }, handoffs_closed: number }

POST /api/production-orders/deliveries                 (batch, hammasi-yoki-hech-narsa)
  body { items: [{ order_id, delivered_qty }] }  (1..500)
  200 { results: [...] }   422 — birorta xato bo'lsa hech biri yozilmaydi

GET  /api/production-stations/accounting?otdel_id&from&to   pm, super_admin,
                                                      production_manager(scope), raw_warehouse_manager(o'qish)
  200 { otdel: {id,name}, stations: [{ station_id|null, name, lines: [{ product_id, name, unit,
        expected, delivered, unconfirmed_orders, diff, open_debt, orders:[{id,qty,actual_qty,status}] }] }] }
```

O'zgargan o'qish javoblari (§7): `GET /api/production-orders`, `daily-dispatch`
(`orders` + `dispatch_items`), `cost-summary` (`groups[].stations[]`), `bom-preview`
(`suggested_station`), `yield-debts` (roll-up).

---

## 11. Risklar va chekka holatlar

| # | Holat | Xatti-harakat / chora |
|---|---|---|
| R1 | Mahsulot bir nechta otdelda ishlatiladi (masalan krem Tort'da ham) | `production_location_id` bitta. Ustaga ko'chirilsa, Tort zayavkalari uni "Оформления · Zagotovkachi"dan oladi (otdellararo topshirish — bugun ham shunday ishlaydi). Sehrgar ogohlantiradi, default — ko'chirilmaydi. Kelajak: `(mahsulot, iste'molchi otdel) → usta` jadvali (Keyin) |
| R2 | Bitta ustaning yarim tayyori bir nechta joyda ishlatiladi | Har iste'molchi uchun alohida sub-zayavka + topshirish qatori (1:1); varaqada har qabul qiluvchi alohida |
| R3 | O'tish paytidagi ochiq zayavkalar | Ko'chirilmaydi; "otdel (umumiy)" ustun/bo'limda qoladi. O'tish — kun chegarasida (Q3) |
| R4 | Rollback | Sehrgar "Bekor qilish" (§9.3); usta faolsizlantirish — faqat mahsulot/ochiq zayavka yo'q bo'lsa; o'chirish — mavjud FK tekshiruvi (`routes/locations.ts:324-336`) |
| R5 | Poster sync | `production_location_id` saqlanadi (§2 #6); stock sync ustaga tegmaydi (§2 #8); yangi Poster mahsulotlari otdelga tushadi → "tayinlanmagan" ogohlantirishi |
| R6 | Usta nomi Poster workshop nomiga teng bo'lib qolishi | `"<otdel> · <usta>"` formati to'qnashuvni amalda imkonsiz qiladi; validatsiya workshop nomlari bilan tenglikni rad etadi |
| R7 | Ustada manfiy qoldiq | Kutilgan ("qarz"); 0043 dan beri ruxsat etilgan. Hisobotlar otdel darajasida yig'adi |
| R8 | "Topshirildi" kiritilmay qoladi | "Tasdiqlanmagan" belgisi; "Hammasi to'liq topshirildi" tugmasi; ertasi kuni Telegram eslatma (Keyin) |
| R9 | RBAC kengayishi | Roll-up faqat pastga (otdel → ustalari), faqat `is_station` bolalar; sex_storage va boshqa bolalar kirmaydi |
| R10 | `pcs` yaxlitlash farqi | Faqat ko'rinish; Poster sinxlangan xom-ashyo ombori haqiqiy chiqimni aks ettiradi |
| R11 | Unumdorlik (TZ §13, dashboard < 1s) | Roll-up — kichik `locations` jadvali + `ix_locations_station_parent`; authenticate'da so'rovlar soni o'zgarmaydi (bitta UNION) |

### 11.1 Oldindan mavjud muammolar (ustalar ularni kuchaytiradi — alohida tuzatish tavsiya etiladi)

- **P1.** Telegram `rcv:dsp` harakat allaqachon qo'llangan bo'lsa ham qayta ko'chiradi
  (`integrations/telegram/dispatch.ts:1311-1322`; web'da `movement_id` tekshiriladi —
  `productionOrders.ts:1094-1111`) → ikki marta transfer.
- **P2.** Tayyor mahsulot `done`da allaqachon maqsad omborga tushadi
  (`services/productionOrder.ts:82`, `:124-138`), keyin "Qabul qilindi" yana ko'chiradi
  (`productionOrders.ts:1094-1111`) → ishlab chiqarish lokatsiyasi (endi Ukrasheniye) −qty.
  Markaziy sklad Poster sync bilan tuzaladi, usta/otdel manfiyligicha qoladi.
- **P3.** Web dispatch/receive endpointlarida lokatsiya-scope tekshiruvi yo'q
  (`productionOrders.ts:1015-1324`).
- **P4.** Bosqich nomuvofiqligi (§6.5): `expandBom` barcha bosqichlar, iste'mol esa
  filtrlangan; `readBaseBom` faqat `'base'`.
- **P5.** Zayavka yaratish atomar emas: INSERT commit bo'lgach, dispatch, harakatlar,
  sub-zayavkalar va avto-yakunlash alohida tranzaksiyalarda, xatolar yutiladi
  (`productionOrders.ts:1711-1788`, `:1939-1976`) — qisman holat mumkin (invariant 1 ruhiga zid).
- **P6.** `CLAUDE.md` invariant 3 ("qoldiq hech qachon manfiy emas") kodga mos emas
  (0043 CHECK'ni olib tashlagan, `allowNegative` yo'llari) — hujjat/egasi bilan kelishish kerak.

---

## 12. MVP (pilot) va keyingi bosqich

**MVP — pilot uchun:**
- Migration 0063; usta CRUD + validatsiyalar; roll-up (§7 "MVP" qatorlari).
- Marshrutlash: server resolution, otdel fallback, topshirish miqdori.
- Sehrgar (preview → tasdiq → audit → bekor qilish).
- Xomashyo berish: otdel/usta guruhlash, matritsa (guruhlangan ustunlar, imzo qatori,
  `pcs` yaxlitlash), usta varaqalari.
- Kun yakuni hisobi: delivery endpoint(lar), accounting endpoint va sahifa.
- Telegram RBAC va "Xomashyo berildi" bildirishnomasi roll-up'i.

**Keyin (Faza 2+):**
- Ustaning o'z akkaunti (`usta` roli yoki production_manager usta-lokatsiyaga), Telegram
  orqali "Topshirdim/Qabul qildim".
- Qisman qabul (qabul qiluvchi boshqa miqdor yozadi) — kamomadni zanjir bo'ylab aniq
  bog'lash.
- `(mahsulot, iste'molchi otdel) → usta` marshrut jadvali (R1).
- Ostatka hisoboti otdel+ustalar agregati; AI o'qish scope roll-up; chain canvas'da
  ustalarni ichma-ich ko'rsatish; ustaga min/max qo'yishni taqiqlash.
- `KremKaymokchiPage`ni usta modeliga ko'chirish (Q1 javobiga ko'ra).
- P1–P6 tuzatishlari (P1, P2 — pilotdan oldin tavsiya etiladi).

---

## 13. Vazifalar taqsimoti

Umumiy qoida: har vazifa — test birinchi (TDD), ~100 qatorlik commit'lar. Usta yaratilmaguncha
xatti-harakat o'zgarmasligi har backend vazifasida regression-test bilan tekshiriladi.

### Backend (`backend-engineer`)

| ID | Vazifa | Qabul mezonlari (acceptance criteria) |
|---|---|---|
| B0 | Migration `0063_location_station.sql` | Ikki marta ishga tushirish xatosiz; CHECK: usta `type≠production` / `parent_id NULL` / `stage_role` / Poster id bilan rad etiladi; mavjud qatorlarda `is_station = FALSE` (soni o'zgarmaydi) |
| B1 | `services/productionStations.ts` (`otdelOf`, `stationsOf`, `resolveProductionLocation`, `loadScopeLocationIds`); `GET/POST /api/locations/:id/stations`; `routes/locations.ts` validatsiyalari; ro'yxat default ustalarsiz | 3 usta yaratiladi, nomlari `"<otdel> · X"`, audit bor; ota usta/production emas/nofaol/nom takrori → 422; `PATCH parent_id=usta` → 422; `is_station` o'zgarmaydi; mahsulot yoki ochiq zayavkali ustani faolsizlantirish → 409 (sonlar bilan); `?type=production` ustalarsiz, `include_stations=1` bilan — bor |
| B2 | Scope roll-up: `authenticate`, `principal.ts`, Telegram (`dispatch.ts`, `jonatish`, `zayavkalar`), AI write scope; §7 #3, #13, #18-21 | Otdelga biriktirilgan production_manager o'z ustasidagi zayavkani `PATCH done`/`bulk-done` qila oladi (avval 403); boshqa otdel ustasiga — 403 + audit; ustaga biriktirilgan foydalanuvchi otdelni olmaydi; `X-Active-Location=usta` otdel menejeri uchun qabul qilinadi; Telegram "Boshladim"/"Qabul" usta zayavkasida ishlaydi; mavjud auth/principal testlari yashil |
| B3 | Marshrutlash: resolution (`POST /production-orders`, AI tool), fallback → otdel, topshirish miqdori = sub-zayavka, `bom-preview` | Г/П (`production_location_id = Ukr`) + `location_id = otdel` → `order.location_id = Ukr`; boshqa otdel so'ralsa — o'zgarmaydi; бисквит/з/г/крем sub-zayavkalari Bisk/Zag'ga; dispatch qatorlari §6.4 jadvaliga aynan mos; topshirish miqdori = sub-zayavka miqdori; tayinlanmagan semi → otdel; ustasiz otdel stsenariysi oldingidek (snapshot test) |
| B4 | O'qish modellari: `otdel_*`/`station_*` maydonlari (ro'yxat, daily-dispatch), cost-summary otdel guruhi + `stations[]` + `COALESCE(actual_qty, qty)`, yield-debts roll-up + RBAC, dashboard §7 #13-17 | Ustasiz lokatsiyada `otdel_id = location_id`; cost-summary guruhlari soni = otdellar soni, jamlar o'zgarmaydi; `sex_count` ustalarsiz; otdel tugunidagi aktiv son usta zayavkalarini o'z ichiga oladi; otdel menejerining production plan'ida usta zayavkalari bor; dashboard overview < 1s |
| B5 | Sehrgar API: preview / apply / revert (audit snapshot, optimistik tekshiruv) | Fixture: "бисквит шоколадный" → Bisk; "з/г медовик", "З\Г наполеон", "крем масляный" → Zag; "Г/П МЕДОВИК" va `gp` → Ukr; "крем каймак" — Q1 default bo'yicha taklif qilinmaydi; boshqa otdeldagi komponent — `other_otdel`, `selected=false`; boshqa otdel Г/П'si ishlatsa `used_by_other_otdel`; apply — bitta audit qatori `{before, after}`; preview'dan keyin o'zgargan mahsulot `skipped:'changed'`; revert faqat `after`dagi mahsulotlarni tiklaydi, ikkinchisi no-op; production_manager → 403; apply'dan keyin `syncProductWorkshops` (mock client) tayinlovni o'zgartirmaydi |
| B6 | `completeProductionOrder` servis (PATCH done shu servisga o'tadi); `POST /:id/delivery`, `POST /deliveries`, `GET /api/production-stations/accounting` | Ochiq zayavka 10 → delivered 9: `done`, chiqim 9, BOM 10 sarflandi, qarz 1 `(product, usta)`; avto-yakunlangan zayavka → delivered 9: `actual_qty=9`, chiqim joyida −1 `adjust`, qarz 1; keyin 10 ga tuzatish → qarz yopiladi, +1 `adjust`; delivered = qty (tasdiqlanmagan) → harakat yo'q, qarz yo'q; `cancelled` → 409; boshqa otdel → 403; batch'da bitta xato → hech narsa yozilmaydi; otdel ichidagi `pending` topshirish qatori bir marta ko'chiriladi va `received` bo'ladi; otdellararo qatorga tegilmaydi; accounting har usta + "(umumiy)" uchun kutilgan/topshirilgan/tasdiqlanmagan/ochiq qarzni qaytaradi |
| B7 | "Xomashyo berildi" bildirishnomasi: usta menejeri ?? otdel menejeri, bitta xabar/otdel | Menejersiz 3 usta → otdel menejeri bitta xabar oladi (usta bo'limlari bilan), takror yo'q |
| B9 | (Keyin / pilotdan oldin tavsiya) P1, P2, P4 tuzatishlari | P1: web'da berilgan qator Telegram'da qabul qilinganda harakat bitta; P2: `done`dan keyingi qabul ikkinchi chiqim yaratmaydi; P4: dispatch iste'mol bilan bir xil BOM o'quvchisini ishlatadi |

### Frontend (`frontend-engineer`)

| ID | Vazifa | Qabul mezonlari |
|---|---|---|
| F1 | Otdel sahifasida "Ustalar" bo'limi: ro'yxat, qo'shish, "Standart 3 usta" (ko'rinish → tasdiq), qayta nomlash, faolsizlantirish (409 xabari) | Faqat pm/super_admin ko'radi; nom `"<otdel> · <usta>"`; usta sahifasida "Usta" belgisi va otdelga havola; komponent testlari |
| F2 | Taqsimlash sehrgari (qoidalar → ko'rib chiqish → tasdiq) + "Bekor qilish" | Qoidalarni tahrirlash, qator bo'yicha usta almashtirish, ogohlantirish filtrlari, tasdiq oynasida sonlar va ochiq zayavkalar ogohlantirishi; apply/revert payload testlari; barcha matn o'zbekcha |
| F3 | Zayavka formasi: ustalar ro'yxatda yo'q; usta mahsuloti → otdel tanlanadi + izoh | `ProductionOrderFormDialog.test.tsx` uslubida: usta mahsuloti tanlanganda select qiymati = otdel, izoh matni ko'rinadi; ustasiz mahsulot — oldingidek |
| F4 | Xomashyo berish: otdel/usta guruhlash, `to_otdel_id` filtri, matritsa (guruhlangan ustunlar, imzo qatori, `pcs` yaxlitlash, Jami = ko'rsatilgan yig'indi), "Usta varaqalari" print | `dispatchContext.test.ts`: `buildStationSlips` §6.4 fixture'ida maket bo'limlarini aynan beradi; `buildDispatchMatrix`: ustasiz otdel — 1 ustun, ustali — guruh + ustunlar, "(umumiy)" faqat kerak bo'lsa; 2.3 + 1.2 `pcs` → 3 va 2, Jami 5; kg o'zgarmaydi; nol — bo'sh |
| F5 | "Kun yakuni — ustalar hisobi" sahifasi (Ishlab chiqarish menyusida) | `distributeDelivered` unit-testlari (FIFO, ortig'i oxirgisiga); manfiy farq qizil; "tasdiqlanmagan" belgisi; "Hammasi to'liq topshirildi" va "Saqlash" batch payload testi; rollar: pm/super_admin/production_manager (yozish), raw_warehouse_manager (o'qish, Q2 ga ko'ra) |
| F6 | Mavjud ekranlar roll-up'i: Zagotovka, Krem kaymokchi, Zayavkalar (filtr/chip/matritsa), Ishlab chiqarish hisoboti (otdel + usta tafsiloti) | Otdel menejeri usta zayavkalarini ko'radi; guruhlar `otdel_id` bo'yicha; mavjud testlar yashil (DEPLOY.md §5 baseline'ga qo'shimcha qizil yo'q) |

### Ish tartibi

1. **B0** — prod'ga yakka o'zi, koddan oldin (DEPLOY.md §4).
2. **B1 → B2** (B2 B1 helper'lariga tayanadi), parallel **B3**, **B4**.
3. **F1, F3, F6** (B1/B4 dan keyin) va **B5 → F2**.
   *1-deploy:* B1–B5 + F1–F3 + F6 — usta yaratilmaguncha xatti-harakat o'zgarmaydi.
4. **B6, B7 → F4, F5.** *2-deploy.*
5. **Pilot:** egasi kun oxirida 3 usta yaratadi va sehrgarni ishga tushiradi; 1 hafta
   kuzatish → `code-reviewer` hisoboti → B9.

---

## 14. Egasi qarorlari (kam va aniq)

- **Q1.** `крем каймак` oilasi (hozir alohida "Krem kaymokchi" ekrani bor): Zagotovkachi'ga
  o'tadimi yoki alohida 4-usta "Krem kaymokchi" bo'ladimi? *(Default: sehrgar ularni
  "крем" qoidasidan chiqarib, joyida qoldiradi.)*
- **Q2.** Kun yakunida "Topshirildi" miqdorini kim kiritadi — otdel boshlig'i va PM
  (default), yoki skladchi (raw_warehouse_manager) ham?
- **Q3.** O'tish kuni: qaysi kundan boshlab yangi zayavkalar ustalarga taqsimlanadi?
  (Oldingi ochiq zayavkalar "Оформления (umumiy)"da qoladi.)

Ma'lumot uchun (qaror emas): "Ishlab chiqarish hisoboti" endi topshirilgan miqdor
yozilgan bo'lsa shuni ko'rsatadi (§8.3).

---

## 15. TZ §16 / decisions bog'liqligi

TZ §16 savollarining hammasi hal qilingan (2026-05-22). Dizayn tayanadi:
- **D2** — yarim tayyor ishlab chiqarishga qayta kiradi: ustalararo topshirish — shuning
  ichki (otdel ichidagi) shakli.
- **D4** — Poster: ustalar faqat ERP'da, Poster'ga moslanmaydi; `production_location_id`
  sync'da saqlanadi.
- **D6** — har lokatsiyaning boshlig'i: usta boshliqsiz bo'lishi mumkin, u holda otdel
  boshlig'i javobgar (bildirishnoma va RBAC roll-up).
- D5 (ikki bosqichli tasdiq) va ADR-0001 state machine'ga ta'sir yo'q.

Yangi TZ §16 savoli yo'q; faqat Q1–Q3.

---

## 16. Bog'liq hujjatlar va kod

- `docs/architecture/adr-0012-multi-location-users.md`, `adr-0015-…`, `adr-0016-…`, `adr-0018-…`
- `deploy/DEPLOY.md` §4 (bitta migratsiya), §5 (test baseline)
- `apps/backend/src/routes/productionOrders.ts`, `services/productionOrder.ts`,
  `services/bom.ts`, `services/yieldDebt.ts`, `lib/principal.ts`,
  `middleware/authenticate.ts`, `integrations/poster/seedSync.ts`,
  `integrations/telegram/dispatch.ts`
- `apps/frontend/src/pages/production-orders/WarehouseDispatchPage.tsx`,
  `dispatchContext.ts`, `ZagotovkaPage.tsx`, `KremKaymokchiPage.tsx`,
  `ProductionOrdersPage.tsx`, `ProductionCostReport.tsx`, `ProductionOrderFormDialog.tsx`
