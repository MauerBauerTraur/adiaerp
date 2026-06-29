# ADIA ERP — Egasi feedback'i bo'yicha o'zgarishlar rejasi (2026-05-29)

> Manba: `docs/ADIA ERP uchun ozgarishlar (1).docx` (8 KB matn + 29 skrinshot).
> Ushbu fayl hujjatdagi BARCHA talablarni epic-task ko'rinishida to'liq jamlaydi.
> Holat: **egasi tasdig'ini kutmoqda** (reja bosqichi).

## Egasi qarorlari (2026-05-29)
- **Ko'lam:** to'liq hammasi bajariladi (bitta track emas).
- **Write-back (Q7):** Poster **read-only** manba bo'lib qoladi — nakladnoy/zayavka/seyf rasxod faqat ADIA ichida yashaydi.
- **Sklad mapping (Q8):** men taklif tuzaman → egasi tasdiqlaydi (pastda EPIC 0+ ostida).
- **AI ishlab chiqarish dialogi (Q5):** **web UI + Telegram bot** ikkalasida.

## Sintez (qisqacha)

Hujjat 10 ta yo'nalishdagi tuzatish va yangi feature'ni o'z ichiga oladi:
1. **Poster sinx xatolari** (kritik blocker) — summalar, chart, breakdown, retseptlar noto'g'ri.
2. **Mahsulotlar moduli** — custom filter, translit/AI search, smart kategoriya, card UX.
3. **Bo'g'inlar** — admin connection'ni custom sozlashi; sklad turlarini to'g'rilash.
4. **Foydalanuvchi + Hodim birlashtirish** — TG self-link bilan.
5. **To'ldirish so'rovlari / So'rovnomalar** — filter+search, tarix UX, "Yetkazish" modulini olib tashlash.
6. **Ishlab chiqarish & sex skladi logikasi** (eng katta) — zagatovka/ukrasheniye, AI dialog, retseptdan so'rovnoma.
7. **Sotib olish so'rovlari** — admin→skladchi oqimi, izchil header/filter.
8. **Dashboard altitude** — faqat kerakli raqamlar, KPI click→detail.
9. **Kassa/chek & nakladnoy** (mijoz feedback) — chek-darajali ostatka, fors major, zayavka→nakladnoy, do'kon/seyf.
10. **AI assistant ulanishi** + UI errorlar (jumladan "Секс склады" typo).
</content>

---

## EPIC 0 — Poster sinxronizatsiya tuzatishlari ⛔ KRITIK / BLOCKER
> Bu blok boshqa hammasiga ta'sir qiladi (ma'lumot ishonchsiz bo'lsa, dashboard ham noto'g'ri). Birinchi navbatda.

| # | Vazifa | Tafsilot (hujjatdan) | Agent | Acceptance |
|---|--------|----------------------|-------|------------|
| 0.1 | Tushum summalari noto'g'ri | Summalar hato yuklanyapti (image11, image4) | backend-engineer | Poster summalari real Poster qiymatiga 1:1 mos; test fixture bilan tasdiqlanadi |
| 0.2 | Sotuv charti noto'g'ri | Sotuv chartда hamma to'g'ri ma'lumot chiqmayapti (image10 — 30 kun chart faqat oxirgi 2 kunda spike) | backend-engineer | Chart Poster sotuvlariga mos; bo'sh kunlar 0, real kunlar to'g'ri |
| 0.3 | Bugungi tushum breakdown xatosi | Naqd/Karta/Payme/Click breakdown 0% va 0 ko'rsatyapti, jami 11M (image11). To'liq diagnostika hisoboti kerak | backend-engineer | Breakdown jami = umumiy tushum; har kanal real summasi; **alohida diagnostika hisoboti** beriladi |
| 0.4 | "Bugungi tushum" matni dinamik | Hafta/Oy/6 oy filtri tanlsa ham "Bugungi tushum" deb turibdi (image8/image11) | frontend-engineer | Sarlavha filterga qarab: "Bugungi/Bu haftalik/Bu oylik/6 oylik tushum" |
| 0.5 | Retseptlar to'liq yuklanmagan | Retseptlar noaniq, tartibsiz; Poster polufabrikat tarkibi (brutto/netto/sebestoimost) yuklanmagan (image25, image20, image15, image23, image31) | backend-engineer | Poster recipe/ingredient API'dan to'liq BOM sinx: komponent, brutto, netto, birlik; ≥ tekshiruv mahsulotlar uchun mos |
| 0.6 | Sklad mapping | Poster'dagi alohida skladlar tizimga to'g'ri map bo'lishi kerak (EPIC 2.2 bilan bog'liq) | backend-engineer | Har Poster storage → to'g'ri `location` + turi |

**Bog'liqlik:** 0.3 oldidan `code-reviewer`/`research-analyst` real Poster javobini tahlil qilishi mumkin.

---

## EPIC 1 — Mahsulotlar moduli (Products)

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 1.1 | Custom multi-select + search filter | Bitta "Filter" tugmasi bosilsa popover ochiladi (image14 referens: Voronka/Menejer/Manba tab'lari, search, checkbox+count, "Qo'llash"/"Hammasini tozalash"). Bizga kerak: **Mahsulot turi** filteri, **O'lchov birligi** filteri | frontend-engineer + ui-ux-designer | Multi-select, qidiruv, tab'lar; tanlov "Qo'llash" bilan qo'llanadi; count ko'rsatiladi |
| 1.2 | Translit/AI search | Poster'da nomlar rus/kirillda. Lotinchada qidirsam ham, rusda yozsam ham topilishi kerak | backend-engineer | "shokolad" ↔ "шоколад" ↔ "shakar/шакар" ikki tomonlama topadi (translit + normalize) |
| 1.3 | Smart kategoriya | `Г/П` prefiksli mahsulotlar = **to'liq tayyor mahsulot** (sotuvga tayyor) — shu turkumga olinadi. AI nomdan kategoriya bersin: "flavis", "coca cola" → ichimlik; "Number Candles" → tort bezagi | backend-engineer (AI) | Г/П → `finished`; AI auto-kategoriya field; noto'g'ri bo'lsa qo'lda tahrir |
| 1.4 | Card UX | (a) Card rangini AI ajratib bersin (turkumga qarab); (b) default filter = **tayyor mahsulot** tanlangan; (c) scroll/infinite pagination — og'irlashmasin | frontend-engineer | Default'da tayyor mahsulot; lazy/virtual scroll; turkum bo'yicha rang-kod |
| 1.5 | Retsept (BOM) ko'rinishi | Retsept hamir/krem/bezak bo'yicha **ajratilgan** ko'rsatilishi; "1 birlik uchun" miqdorlar (image20/31). Poster bilan moslashgan | frontend-engineer + backend-engineer | BOM bo'limlarga ajratilgan (hamir/krem/bezak); brutto/netto; tahrirlash modali |

---

## EPIC 2 — Bo'g'inlar (Locations) & connections

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 2.1 | Admin connection custom | Bo'g'inlar orasidagi connection'ni admin o'zi sozlay olishi kerak (image13). Allaqachon `location_flows` M:N bor — UI/CRUD qo'shiladi | frontend-engineer + backend-engineer | Admin UI'dan oqim (manba→qabul) qo'shish/o'chirish; EcosystemCanvas'da aks etadi |
| 2.2 | Sklad turlarini to'g'rilash | "Склад Центральный" = markaziy; qolganlari markaziy EMAS (image29/28 noto'g'ri). To'liq sklad ro'yxati (image27 + matn): Песочный, Самсы, Тортов, Каймок, Тартов, Бисквит, Декора, Горячих, Наполеон, Салат, Эклеров, Круассанов, Евро, Пирогов; **maxsus**: Основной-хомошё (xom-ashyo), Центральный (sexdan chiqqan tayyor), Заготовок, Полуфабрикаты, торт загатовка, каймок | system-architect + backend-engineer | Har sklad to'g'ri `location_type`; "Markaziy sklad" faqat Центральный'ni qamraydi; migration |

---

## EPIC 3 — Foydalanuvchi & Hodim birlashtirish

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 3.1 | Users + Employees merge | "Foydalanuvchilar" va "Hodimlar" tablari birlashtirilsin — hodimlar = foydalanuvchilar (image32) | system-architect + backend-engineer + frontend-engineer | Bitta entity/jadval; eski tablar bitta "Hodimlar/Foydalanuvchilar"ga birlashadi; migration |
| 3.2 | TG self-link | Hodim yaratilganda TG id qo'shiladi; hodim o'zi "TGni ulash" tugmasi orqali bot'da ulanadi | backend-engineer (bot) | Bot `/start <token>` orqali hodim TG id'sini bog'laydi; admin UI'da status |

---

## EPIC 4 — To'ldirish so'rovlari & So'rovnomalar UX

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 4.1 | Custom filter + smart search | To'ldirish so'rovlariga (image26) filter: **O'lchov birligi** (l/kg/soni), **Holat**, **Bo'lim** + **Smart Search** | frontend-engineer | EPIC 1.1 dagi custom select komponentidan foydalanadi |
| 4.2 | So'rovlar tarixi UX | O'tishlar tarixi tushunarli, sodda, vizual chiroyli (image24) | ui-ux-designer + frontend-engineer | Timeline aniq o'qiladigan; holat o'tishlari rang/ikon bilan |
| 4.3 | "Yetkazish so'rovlari" modulini olib tashlash | Bunday bo'lim hozir yo'q — bo'limlar bir-biriga to'g'ridan-to'g'ri jo'natadi; tovar kelganda qabul qiladi; o'rtada hodim yo'q (image18) | frontend-engineer + backend-engineer | "Yetkazish berish" tab/modul olib tashlanadi yoki "qabul qilish" oqimiga aylantiriladi (ochiq savol Q4) |

---

## EPIC 5 — Ishlab chiqarish & Sex skladi logikasi 🧠 ENG KATTA
> Mavjud ADR'lar: `adr-0004-semi-finished-dual-flow`, `adr-0015-sex-storage-remodeling`. Ular ustiga quriladi.

**Domen logikasi (hujjatdan):**
- Sex skladida **tayyor** yoki **yarim tayyor** (zagatovka) mahsulot turadi.
- **Zagatovka** = tort 70% tayyor; buyurtma tushganda ishlab chiqarish shu yerdan oladi va **ukrasheniye** qiladi.
- **Ukrasheniye** = tort ustiga bezak + tayyorlash → markaziy skladga yuborish.
- **Yarim Fabrika sex EMAS, u sklad** — yarim tayyor hamir, qiyma, krem turadi.
- Sex skladida ham **min/max** — buyurtma tez bajarilishi uchun doim minda zagatovka turadi; 10ta olinса qaytadan to'ldiriladi.

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 5.1 | Sex skladi domen modeli | zagatovka / ukrasheniye / yarim-fabrika sklad; min/max sex skladida | system-architect | ADR yangilanadi; data model zagatovka↔tayyor o'tishini qo'llab-quvvatlaydi |
| 5.2 | AI-driven ishlab chiqarish dialogi | Buyurtma tushganda AI sex useridan so'raydi: "10ta tortga buyurtma. 20 zagatovka bor — tayyordan olasanmi yoki 0dan qilasanmi?" → "0dan" bo'lsa hamir retsepti bo'yicha xom-ashyo so'rovi; zagatovka tayyor bo'lgach ukrasheniye; kremlarni tekshir — 0 bo'lsa yoki yangi tayyorlash → ukrasheniye materiallari uchun mahsulot omboriga so'rov | backend-engineer (AI) + system-architect | AI dialog flow; foydalanuvchi javobiga qarab so'rovnoma shakllanadi |
| 5.3 | Retseptdan avtomatik so'rovnoma | Ishlab chiqarish retseptdan kelib chiqib material so'rovnomasi shakllaydi. **Zagatovka tayyor bo'lsa hamir retsepti kerak emas — faqat ukrasheniye (krem+bezak)**. Retseptdagi narsalar mahsulot omboridan tekshiriladi | backend-engineer | So'rovnoma faqat yetishmaganini so'raydi; zagatovka holatiga qarab hamirni o'tkazib yuboradi |
| 5.4 | Yarim Fabrika = sklad | Sex emas, sklad sifatida modellashtirish (EPIC 2.2 bilan birga) | system-architect + backend-engineer | Yarim Fabrika `location_type` = sklad; ikki tomonlama oqim saqlanadi |
| 5.5 | Sex skladi min/max + avto-to'ldirish | Zagatovka olingach qoldiq min'dan tushsa → avtomatik to'ldirish tsikli | backend-engineer | Replenishment engine sex skladiga ham qo'llanadi |

---

## EPIC 6 — Sotib olish so'rovlari

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 6.1 | Admin→skladchi oqimi | Sotib olish so'rovlarini admin buyurtma qilib skladchiga yuboradi (image21) | backend-engineer | Admin so'rov yaratadi → skladchiga yo'naltiriladi; ikki bosqichli tasdiq saqlanadi |
| 6.2 | Izchil header + filter | Header va filter barcha modullarda bir xil (image8 referens); dashboard'da kalendar/soat moduli; qo'llanmada ham | frontend-engineer + ui-ux-designer | Umumiy `PageHeader` + filter komponent; sana/soat widget barcha sahifalarda |

---

## EPIC 7 — Dashboard altitude (faqat kerakli ma'lumot)

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 7.1 | Faqat kerakli raqamlar + clickable | Admin modullarga kirganda faqat kerakli raqamlar; qolgani yashirin (boshliq chalg'imasin). Hamma joyga link; KPI card bosilsa → detail (to'liq ma'lumot) (image17) | ui-ux-designer + frontend-engineer | Har KPI card clickable → detail sahifa/modal; ortiqcha raqamlar olib tashlanadi |
| 7.2 | Markaziy sklad dashboard tuzatish | Hozir xato va tushunarsiz (image29/28) | frontend-engineer | Aniq, sodda; markaziy sklad = faqat Центральный |

---

## EPIC 8 — Kassa / chek & nakladnoy (mijoz feedback) 💰
> Mavjud ADR'lar: `adr-0013-yandex-stt`, `adr-0014-voice-to-action`, `adr-0011-telegram-inline-actions`.

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 8.1 | Kassa cheklari alohida | Kassada tushgan cheklar alohida bo'lsin; POS'ga urilgan mahsulot bazasi botga tushsin (image19) | backend-engineer | Chek-darajali ma'lumot Poster'dan; botga push |
| 8.2 | Chek bo'yicha ostatka | Har chek bo'yicha: Ост 10 − sotildi 5 − itogo 5 qoldi | backend-engineer | Har chekda harakat hisoblanadi; qoldiq yangilanadi |
| 8.3 | Fors major / minus ogohlantirish | Ост 10 − sotildi 11 → −1: "noto'g'ri urilgan" deb menga xabar (kassa bazasida ko'p, bazada kam) | backend-engineer (bot) | Manfiy chiqsa admin/menejer ga ogohlantirish; ostatka manfiy bo'lmaydi (invariant) |
| 8.4 | Zayavka → nakladnoy | "10 Napoleon sotildi" → hamir uchun / krem uchun nakladnoy. Ikkalasi **bitta nakladnoyda tepa-past**: krem uchun (un, shakar...), hamir uchun (un, shakar...), **itogo umumiy un/shakar kg**. Ochiqroq yoritilgan | backend-engineer + frontend-engineer | Bitta nakladnoy: bo'limlarga ajratilgan + jami; retseptdan avto-hisob |
| 8.5 | Do'kon kassa topshirig'i | Smena yopilganda: rasxod 5M, qoldiq 3M (kartadan 2M), itogo savdo → bot'ga yozsa unga va menga ko'rinadigan nakladnoy shakllansin (image2 referens — kniжный/факт balans, prihod/rasxod/inkassatsiya) | backend-engineer (bot) | Kassir bot orqali topshiradi → nakladnoy + admin ko'rinishi |
| 8.6 | Do'kon golosovoy → nakladnoy | Do'kon mahsulot olganda golosovoy (ovozli) jo'natadi → nakladnoy shakllanadi | backend-engineer (STT/bot) | Voice → STT → nakladnoy (ADR-0014 asosida) |
| 8.7 | Seyf rasxodlari | Seyf rasxodlari uchun ham xuddi shunday (nakladnoy/transaksiya) | backend-engineer | Seyf rasxodi transaksiya sifatida qayd etiladi |

---

## EPIC 9 — AI assistant ulanishi

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 9.1 | AI ulanmagan | "Помощник ИИ временно недоступен" (image2/ИИ). Vertex AI Gemini ulanmagan | backend-engineer (AI) | Assistant javob beradi; function calling DB ustida (ADR-0006); "Что в красном состоянии" kabi savolga real javob |

---

## EPIC 10 — UI errorlar

| # | Vazifa | Tafsilot | Agent | Acceptance |
|---|--------|----------|-------|------------|
| 10.1 | "Секс склады" typo | Uyatsiz/noto'g'ri so'z yozilib qolgan: "Секс склады" → to'g'ri "Sex skladlari / Цех склады" (image22) | frontend-engineer | Barcha joyda to'g'ri atama; grep bilan tekshiriladi |
| 10.2 | Boshqa UI errorlar | Umumiy UI sayqallash (review natijasi bo'yicha) | frontend-engineer | code-reviewer hisobotiga ko'ra |

---

## Bajarish tartibi (to'lqinlar)

- **To'lqin 1 (blocker):** EPIC 0 (Poster sinx) — boshqa hammasi shunga tayanadi.
- **To'lqin 2 (poydevor):** EPIC 2 (sklad turlari), EPIC 3 (user/hodim merge) — data modeliga ta'sir qiladi.
- **To'lqin 3 (parallel):** EPIC 1, 4, 6, 7, 10 — UI/UX yo'nalishlari parallel.
- **To'lqin 4 (katta logika):** EPIC 5 (sex skladi), EPIC 8 (kassa/nakladnoy).
- **To'lqin 5:** EPIC 9 (AI), yakuniy review.

---

## EPIC 0+ — POSTER TO'LIQ INTEGRATSIYA (deep-dive) 🔌
> Egasi so'rovi: "Poster hali to'g'ri moslashmagan — uni to'liq integratsiya qilish usulini ko'rib chiq."
> Manba: `docs/adia-poster-api.md` (626 q) + mavjud kod (`apps/backend/src/integrations/poster/*` ~1939 q).

### Hozir BOR (ishlaydi) ✅
Read-only typed klient (rate-limit ~4.5 req/s, retry, timeout, token redaction). Sinxlangan:
- `access.getSpots` → `locations(type='store')` (5 filial)
- `storage.getStorages` → `locations` (25 ombor)
- `storage.getStorageLeftovers` → `stock` reconcile (manfiy qoldiq → 0 ga clamp + ogohlantirish)
- `menu.getIngredients` → `products(raw)`
- `menu.getPrepacks` → `products(semi)` + `recipes` (BOM)
- `menu.getProducts` + `menu.getProduct` → `products(finished)` + `recipes`
- `dash.getTransactions` + `dash.getTransaction` → `sales` + ostatka kamayishi (webhook + 30 daq poll)
- `dash.getPaymentsReport` → to'lov breakdown (naqd/karta/payme/click)
- `syncLog` kuzatuv + bildirishnomalar

### Bo'shliqlar / muammolar (nega "to'liq moslashmagan") ⛔

| # | Muammo | Ildiz (fayl:qator) | Bog'liq EPIC | Yechim |
|---|--------|--------------------|--------------|--------|
| P1 | **Sklad klassifikatsiyasi YO'Q** — 25 ombor hammasi `central_warehouse` | `seedSync.ts:107` `upsertStorage` default `'central_warehouse'` | 2.2, 7.2 | Poster `storage_id → location_type` mapping jadvali + migration (Заготовок→sex/zagatovka, Украшений→sex/ukrasheniye, Основной→raw, Центральный→central, Полуфабрикаты→yarim_fabrika...) |
| P2 | **Filial↔ombor bog'lanishi modellashmagan** — spot 1 Кукча → storage 3 (doc §3); hozir spot=store, storage=warehouse alohida | seedSync (spot va storage alohida upsert) | 2.1, 2.2 | Store'ga backing storage biriktirish; sotuv ostatkasi to'g'ri bo'g'inga tushishi |
| P3 | **To'lov birligi ZIDDIYAT** — kod "tiyin (÷100)" deydi (`client.ts:160`), doc "to'g'ri so'm, tiyin emas" (doc §8 q.505) | `client.ts:158-186` izoh vs doc | 0.3 | Real javobni tekshirish; to'g'ri birlikni qat'iy belgilash → breakdown 0%/0 bug shu yerda |
| P4 | **`dash.getAnalytics` ISHLATILMAGAN** — doc'dagi eng muhim metod (revenue/profit/tx/avg) wrap qilinmagan | client.ts (yo'q) | 0.1, 0.2 | Dashboard summa/chart `sales` agregatidan emas, Poster analytics'dan; yoki tarixiy backfill |
| P5 | **Tarixiy backfill yo'q** — sotuvlar faqat sinx boshlanганидан keyin; shuning uchun 30-kunlik chart faqat oxirida spike (image10) | salesSync (faqat oldinga poll) | 0.2 | Bir martalik tarixiy import (`dash.getTransactions` keng oyna yoki `getAnalytics` agregat) |
| P6 | **Sana format mo'rtligi** — `dash.getTransactions` vaqt qo'shilsa 0 qator; poll har tick butun kunga kengayadi | `salesSync.ts:371-381` | 0.1 | Webhook asosiy yo'l bo'lishi; poll faqat zaxira |
| P7 | **Webhook sozlanmagan bo'lishi mumkin** — `transaction.close` webhook Poster admin'da yozilishi shart (doc §5.8) | konfiguratsiya | 0.1, 8.1 | Webhook URL Poster admin → Уведомления → API Webhook; tasdiqlash |
| P8 | **Finance API umuman yo'q** — `finance.getCashshifts/getTransactions/createTransaction` (doc §5.6) | client.ts (yo'q) | 8.5, 8.7 | Kassa smenasi, inkassatsiya, seyf rasxod (image2) uchun finance sinx kerak |
| P9 | **Employees/Clients sinx yo'q** — `access.getEmployees`, `clients.getClients` | client.ts (yo'q) | 3.1 | Hodimlarni Poster'dan tortib olish imkoni |
| P10 | **Chek-darajali ostatka yo'q** — hozir umumiy leftover reconcile, har chek bo'yicha "ost 10−sot 5−qoldi 5" emas | salesSync (line decrement, lekin per-chek ostatka emas) | 8.2, 8.3 | Chek-darajali harakat + manfiy → "noto'g'ri urilgan" alert |
| P11 | **Write-back ishlatilmagan** — `createWriteOff/createMoving/createSupply`, `incomingOrders`, `finance.createTransaction` | client.ts (yo'q) | 8.4 (kel.) | Nakladnoy/zayavka Poster'ga qaytarish kerakmi — ochiq savol Q7 |

### Sklad klassifikatsiya TAKLIFI (P1 — egasi tasdig'iga)
> ADIA `location_type`: `raw_warehouse`, `production`, `central_warehouse`, `store`, `sex_storage`.
> Manba: `docs/adia-poster-api.md §4` (25 ombor, 2026-05-07). ⚠️ = tasdiqlash kerak.

| Poster id | Poster nomi | Taklif tur | Izoh |
|-----------|-------------|------------|------|
| 2 | Основной склад | `raw_warehouse` | Xom-ashyo ombori (asosiy) |
| 8 | Склад Центральный | `central_warehouse` | **YAGONA** markaziy — sexdan chiqqan tayyor mahsulot |
| 20 | Производственный Цех | `production` | Ishlab chiqarish sexi |
| 3 | Склад Кукча | `store` | Filial 1/7 stockroom → "Кукча" do'koni bilan bog'lash (P2) |
| 4 | Склад Рабочий | `store` | Filial 2 → "Рабочий" |
| 5 | Склад Чигатай | `store` | Filial 3 → "Чигатай" |
| 35 | Склад Заготовок | `sex_storage` | Zagatovka skladi (EPIC 5) |
| 36 | Склад Украшений | `sex_storage` | Ukrasheniye / bezak |
| 27 | Склад Декора | `sex_storage` | Dekor (ukrasheniye) |
| 21 | Склад Каймок | `sex_storage` | ⚠️ Egasi "umumiy tarqatiladi" dedi — shared input bo'lishi mumkin |
| 12 | Склад Песочный | `sex_storage` | Sex skladi |
| 15 | Склад Самсы | `sex_storage` | Somsa sexi |
| 19 | Склад Тортов | `sex_storage` | Tort sexi |
| 25 | Склад Тартов | `sex_storage` | |
| 26 | Склад Бисквит | `sex_storage` | |
| 29 | Склад Горячих | `sex_storage` | |
| 32 | Склад Наполеон | `sex_storage` | |
| 33 | Склад Салат | `sex_storage` | |
| 34 | Склад Эклеров | `sex_storage` | |
| 37 | Склад Круассанов | `sex_storage` | |
| 38 | Склад Евро | `sex_storage` | |
| 39 | Склад Пирогов | `sex_storage` | |
| 28 | Склад Спец | `sex_storage` | ⚠️ noaniq — nima saqlanadi? |
| 30 | Склад Тошми | `sex_storage` | ⚠️ noaniq |
| 31 | Склад Минор | `sex_storage` | ⚠️ noaniq |

**⚠️ Nomuvofiqliklar (egasi tasdiqlashi kerak):**
- Egasi ro'yxatida bor, lekin Poster §4 da YO'Q: "Склад Полуфабрикаты" (yarim fabrika), "Склад торт загатовка". Poster'da "Склад Заготовок"(35) bor. → **Live `storage.getStorages` chaqirib hozirgi haqiqiy ro'yxatni olish kerak** (doc 2026-05-07 — eskirgan bo'lishi mumkin).
- "Yarim Fabrika skladi" ADIA'da allaqachon `sex_storage` (migration 0025) — Poster "Полуфабрикаты" shunga map bo'ladi (agar mavjud bo'lsa).

### Tavsiya etilgan integratsiya bosqichlari
1. **P1+P2 (poydevor):** sklad klassifikatsiya mapping + filial↔ombor bog'lanishi → bu EPIC 2 va dashboard chalkashligini hal qiladi. → `system-architect` ADR + `backend-engineer` migration.
2. **P3+P4+P5 (ma'lumot to'g'riligi):** birlik fix + getAnalytics wrap + tarixiy backfill → EPIC 0 blocker'larini yopadi. → `backend-engineer` + diagnostika hisoboti.
3. **P6+P7 (ishonchlilik):** webhook tasdiq + poll zaxira.
4. **P8+P9 (kengaytirish):** finance + employees sinx → EPIC 3, 8.5, 8.7.
5. **P10+P11 (ilg'or):** chek-darajali ostatka + write-back (agar kerak bo'lsa).

---

## Ochiq savollar (egasiga)
- **Q1 (EPIC 8.1):** Chek-darajali ma'lumot Poster API'dan real-time keladimi (webhook/poll), yoki kunlik batch? Bu botga push tezligini belgilaydi.
- **Q2 (EPIC 8.4):** Nakladnoy real PDF/print hujjatmi yoki ichki ekran ko'rinishimi?
- **Q3 (EPIC 1.2):** Translit search — oddiy kirill↔lotin transliteratsiya yetarlimi, yoki haqiqiy AI/semantik qidiruv (Vertex) kerakmi?
- **Q4 (EPIC 4.3):** "Yetkazib berish" moduli butunlay o'chiriladimi yoki "qabul qilish/tasdiqlash" oqimiga aylantiriladimi?
- **Q5 (EPIC 5.2):** AI production dialog qaysi kanalda — web UI'da modal so'rovmi yoki Telegram bot orqalimi?
- **Q6 (umumiy):** Ustuvorlik — qaysi epic birinchi kerak (Poster blocker'dan keyin)?
- **Q7 (P11):** Nakladnoy/zayavka/seyf rasxod Poster'ga **qaytarib yozilishimi** (write-back: createWriteOff/createTransaction) yoki faqat ADIA ichida qolsinmi?
- **Q8 (P1):** Sklad klassifikatsiya mapping'ini men taklif qilaymi (25 ombor → tur) — siz tasdiqlaysizmi, yoki har birini birga ko'rib chiqamizmi?
