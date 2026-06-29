# ADR-0017 — Poster ombor klassifikatsiya mapping'i (storage_id → location_type)

> Holat: **Qabul qilindi** (2026-05-29, team lead'ga to'liq qaror vakolati
> berilgan — egasi tasdig'i delegatsiya qilingan)
> Sana: 2026-05-29
> Muallif: system-architect
> Faza: To'lqin 2 (poydevor) — EPIC 0+ P1/P2, EPIC 2.2, EPIC 0.6
> Bog'liqlik: D1 (xom-ashyo va markaziy sklad alohida), D4 (Poster POS manba),
> D6 (har location o'z boshlig'i), ADR-0002 (Poster sync strategiyasi),
> ADR-0015 (sex_storage remodeling), ADR-0016 (zagatovka/ukrasheniye),
> migration 0001 (location_type enum, locations), 0021/0022/0025 (sex_storage),
> 0026 (location_flows).
> Manba: `docs/specs/poster-diagnostic-2026-05-29.md` §(a) — LIVE 25 ombor +
> 5 spot (tasdiqlangan); `docs/specs/changes-2026-05-owner-feedback.md`
> §EPIC 0+ P1/P2, §EPIC 2.2.

---

## 1. Kontekst

Poster'da **25 ombor (storage)** va **5 spot** bor (live `storage.getStorages`
+ `access.getSpots`, 2026-05-29 diagnostika bilan tasdiqlangan). Hozirgi
`seedSync.upsertStorage` (`apps/backend/src/integrations/poster/seedSync.ts:107`)
har 25 omborni **`central_warehouse`** turi bilan upsert qiladi — bu noto'g'ri:

- Dashboard "Markaziy sklad" kartasi 25 ta omborni qamrab oladi (image28/29
  buzuq); aslida markaziy sklad faqat **bitta** (`Склад Центральный`).
- Replenishment topologiyasi (`resolveTopology`) noto'g'ri ishlaydi —
  xom-ashyo, sex skladlari va markaziy sklad farqlanmaydi.
- AI assistant va RBAC scope noto'g'ri bo'g'inni ko'rsatadi.

Bu ADR har 25 ombor uchun **qat'iy `storage_id → location_type`** mapping'ini
belgilaydi, spot↔storage dublikat muammosini (P2) hal qiladi, va kelajakdagi
sync'lar uchun mapping'ni koddan deklarativ qilib oladi.

### 1.1 Tasdiqlangan faktlar (diagnostikadan)

- 25 ombor ro'yxati doc §4 (2026-05-07) bilan **mos** — eskirmagan.
- Egasi ro'yxatidagi `Склад Полуфабрикаты` va `Склад торт загатовка`
  Poster'da **YO'Q**. Poster'da faqat `35 Склад Заготовок` va
  `36 Склад Украшений` bor. Demak mapping shulardan kelib chiqadi.
- Spotlar: 1=Кукча, 2=Рабочий, 3=Чигатай, 4=Кукча центральный, 7=Доставка.
- ADIA `location_type` enum (migration 0001 + 0021): `raw_warehouse`,
  `production`, `sex_storage`, `supply` (deprecated), `central_warehouse`,
  `store`.

---

## 2. Klassifikatsiya tamoyillari

Har omborga tur tayinlash uchun quyidagi qoidalar (ustuvorlik tartibida):

1. **Markaziy sklad — yagona (D1, EPIC 2.2).** Faqat `Склад Центральный`
   (id=8) = `central_warehouse`. Boshqa hech bir ombor markaziy emas. Bu
   dashboard "Markaziy sklad" kartasi chalkashligini hal qiladi.
2. **Xom-ashyo ombori (D1).** `Основной склад` (id=2) = `raw_warehouse` —
   un, shakar, krem kabi xom-ashyo. Markaziy skladdan jismonan alohida.
3. **Ishlab chiqarish floori.** `Производственный Цех` (id=20) =
   `production` — sex floor'ining ish-jarayoni ombori (BOM iste'moli/chiqishi
   shu yerda kechadi).
4. **Filial-backing skladlar = `store` (P2 qarori, §4).** `Склад Кукча`
   (3), `Склад Рабочий` (4), `Склад Чигатай` (5) — bular Poster spot'lari
   bilan **bitta jismoniy do'kon**. Ular alohida `central_warehouse` emas,
   balki tegishli spot-do'koni bilan **birlashtiriladi** (§4).
5. **Qolgan hamma ombor = `sex_storage` (ADR-0015, ADR-0016).** Mahsulot
   bo'yicha nomlangan omborlar (Тортов, Наполеон, Эклеров, Круассанов,
   Бисквит, ...) — har biri tegishli sex skladining ready-batch /
   zagatovka buferi. ADR-0016'dagi zagatovka↔ukrasheniye oqimi shu turdagi
   omborlarda yashaydi. Min/max ham shu omborlarda ishlaydi (EPIC 5.5).
6. **Заготовок (35) va Украшений (36)** — egasining "zagatovka" va
   "ukrasheniye" tushunchalarining Poster ekvivalenti. Ikkalasi ham
   `sex_storage` (alohida sub-turlash kerak emas — sub-turlash kelajakda
   ADR-0016 implementatsiyasida `product`/oqim darajasida hal bo'ladi,
   `location_type` darajasida emas).

> **Polуfabrikat (Yarim Fabrika) izohi:** egasi kutgan
> "Склад Полуфабрикаты" Poster'da YO'Q. ADIA ichida `Yarim Fabrika skladi`
> allaqachon `sex_storage` (migration 0022/0025) — lekin u **Poster
> storage'iga bog'lanmagan** (`poster_storage_id IS NULL`), chunki Poster'da
> unга mos ombor yo'q. Bu holat saqlanadi: Yarim Fabrika ADIA-ichki
> sex_storage bo'lib qoladi, Poster bilan sinxlanmaydi. Agar egasi keyinroq
> Poster'da bunday ombor yaratса, yangi migration uni map qiladi.

---

## 3. YAKUNIY mapping jadvali (25 ombor)

| Poster id | Poster nomi | ADIA `location_type` | Asos / izoh |
|-----------|-------------|----------------------|-------------|
| 2  | Основной склад        | `raw_warehouse`     | Xom-ashyo ombori (D1, qoida 2) |
| 8  | Склад Центральный     | `central_warehouse` | **YAGONA** markaziy sklad (D1, qoida 1) |
| 20 | Производственный Цех  | `production`        | Ishlab chiqarish floori (qoida 3) |
| 3  | Склад Кукча           | `store`             | Spot 1 "Кукча" + spot 4 "Кукча центральный" backing sklad → **store bilan birlashtiriladi** (P2, §4) |
| 4  | Склад Рабочий         | `store`             | Spot 2 "Рабочий" backing sklad → store bilan birlashtiriladi (P2) |
| 5  | Склад Чигатай         | `store`             | Spot 3 "Чигатай" backing sklad → store bilan birlashtiriladi (P2) |
| 35 | Склад Заготовок       | `sex_storage`       | Zagatovka buferi (ADR-0016; qoida 5/6) |
| 36 | Склад Украшений       | `sex_storage`       | Ukrasheniye/bezak materiallari (ADR-0016) |
| 27 | Склад Декора          | `sex_storage`       | Dekor (ukrasheniye yo'nalishi) |
| 19 | Склад Тортов          | `sex_storage`       | Tort sexi ready-batch buferi |
| 25 | Склад Тартов          | `sex_storage`       | Tart (qandolat) buferi |
| 26 | Склад Бисквит         | `sex_storage`       | Biskvit zagatovkasi |
| 32 | Склад Наполеон        | `sex_storage`       | Napoleon buferi |
| 34 | Склад Эклеров         | `sex_storage`       | Ekler buferi |
| 37 | Склад Круассанов      | `sex_storage`       | Kruassan buferi |
| 38 | Склад Евро            | `sex_storage`       | "Yevro" liniya buferi |
| 39 | Склад Пирогов         | `sex_storage`       | Pirog buferi |
| 12 | Склад Песочный        | `sex_storage`       | Qumoq (pesochniy) xamir buferi |
| 15 | Склад Самсы           | `sex_storage`       | Somsa sexi buferi (perojniy yo'nalishi) |
| 29 | Склад Горячих         | `sex_storage`       | Issiq mahsulot buferi |
| 21 | Склад Каймок          | `sex_storage`       | ⚠️ Egasi "umumiy tarqatiladi" degan — shared-input bo'lishi mumkin; hozircha `sex_storage` (§6 ochiq savol OQ-1) |
| 28 | Склад Спец            | `sex_storage`       | ⚠️ Tarkibi noaniq — `sex_storage` default (OQ-2) |
| 30 | Склад Тошми           | `sex_storage`       | ⚠️ Tarkibi noaniq — `sex_storage` default (OQ-2) |
| 31 | Склад Минор           | `sex_storage`       | ⚠️ Tarkibi noaniq — `sex_storage` default (OQ-2) |
| 33 | Склад Салат           | `sex_storage`       | ⚠️ Salat — tayyor/oraliq mahsulot; `sex_storage` default (OQ-2) |

**Yakuniy taqsimot:** `raw_warehouse` = 1 (id 2), `central_warehouse` = 1
(id 8), `production` = 1 (id 20), `store` = 3 (id 3/4/5), `sex_storage` = 19
(qolgan barchasi). Jami 25 — to'liq qamrov.

⚠️ bilan belgilangan 5 ombor (21, 28, 30, 31, 33) `sex_storage` ga
**default** bilan tushadi. Bu **xavfsiz default**: noto'g'ri bo'lsa ham
markaziy/xom-ashyo/store hisobiga chalkashlik kirmaydi, faqat sex skladlari
qatoriga qo'shiladi. Egasi keyinroq aniqlasa, PM `PATCH /api/locations/:id`
orqali yoki kichik follow-up migration bilan tuzatadi (§6).

---

## 4. P2 qaror — spot ↔ storage dublikatini bartaraf etish

### 4.1 Muammo

Hozir `upsertSpot` 5 spotni `type='store'` (`poster_spot_id` bilan) yaratadi,
`upsertStorage` esa 25 storage'ni alohida location qiladi. Natijada
"Кукча" do'koni **ikki marta** model'da paydo bo'ladi:

- spot-location: `poster_spot_id=1`, `type='store'` (sotuv shu yerga tushadi
  — `salesSync.resolveStoreId` `poster_spot_id` bo'yicha topadi).
- storage-location: `poster_storage_id=3`, hozir `central_warehouse`
  (ombor qoldig'i shu yerga tushadi — `stockSync` `poster_storage_id`
  bo'yicha har location'ga leftover qo'yadi).

Ya'ni **sotuv** bir location'da, **ostatka** boshqa location'da — bu RBAC,
dashboard va replenishment uchun chalkashlik. Do'kon manageri o'z
do'konining ostatkasini ko'rmaydi.

### 4.2 Qaror: **store-backing storage'ni store location'iga birlashtirish (merge)**

Filial-backing storage'lar (3 Кукча, 4 Рабочий, 5 Чигатай) **alohida
location qilinmaydi**. Ularning `poster_storage_id` qiymati tegishli **spot
location**'ning ustuniga yoziladi. Natijada bitta `locations` qatori:

```
type='store', poster_spot_id=1 (Кукча), poster_storage_id=3 (Склад Кукча)
```

Shunda:
- **Sotuv** (`poster_spot_id` orqali) va **ostatka** (`poster_storage_id`
  orqali) **bitta** do'kon location'iga tushadi — `stockSync` va
  `salesSync` ikkalasi ham shu qatorga ulanadi.
- Dublikat yo'qoladi, RBAC va dashboard to'g'ri ishlaydi.
- `locations` ustun strukturasiga **o'zgartirish kerak emas** — ikkala
  ustun (`poster_spot_id`, `poster_storage_id`) bitta qatorda mavjud
  bo'lishi enum/CHECK tomonidan taqiqlanmagan (migration 0001'da partial
  UNIQUE indekslar har ustun uchun alohida — bitta qatorda ikkovi ham
  bo'lishi mumkin).

### 4.3 Spot↔storage bog'lanish jadvali

| Spot id | Spot nomi | Backing storage id | Birlashma natijasi |
|---------|-----------|--------------------|--------------------|
| 1 | Кукча            | 3 (Склад Кукча)   | bitta `store` qatori: spot=1, storage=3 |
| 4 | Кукча центральный | 3 (Склад Кукча)  | ⚠️ spot 1 va spot 4 ikkalasi ham storage 3'ga ishora qiladi (OQ-3) |
| 2 | Рабочий          | 4 (Склад Рабочий) | bitta `store` qatori: spot=2, storage=4 |
| 3 | Чигатай          | 5 (Склад Чигатай) | bitta `store` qatori: spot=3, storage=5 |
| 7 | Доставка         | — (backing yo'q)  | `store` qatori: spot=7, storage=NULL (yetkazib berish kanali) |

> **⚠️ OQ-3 (spot 1 va spot 4 bir storage'ga):** "Кукча" va "Кукча
> центральный" ikki alohida POS spot, lekin ikkalasi ham bitta jismoniy
> "Кукча" omboridan (storage 3) sotadi. `poster_storage_id` partial UNIQUE
> indeksi (`uq_locations_poster_storage`) bitta storage'ni faqat **bitta**
> location'ga bog'lashga ruxsat beradi. Shuning uchun:
> - **Qaror:** storage 3 ni **birlamchi spot (1 Кукча)** location'iga
>   biriktiramiz. Spot 4 (Кукча центральный) alohida `store` qatori bo'lib
>   qoladi, lekin `poster_storage_id IS NULL` — uning ostatkasi storage 3
>   orqali spot 1 location'ida hisoblanadi. Sotuvlari esa o'z spot
>   location'iga tushadi. Bu yagona-UNIQUE cheklovini buzmaydi.
> - Bu egasi tasdiqlashi kerak bo'lgan yagona model nuance (§6 OQ-3).

### 4.4 Nega "alohida qoldirish" varianti rad etildi

**Variant: store-backing storage'ni alohida `sex_storage`/`central` location
qilib qoldirish.** Rad etildi, chunki: sotuv va ostatka turli location'da
qoladi (asosiy muammo hal bo'lmaydi); dashboard'da har do'kon 2 marta
ko'rinadi; do'kon manageri ostatkasini ko'ra olmaydi (RBAC scope buziladi);
replenishment do'kon uchun min/max'ni noto'g'ri location'da hisoblaydi.

---

## 5. Implementatsiya spec

### 5.1 Migration 0028 — `poster_storage_classification.sql`

**Tur:** faqat `UPDATE` (DESTRUKTIV emas — `DELETE` yo'q, `DROP` yo'q).
**Idempotent:** har `UPDATE` tegishli `poster_storage_id` bo'yicha aniq
qatorni tutadi; ikkinchi ishga tushish bir xil natija beradi (qiymat
allaqachon to'g'ri bo'lsa NO-OP).

Qadamlar:

1. **Step 1 — store-backing storage'larni store spot'iga merge qilish (P2).**
   Storage 3/4/5 uchun: agar ular hozir alohida location bo'lib mavjud
   bo'lsa (`poster_storage_id IN (3,4,5)` va `poster_spot_id IS NULL`),
   ularning `poster_storage_id` qiymatini tegishli spot-location'ga
   ko'chirib, eski storage-only qatorni **deaktivatsiya qilish**
   (`is_active=FALSE`) — DELETE emas (FK xavfsizligi: leftover-driven
   `stock`/`stock_movements` qatorlari bo'lishi mumkin). Agar storage-only
   qatorda hech qanday FK referens bo'lmasa, kelajakdagi tozalash migration
   uni o'chirishi mumkin (bu migration o'chirmaydi).

   > Eslatma: backend-engineer merge implementatsiyasida `stock` qatorlarini
   > ham eski storage-location'dan spot-location'ga ko'chirishi kerak bo'lishi
   > mumkin. Bu migration faqat `locations` mapping'ini to'g'rilaydi; agar
   > seed hali ishlamagan/bo'sh DB bo'lsa (greenfield), `stock` migratsiyasi
   > shart emas. Real ma'lumotli DB uchun stock-merge alohida bosqich (§5.4).

2. **Step 2 — qolgan storage qatorlarni to'g'ri turga UPDATE qilish.**
   §3 jadvalidagi har `poster_storage_id` uchun `UPDATE locations SET
   type = <to'g'ri tur>` (faqat tur `central_warehouse` da qolgan,
   ya'ni hali tuzatilmagan qatorlar uchun — yoki `type IS DISTINCT FROM`
   gating bilan idempotent).

3. **Step 3 — `location_flows` qayta seed (ixtiyoriy, idempotent).**
   Yangi sex_storage'lar va markaziy sklad o'rtasidagi `forward` oqimlarni
   `ON CONFLICT DO NOTHING` bilan qo'shish (0026 uslubida). Bu qadam
   migration 0026 mantiqini Poster-nomli markaziy sklad uchun takrorlaydi.

### 5.2 Migration SQL skeleti

```sql
-- =============================================================================
-- 0028 — Poster storage classification (storage_id -> location_type).
-- =============================================================================
-- ADR-0017. Non-destructive: UPDATE only (no DELETE/DROP). Idempotent: every
-- statement is gated so a re-run is a no-op.
--
-- Fixes P1: seedSync.upsertStorage defaults ALL 25 storages to
-- 'central_warehouse'. This migration corrects the 25 rows to their true type
-- and merges the 3 store-backing storages into their POS spot locations (P2).
--
-- DATA SAFETY: only locations.type / poster_storage_id / is_active rotate.
-- stock / stock_movements / replenishment_requests reference location_id —
-- those ids are PRESERVED. No FK row is deleted here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — P2: merge store-backing storages (3,4,5) into POS spot locations.
-- For each (spot_id, storage_id) pair, move poster_storage_id onto the spot
-- row, then deactivate the orphaned storage-only row (DELETE is avoided).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- spot_poster_id, backing_storage_id
  pairs INT[][] := ARRAY[ARRAY[1,3], ARRAY[2,4], ARRAY[3,5]];
  p     INT[];
  v_spot_loc    BIGINT;
  v_storage_loc BIGINT;
BEGIN
  FOREACH p SLICE 1 IN ARRAY pairs LOOP
    SELECT id INTO v_spot_loc
      FROM locations WHERE poster_spot_id = p[1] AND type = 'store' LIMIT 1;
    SELECT id INTO v_storage_loc
      FROM locations
     WHERE poster_storage_id = p[2] AND poster_spot_id IS NULL LIMIT 1;

    IF v_spot_loc IS NOT NULL THEN
      -- Only set if the spot row does not already carry a storage id.
      UPDATE locations
         SET poster_storage_id = p[2], updated_at = now()
       WHERE id = v_spot_loc
         AND poster_storage_id IS DISTINCT FROM p[2]
         -- guard: do not steal a storage id already owned by another row
         AND NOT EXISTS (
           SELECT 1 FROM locations
            WHERE poster_storage_id = p[2] AND id <> v_spot_loc
              AND poster_spot_id IS NOT NULL
         );

      -- Deactivate the now-redundant storage-only row, if it still exists.
      IF v_storage_loc IS NOT NULL AND v_storage_loc <> v_spot_loc THEN
        -- NB: real-data deployments must migrate stock from v_storage_loc to
        -- v_spot_loc BEFORE this runs (see ADR §5.4). On greenfield it is a
        -- no-op because no stock has been synced yet.
        UPDATE locations
           SET is_active = FALSE,
               poster_storage_id = NULL,        -- release the UNIQUE key
               name = name || ' [merged->spot]',
               updated_at = now()
         WHERE id = v_storage_loc;
      END IF;
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- STEP 2 — classify the remaining storages by poster_storage_id.
-- Idempotent: `type IS DISTINCT FROM` makes a correct row a no-op.
-- ---------------------------------------------------------------------------

-- raw_warehouse
UPDATE locations SET type = 'raw_warehouse', updated_at = now()
 WHERE poster_storage_id = 2 AND type IS DISTINCT FROM 'raw_warehouse';

-- central_warehouse (the ONE)
UPDATE locations SET type = 'central_warehouse', updated_at = now()
 WHERE poster_storage_id = 8 AND type IS DISTINCT FROM 'central_warehouse';

-- production
UPDATE locations SET type = 'production', updated_at = now()
 WHERE poster_storage_id = 20 AND type IS DISTINCT FROM 'production';

-- sex_storage — all remaining classified storages.
UPDATE locations SET type = 'sex_storage', updated_at = now()
 WHERE poster_storage_id IN (
         12,15,19,21,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39
       )
   AND type IS DISTINCT FROM 'sex_storage';

-- ---------------------------------------------------------------------------
-- STEP 3 — forward flows: every sex_storage -> the central warehouse.
-- Mirrors migration 0026, but keyed on the Poster-named central warehouse.
-- ON CONFLICT DO NOTHING keeps it idempotent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_central BIGINT;
  v_sex     BIGINT;
BEGIN
  SELECT id INTO v_central
    FROM locations WHERE poster_storage_id = 8 AND type = 'central_warehouse' LIMIT 1;
  IF v_central IS NOT NULL THEN
    FOR v_sex IN
      SELECT id FROM locations WHERE type = 'sex_storage' AND is_active = TRUE
    LOOP
      INSERT INTO location_flows (from_location_id, to_location_id, flow_type)
      VALUES (v_sex, v_central, 'forward')
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END$$;
```

> **Skelet — yakuniy emas.** Backend-engineer migration faylini yozganda
> stol nomlari va FK chegaralarini tekshiradi (`stock`, `stock_movements`
> ustun nomlari — `from_location_id`/`to_location_id` 0025'da tasdiqlangan).

### 5.3 seedSync.upsertStorage tuzatish spec (kelajakdagi sync uchun)

Hozir `upsertStorage` hammasini `central_warehouse` qiladi. Yangi sync bu
xatoni qayta kiritmasligi uchun **deklarativ mapping konstantasi** qo'shiladi:

1. **Yangi fayl** `apps/backend/src/integrations/poster/storageClassification.ts`:
   ```ts
   // ADR-0017 — Poster storage_id -> ADIA location_type mapping.
   // Source of truth: live storage.getStorages (2026-05-29 diagnostic).
   export const STORAGE_TYPE_BY_ID: Readonly<Record<number, string>> = {
     2:  'raw_warehouse',
     8:  'central_warehouse',
     20: 'production',
     // store-backing storages — these are MERGED into a POS spot location
     // (P2). They are NOT inserted as standalone locations; see upsertSpot.
     // 3,4,5 are intentionally omitted from upsertStorage's create path.
     12: 'sex_storage', 15: 'sex_storage', 19: 'sex_storage',
     21: 'sex_storage', 25: 'sex_storage', 26: 'sex_storage',
     27: 'sex_storage', 28: 'sex_storage', 29: 'sex_storage',
     30: 'sex_storage', 31: 'sex_storage', 32: 'sex_storage',
     33: 'sex_storage', 34: 'sex_storage', 35: 'sex_storage',
     36: 'sex_storage', 37: 'sex_storage', 38: 'sex_storage',
     39: 'sex_storage',
   };
   // store-backing storages -> POS spot they belong to (P2 merge).
   export const STORE_BACKING_STORAGE: Readonly<Record<number, number>> = {
     3: 1, // Склад Кукча   -> spot 1 Кукча
     4: 2, // Склад Рабочий -> spot 2 Рабочий
     5: 3, // Склад Чигатай -> spot 3 Чигатай
   };
   // Safe default for any storage_id NOT in the table (a NEW storage Poster
   // adds later) — sex_storage is the non-disruptive default (never silently
   // becomes central/raw/store). PM reclassifies via PATCH /api/locations/:id.
   export const DEFAULT_STORAGE_TYPE = 'sex_storage';
   ```

2. **`upsertStorage` o'zgarishi (spec):**
   - Agar `storageId` `STORE_BACKING_STORAGE` da bo'lsa → **alohida location
     yaratmaydi**. O'rniga tegishli spot-location'ni topadi
     (`poster_spot_id = STORE_BACKING_STORAGE[storageId]`) va uning
     `poster_storage_id` ustunini set qiladi (P2 merge — agar bo'sh bo'lsa).
   - Aks holda: `const type = STORAGE_TYPE_BY_ID[storageId] ??
     DEFAULT_STORAGE_TYPE;` — va `INSERT ... VALUES ($1, $type, $2) ON
     CONFLICT (poster_storage_id) DO UPDATE SET name = EXCLUDED.name`.
     **Muhim:** `ON CONFLICT DO UPDATE` faqat `name` ni yangilaydi, `type`
     ni **EMAS** — chunki PM qo'lda o'zgartirgan turni sync qaytarib
     buzmasligi kerak (insert-time klassifikatsiya, update-time emas).
     Bu mavjud kodning "Existing rows keep their type" qoidasiga mos.

3. **Test (spec):** `test/seedSync.storage.test.ts` — har 25 storage_id
   to'g'ri turga map bo'lishini tasdiqlaydi; store-backing 3/4/5 alohida
   location yaratmasligini; noma'lum id `sex_storage` ga tushishini.

### 5.4 Real-ma'lumotli DB uchun stock-merge eslatmasi

Agar production DB'da store-backing storage location'larida (3/4/5)
allaqachon `stock` qatorlari bo'lsa, P2 merge'dan **oldin** ularni spot
location'iga ko'chirish kerak (`UPDATE stock SET location_id = <spot_loc>
WHERE location_id = <storage_loc>` + konflikt bo'lsa qty birlashtirish).
Bu **alohida data-migration qadam** — backend-engineer real DB holatini
tekshirib qaror qiladi. Greenfield/bo'sh DB'da bu shart emas. **Hech qanday
real-data destruktiv amal egasi/team-lead tasdig'isiz bajarilmaydi.**

---

## 6. Ochiq savollar (egasiga / kelajak tasdiq uchun)

- **OQ-1 (TZ §16 bilan bog'liq — Каймок):** `Склад Каймок` (21) egasi
  "umumiy tarqatiladi" dedi. Bu shared-input ombor (bir nechta sexga
  beradi) bo'lishi mumkin. Hozir `sex_storage`. Agar u xom-ashyo
  xarakterida bo'lsa (kaymak = yarim-xom-ashyo), `raw_warehouse` yoki
  alohida shared-storage modeli kerak bo'lishi mumkin. **Hozircha
  `sex_storage` (xavfsiz).**
- **OQ-2 (noaniq omborlar):** `Спец` (28), `Тошми` (30), `Минор` (31),
  `Салат` (33) — tarkibi egasidan tasdiqlanmagan. `sex_storage` default.
  Egasi aniqlasa PATCH yoki follow-up migration.
- **OQ-3 (spot 1 va 4 bir storage'ga):** "Кукча" (spot 1) va "Кукча
  центральный" (spot 4) ikkalasi ham storage 3'dan sotadi. Qaror: storage 3
  → spot 1 location'iga biriktiriladi; spot 4 alohida `store` qatori, lekin
  `poster_storage_id NULL`. Egasi tasdiqlashi kerak — agar "Кукча
  центральный" alohida ombor/sklad bo'lsa, model qayta ko'rib chiqiladi.
- **OQ-4 (Доставка spot 7):** "Доставка" (yetkazib berish) POS spot — fizik
  do'kon emas, kanal. `store` turi to'g'rimi yoki alohida modellashtirilsinmi?
  Hozir `store`, `poster_storage_id NULL`.

> Bu ADR shu OQ'larga **bog'liq emas** — barcha noaniq holatlar xavfsiz
> `sex_storage` default'iga tushadi, klassifikatsiya buzilmaydi. OQ'lar
> faqat aniqlik darajasini oshiradi.

---

## 7. Oqibatlar

**Ijobiy:**
- Dashboard "Markaziy sklad" kartasi faqat 1 omborni (id 8) ko'rsatadi —
  EPIC 2.2 / 7.2 chalkashligi hal bo'ladi.
- Sotuv + ostatka bitta do'kon location'iga tushadi (P2) — RBAC va do'kon
  dashboard'i to'g'ri.
- Replenishment topologiyasi to'g'ri turlarni ko'radi (raw/central/sex).
- Kelajakdagi sync hech qachon hammasini `central_warehouse` qilmaydi
  (deklarativ mapping + xavfsiz default).

**Salbiy / xavf:**
- **R1 — noaniq 5 ombor (OQ-2) `sex_storage` ga noto'g'ri tushishi mumkin.**
  Mitigatsiya: xavfsiz default; PATCH bilan tuzatiladi; klassifikatsiyaning
  boshqa qismiga ta'sir qilmaydi.
- **R2 — real-data DB'da P2 merge stock'ni ko'chirishni talab qiladi.**
  Mitigatsiya: §5.4 alohida data-migration qadam; bu migration faqat
  `locations` ni o'zgartiradi; destruktiv amal tasdiqsiz bajarilmaydi.
- **R3 — spot 4 ostatkasi (OQ-3) storage 3 orqali spot 1 da hisoblanadi**,
  spot 4 location'i ostatkasiz ko'rinadi. Mitigatsiya: egasi tasdig'i;
  agar muammo bo'lsa, ikki spotni bitta `store` location'iga birlashtirish
  (spot 4 ni spot 1 qatoriga merge) varianti bor.

---

## 8. Implementatsiya qadamlar ro'yxati (backend-engineer uchun)

1. `migrations/0028_poster_storage_classification.sql` — §5.2 skeletidan,
   stol/ustun nomlarini tekshirib.
2. `src/integrations/poster/storageClassification.ts` — §5.3 konstantalar.
3. `seedSync.upsertStorage` — §5.3.2 mantiq (merge + insert-time type +
   update faqat name).
4. `seedSync.upsertSpot` — spot 1/2/3 yaratilganda backing storage'ni ham
   set qilishni qo'llab-quvvatlash (yoki upsertStorage merge qadamida).
5. `test/seedSync.storage.test.ts` — §5.3.3.
6. `npm test -w @adia/backend` + `tsc --noEmit` toza bo'lishi.
