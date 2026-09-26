# ADR-0018 — Poster ↔ ERP retsept (BOM) pariteti

> Holat: **Qabul qilindi** (egasi tasdig'i bilan: "qulflarni yechib bajar")
> Sana: 2026-09-26
> Muallif: backend-engineer (team lead review'lari asosida, 4 raund)
> Bog'liqlik: ADR-0002 (Poster sync strategiyasi), ADR-0004 (yarim tayyor dual
> flow), ADR-0016 (zagatovka/ukrasheniye — retsept bosqichlari),
> migration 0029 (`recipes.stage`), 0039 (`brutto`), 0046 (`recipe_locked`).
> Kod: `apps/backend/src/integrations/poster/posterRecipe.ts`,
> `.../poster/recipeLock.ts`, `.../poster/seedSync.ts`,
> `apps/backend/src/services/posterRecipeApply.ts`,
> `apps/backend/src/services/posterRecipeAudit.ts`,
> `apps/backend/src/routes/posterRecipeAudit.ts`.

---

## 1. Kontekst

Egasi "Г/П МЕДОВИК ШОК ЧЕРНЫЙ" retsepti ERP'da Poster'dagidan farq qilishini
ko'rsatdi: ERP'da 1 qator (`з/г медовик`, qo'lda saqlangan), Poster'da 2 ta
yarim tayyor komponent. Sabablar:

- Qo'lda saqlangan retsept `recipe_locked = TRUE` bo'ladi va soatlik sync uni
  jimgina o'tkazib yuboradi.
- "Posterdan yuklash" prepack'ni faqat `poster_ingredient_id` bo'yicha qidirardi
  va miqdorni **netto** dan olardi (krem 1.0 bo'lib chiqardi, 0.06388 o'rniga).
- Poster'ning `product_id` va `ingredient_id` fazolari ustma-ust tushadi — ID
  noto'g'ri fazoda qidirilsa, **boshqa** mahsulot bog'lanib qolardi.

Egasining qarori: **har bir retsept Poster bilan bir xil bo'lsin, qulflar
yechilsin** — lekin ishlab chiqarishga kerak bo'lgan Hamir/Krem/Bezak
bo'linishi jimgina yo'qolmasin.

## 2. Qaror

### 2.1 Manba haqiqati — Poster

- Komponentlar ro'yxati va miqdorlar uchun **Poster** — yagona manba.
- Miqdor — **brutto** (ombordan haqiqatda chiqadigan va Poster tannarxni
  hisoblaydigan miqdor). Netto faqat brutto 0 yoki yo'q bo'lganda zaxira.
- Birlik: `structure_unit` → `ingredient_unit` (g→kg, ml→l), so'ng partiya
  chiqishiga (`out`, grammda → kg; menyu mahsuloti uchun 1) bo'linadi.
- Bir komponent Poster'da bir necha qatorda kelsa — miqdorlar **qo'shiladi**
  (ogohlantirish bilan).

### 2.2 `recipe_locked` semantikasi

- `TRUE` — retsept qo'lda tahrirlangan; soatlik sync unga tegmaydi.
- **Qulfni yechib qayta sinxronlash** — alohida, ongli amal:
  - bitta mahsulot: `POST /api/integrations/poster/product-recipe/:id/apply`;
  - ommaviy: "Poster bilan solishtirish" sahifasi (§2.5).

  Ikkalasi ham **bir xil** mahsulot tranzaksiyasini ishlatadi
  (`applyPosterRecipe`): mahsulot qatorini qulflash (`FOR NO KEY UPDATE`),
  BOM sikl tekshiruvi, yozish, `recipe_locked = FALSE`, audit
  (`product.recipe.poster_resync`, oldingi qatorlar bilan).
- `GET /api/products/:id/recipe` `recipe_locked` ni qaytaradi (UI ko'rsatadi).

### 2.3 ID bo'yicha bog'lash qoidalari (`resolveComponentProduct`)

1. ID nomzodlari, tartib **manbaga** qarab:
   - prepack tex-kartasi — `structure_type = 2` qator avval `poster_product_id`,
     `1` qator avval `poster_ingredient_id` bo'yicha;
   - menyu tex-kartasi — har doim avval `poster_ingredient_id` (eski tartib).

   Preview, apply va soatlik sync bir xil tartibni ishlatadi — natija
   "sakramaydi".
2. ID nomzodi nomi Poster nomiga mos kelsa — shu (turi mos kelgani afzal).
3. ID nomzodi bor, lekin nomi mos emas — **ID bog'lanishi saqlanadi**,
   ogohlantirish beriladi (nom bo'yicha nomzod ham ko'rsatiladi). Nom hech
   qachon haqiqiy ID bog'lanishini bosib o'tmaydi.
4. ID nomzodi umuman yo'q — faqat **nom** bo'yicha, turi mos (type 2 → `semi`;
   type 1 → `raw`/`semi`; `finished`/`gp` hech qachon), faol va yagona bo'lsa.
   Import ogohlantirishi yoziladi.

Ota mahsulotni nomi bo'yicha topish ham turga qarab: `semi`/`gp` → prepack,
`finished` → menyu. Mahsulot o'zini komponent qila olmaydi.

### 2.4 Bosqichlarni saqlash (`planRecipeRows`)

Poster'da bosqich tushunchasi yo'q; ERP'da esa `readFinalBom` bitta
`decoration` qatori bo'lsa faqat decoration qatorlarini o'qiydi (ADR-0016).

- **Komponentlar to'plami o'zgarmagan** — har komponent o'z bosqich(lar)ini
  saqlaydi. Bir necha bosqichga bo'lingan komponentda Poster'ning yangi jami
  eski miqdorlarga **proporsional** taqsimlanadi (4 xona, yaxlitlash qoldig'i
  eng katta qismga). Biror qism 0.0001 dan kichik bo'lsa — reset.
- **Komponent qo'shildi yoki olib tashlandi** — hamma qator `base`, ya'ni tekis
  retsept, uni har bir iste'molchi to'liq o'qiydi. Eski `decoration` yonida
  yangi komponentni `base` da qoldirish uni ishlab chiqarishda jimgina
  "yo'qotardi".
- **"Bosqich ma'lumoti"** — faqat `decoration`, `cream` va `assembly`. `base`,
  `dough` va `other` hammasi hamir bo'limiga tushadi: faqat ulardan iborat
  retsept tekis hisoblanadi va hech qachon bloklanmaydi.
- **Yozishdan oldin yaxlitlash:** yoziladigan har bir qiymat PostgreSQL
  saqlaganidek aniq yaxlitlanadi (`round4`: node-pg `String(n)` yuboradi,
  NUMERIC esa o'nlik satrni "half away from zero" bilan yaxlitlaydi). Float
  bilan yaxlitlash qiymatlarning ~0.7% ida farq qilardi — mahsulot abadiy
  "differs" bo'lib qolar edi.

### 2.5 Ommaviy tekshiruv / qo'llash / tiklash

Joylashuv: `/api/integrations/poster/recipe-audit`. Bir vaqtda bitta job,
xotirada saqlanadi (PM2 bitta jarayon).

- **run** — faqat o'qiydi, advisory lock olmaydi. Hisobotdagi holatlar:
  `match`, `differs`, `unresolved`, `poster_missing`, `poster_error`.
  Har item uchun `stages_will_reset` beriladi.
- **apply** (`pm`) — `product_ids` majburiy:
  - yangi pre-audit'da hali ham nishon bo'lganlargina qo'llanadi (`differs`,
    yoki `match` + qulflangan);
  - bosqich bo'linishini yo'qotadigan mahsulot faqat `include_stage_resets`
    bilan qo'llanadi (**opt-in**);
  - avval **bitta snapshot** audit qatori yoziladi (pre-audit holati: qatorlar
    `stage` bilan va qulf);
  - har bir mahsulot pre-audit holati bilan tranzaksiya ichida qayta
    solishtiriladi;
  - `lock_timeout 5s`, `statement_timeout 60s`;
  - bitta mahsulotning xatosi jobni to'xtatmaydi.
- **restore** (`pm`) — snapshot'dan tiklaydi (serverni qayta ishga
  tushirgandan keyin ham ishlaydi):
  - faqat o'sha job o'zgartirgan va hali ham aynan o'sha holatdagi mahsulotlar
    tiklanadi;
  - allaqachon tiklangan mahsulot "Allaqachon tiklangan" deb belgilanadi;
  - BOM sikl tekshiruvi o'tkaziladi.
- **Advisory lock** (`recipeLock.ts`): apply/restore, qo'lda
  `POST /sync` (products/all) va soatlik sync — bitta qulf. Band bo'lsa 409
  qaytadi, soatlik sync esa siklni o'tkazib yuboradi. Qulf ulanishi uzilsa,
  job keyingi mahsulotdan oldin to'xtaydi (`failed`, shu paytgacha bo'lgan
  natijalar saqlanadi).
- **Yakuniy audit bajarilmasa** (Poster ishlamasa) job baribir `done`. Hisobot
  natijalardan tuziladi va ogohlantirish qo'shiladi.

### 2.6 Soatlik sync siyosati (R6)

- Soatlik sync haqiqiy Hamir/Krem/Bezak bo'linishini **hech qachon jimgina
  tekislamaydi**. Yangi Poster tarkibi bo'linishni yo'qotadigan bo'lsa, retsept
  o'z holicha qoldiriladi va takrorlanmaydigan import ogohlantirishi yoziladi:
  "... 'Poster bilan solishtirish' sahifasida tasdiqlang". Egasi shu sahifada
  `include_stage_resets` bilan tasdiqlaydi.
- Qayta yozishda qatorlar o'zgargan bo'lsa, oldingi qatorlar
  `poster.recipe.import` audit yozuviga kiradi.

## 3. Oqibatlar va cheklovlar

- **R7 — solishtirish jamini ko'radi:** bosqichlarga bo'lingan retseptda audit
  komponent **jamini** Poster bilan solishtiradi, final zayavka esa faqat
  `decoration` qismini sarflaydi (ADR-0016). "match" — Poster jami bilan mos
  degani; bosqichlar orasidagi taqsimotni Poster tekshira olmaydi.
- **Aniqlik:** `NUMERIC(14,4)` — 0.00005 dan kichik miqdor (masalan, 1 kg
  partiyada 0.03 g vanilin) saqlanmaydi. Apply 422 bilan rad etadi, soatlik
  sync qatorni o'tkazib yuboradi. 10% dan ko'p yaxlitlanadigan qiymatlarda
  ogohlantirish beriladi. Masshtabni oshirish migratsiya va alohida qaror
  talab qiladi.

## 4. Ochiq masalalar

1. **`NUMERIC(14,4)` aniqligi** — kichik miqdorlar uchun masshtabni oshirish
   (ADR + egasi tasdig'i kerak).
2. **`audit_log` indeksi** — restore va `restorable_job_id` so'rovlari
   `payload->>'job_id'` / `payload->>'bulk_job_id'` bo'yicha filtrlaydi;
   jadval kattalashsa, action bo'yicha expression index kerak bo'ladi.
3. **S5** — soatlik sync bitta run davomida retsept qo'lda o'zgartirilgan
   bo'lsa, uni qayta yozib yuborishi mumkin (keyingi soatda o'zini tuzatadi).
   `updated_at` ga asoslangan himoya ataylab qo'shilmadi: sync'ning o'zi
   `updated_at` ni yangilaydi.
