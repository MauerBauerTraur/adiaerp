# ADR-0015 — Ta'minot bo'limi → Sex skladi re-modeling

> Holat: **Qabul qilindi** (2026-05-28, egasi tasdig'i)
> Faza: 4 (post-MVP zinapoyasi)
> Bog'liqlik: D2 (Yarim Fabrika dual flow), D6 (har location o'z boshlig'i),
> ADR-0001 (replenishment state machine),
> migration 0019 (`reclassify_yarim_fabrika_add_perojniy_supply`).

---

## 1. Kontekst

MVP DB sxemasi `locations.type` enum'ida bitta umumiy qiymat — `supply`
(Ta'minot bo'limi) — orqali har sex bilan Markaziy Sklad o'rtasidagi
bufferni modellashtirgan. Egasi 2026-05-26 da uchta `supply` lokatsiya bor
deb aniqladi (Tort, Perojniy, Yarim Fabrika); migration 0019 shu bo'shliqni
to'ldirdi.

Lekin haqiqiy zanjirda **har sex (Tort sexi, Perojniy sexi, Yarim Fabrika
sexi) — alohida ishlab chiqarish floorida ishlaydi**, va har birining
o'ziga tegishli **ready-batch skladi** bor. Bu sklad sex floor'idan
chiqayotgan partiyani Markaziy Sklad jo'natmasidan oldin qabul qiladi,
sifat nazoratidan o'tkazadi, va kerak bo'lganda boshqa sexga (BOM oqimi
uchun) qaytaradi. Yagona "Ta'minot bo'limi" abstraksiyasi shu farqni
yashiradi: dashboard "Ta'minot Tort" kabi nom ko'rsatadi, lekin u
amaliyotda "Tort sexining tayyorlangan-batch skladi".

Frontend (dashboard) va AI assistant ham shu noaniqlikni meros qilib
oldi: AI yordamchi user'ga "Ta'minot bo'limi" deb murojaat qiladi, lekin
egasi va ombor xodimi "sex skladi" deydi.

Domen qiyofasini operatsion haqiqatga yaqinlashtirish kerak.

---

## 2. Variantlar

### Variant A — yangi enum qiymati `sex_storage` (tanlangan)

`location_type` enum'iga `sex_storage` qiymati qo'shiladi. Mavjud uchta
`supply` qator (id=3, 38, 39) `sex_storage` ga ko'chiriladi va parent'lari
sex floor'iga (mos `production` qatorga) bog'lanadi. Eski `supply` qiymati
enum'da qoladi — backward-compat uchun (1-2 sprint), keyin alohida
deprecation migration bilan o'chiriladi.

**+** Domen aniq aks etadi; har sex o'z buferi bilan.
**+** RBAC saqlanadi (`supply_manager` rol `sex_storage` ga biriktiriladi —
sinonim).
**+** Mavjud `stock`, `stock_movements`, `replenishment_requests`,
`production_orders` jadvalida hech qanday ko'chirish kerak emas: `location_id`
saqlanadi.
**−** ENUM'ni o'zgartirish ikki bosqichli (PG12+ `ALTER TYPE ADD VALUE`
yangi qiymatni xuddi shu tranzaksiyada ishlatishga ruxsat bermaydi) —
ikki alohida migration kerak (0021 va 0022).
**−** Kod o'zgarishlari (frontend tiplari, dashboard so'rovlari, AI tool
deklaratsiyasi) `supply | sex_storage` o'rtasida sinxron bo'lishi shart.

### Variant B — `supply` qator ostida pastki tip (sub-type column)

`locations` jadvaliga `subtype` ustun qo'shiladi. `type = 'supply'` qoladi,
`subtype = 'sex_storage' | NULL` belgilash.

**−** Domen ikki o'qda (`type` + `subtype`) yashiringan bo'ladi — har query
ikkala ustunni tekshirishi kerak.
**−** RBAC va dashboard mantiq dublikatsiya bo'ladi.

### Variant C — locations'ga `is_buffer` flag + nom o'zgartirish

`type = 'supply'` qoladi, lekin har `supply` qator yangi nomga (sex skladi)
ko'chiriladi va `is_buffer = TRUE` belgilanadi.

**−** Tip atamasi (`supply` — "Ta'minot bo'limi") domen bilan zid bo'ladi.
**−** Yangi flagni har query tekshirishi shart.

---

## 3. Qaror

**Variant A**.

Egasi 2026-05-28 da tasdiqladi: yangi `sex_storage` enum qiymati qo'shiladi,
uchta mavjud `supply` qator ko'chiriladi, eski qiymat keyingi
sprint(lar)gacha deprecated holatda qoladi.

---

## 4. Implementatsiya — migration tartibi

1. **0021** `add_sex_storage_type.sql` — `ALTER TYPE location_type ADD VALUE
   'sex_storage' BEFORE 'supply'`. Idempotent (pg_enum bo'yicha lookup).
   ALTER ENUM yangi qiymat **xuddi shu tranzaksiyada ishlatib bo'lmaydi**
   (PG12+ restriction); shuning uchun bu migration o'zining alohida
   tranzaksiyasida turadi.
2. **0022** `migrate_supply_to_sex_storage.sql` — uchta supply qatorni
   `UPDATE` qiladi (id=3, 38, 39): nom, type va parent_id rotatsiya
   qilinadi. Yarim Fabrika sexi (production) `INSERT NOT EXISTS` orqali
   qaytadan yaratiladi (migration 0019 uni supply ga aylantirgandan keyin
   yo'qolib qolgan edi). `stock`, `stock_movements`, `replenishment_requests`,
   `production_orders`, `user_locations`, `audit_log` jadvallariga
   tegilmaydi — `location_id` saqlanadi, har historical FK butun.
3. **Backend kod**: `LOCATION_TYPES` validators (`routes/locations.ts`,
   `routes/stock.ts`, `integrations/vertex/tools.ts`) `sex_storage` ni
   qabul qiladi, eski `supply` esa deprecated-sinonim sifatida saqlanadi.
   `dashboard.ts` va `dashboardDetail.ts` `locationIdsForTypeSql` ham bir
   nechta turga kengaytirilgan — supply card BOTH `supply` va `sex_storage`
   qatorlarini o'qiydi (zero-frontend-change).
4. **State machine — tegilmaydi**. `services/replenishment.ts` audit:
   `resolveTopology` faqat `production`/`raw_warehouse`/`central_warehouse`
   typlarini biladi (sex_storage va supply ikkalasini ham e'tibordan
   chetda qoldiradi); `advanceNew` `target_location_id` ni
   `central_warehouse` ga belgilaydi; `DONE_TO_WAREHOUSE` ham xuddi shu
   `target_location_id` ga deposit qiladi. Sex skladi state machine'dan
   **TASHQARIDA** — uni ko'r-ko'rona transfer movements (dashboard yoki
   manual harakatlar) orqali tashlanadi.
5. **`supply_manager` rol**: saqlanadi. `users.role = 'supply_manager'`
   bo'lgan har bir foydalanuvchi `sex_storage` typli lokatsiyaga
   biriktiriladi (`user_locations` orqali) — RBAC qoidalari avvalgidek
   ishlaydi.

---

## 5. Backward compatibility va deprecation rejasi

- ENUM `location_type` da `supply` qiymati saqlanadi.
- Validation array'lar ikkala qiymatni qabul qiladi.
- Dashboard supply/sex_storage ikkalasini ham birgalikda chiqaradi.
- AI tool deklaratsiya — `supply (deprecated synonym)` deb belgilanadi.

**1-2 sprint keyin**:
1. Frontend tiplarni `sex_storage` ga to'liq ko'chirish.
2. AI assistant prompt va tool deklaratsiyalardan `supply` ni olib tashlash.
3. ENUM'dan `supply` ni o'chirish uchun migratsiya (`ALTER TYPE RENAME VALUE`
   yo'q — yangi enum tipini yaratib jadvalni qayta yozish kerak).

---

## 6. Risk va mitigatsiya

**R1**. Replenishment state machine sex skladlarini "ko'rmaydi" — supply
layer'da turgan tovar yangi state'sda dashboard orqali boshqariladi.
**Mitigatsiya**: D2 (Yarim Fabrika dual flow) qoidalari saqlanadi —
manager qo'lda yoki AI yordamida transfer movement ochadi. Replenishment
state machine'ga sex_storage ko'mish keyingi epicning vazifasi
(`adr-0016-sex-buffer-aware-state-machine.md` — kelajakda).

**R2**. Eski supply qatori bo'lmagan test fixture'lar buziladi.
**Mitigatsiya**: `supply` enum qiymati saqlangani uchun test fixture'lar
o'zgarishsiz ishlaydi. 590 ta backend testdan birortasi qizil bo'lmadi.

**R3**. Frontend hali eski tarjima ko'rsatadi ("Ta'minot bo'limi").
**Mitigatsiya**: Frontend agent yangi label'larni Diff 4/5 da yangilaydi
(parallel epic).
