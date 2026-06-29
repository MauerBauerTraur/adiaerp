# ADR-0004 — Yarim Fabrika ikki tomonlama oqimi

- Status: Qabul qilingan (taklif — egaga tasdiqlashga)
- Sana: 2026-05-22
- Muallif: system-architect
- Bog'liq: D2, TZ §6.3, `db-schema-phase-1.sql`

## Kontekst

Decision D2: Yarim Fabrika (semi-finished — hamir va boshqa yarim tovar) **ikki
tomonlama oqimga** ega:
1. **Markaziy Skladga** — jo'natma (`shipment`) sifatida (sotiladigan yarim tovar bo'lsa).
2. **Ishlab chiqarishga** — BOM komponenti sifatida qayta kirish (masalan, hamir →
   keyin tort retseptida ishlatiladi).

DB sxema va replenishment logikasi ikkala oqimni ham buzilmasdan qo'llab-quvvatlashi kerak.

## Qaror

### 1. `product_type` enum'ida alohida `semi` qiymat
`products.type` uch qiymatli: `raw`, `semi`, `finished`. `semi` — Yarim Fabrika
mahsuloti. Bu uni xom-ashyodan (`raw`) ham, tayyor mahsulotdan (`finished`) ham ajratadi
va logikaga "bu ikki tomonlama" signalini beradi.

### 2. `recipes` da `semi` ham `product_id`, ham `component_product_id` bo'la oladi
`recipes` jadvalida cheklov yo'q — `semi` mahsulot:
- `recipes.product_id` sifatida: yarim tovarning o'z retsepti bor (un + suv → hamir);
- `recipes.component_product_id` sifatida: boshqa mahsulot retseptida komponent (hamir → tort).
Yagona cheklov — `chk_recipe_no_self` (mahsulot o'zining komponenti bo'la olmaydi).
Chuqur tsikl (A→B→A) ilova darajasida BOM saqlashda tekshiriladi.

### 3. `semi` mahsulot `stock` da har bo'g'inda yashashi mumkin
`stock` har `(location_id, product_id)` uchun — `semi` mahsulot Yarim Fabrika bo'g'inida
ham, ishlab chiqarish bo'g'inida ham, markaziy skladda ham `stock` qatoriga ega bo'lishi
mumkin, har birida o'z min/max bilan (invariant 4). Bu ikki tomonlama oqimni tabiiy
qo'llab-quvvatlaydi — qo'shimcha jadval kerak emas.

### 4. Ikki oqim — ikki xil movement reason
- **Skladga jo'natma:** `transfer` reason'li `stock_movement` (Yarim Fabrika location →
  central warehouse) — oddiy bo'g'inlararo transfer.
- **Ishlab chiqarishga qayta kirish:** `production_input` reason — `semi` mahsulot boshqa
  zayafkaning BOM komponenti sifatida iste'mol qilinadi (ADR-0003 §5 "tayyor" oqimi).
Bir xil mahsulot, ikki xil reason — dashboard va audit ikkala oqimni ajrata oladi.

### 5. Replenishment `semi` mahsulot uchun ham ishlaydi
`semi` mahsulot `stock.qty <= min_level` bo'lsa — oddiy replenishment_request yaratiladi.
State machine `CHECK_PRODUCTION_INPUT` da `semi` ning o'z BOM'ini (un, suv) tekshiradi.
Hech qanday maxsus shox kerak emas — `semi` mahsulot `finished` kabi ishlanadi, farqi
faqat uning iste'molchisi (sklad emas, balki yana ishlab chiqarish bo'lishi mumkin).

## Muqobillar

- **`semi` ni alohida jadval (`semi_products`) sifatida:** rad etildi — `products` +
  `type` yetarli; alohida jadval `recipes`, `stock`, `stock_movements` ni murakkablashtiradi.
- **Ikki tomonlama oqimni alohida `bom_input` / `shipment` jadvallari bilan:** rad etildi —
  mavjud `recipes` + `stock_movements` + `reason` enum hammasini qoplaydi.
- **`semi` ni `raw` deb belgilash:** rad etildi — yarim tovarning o'z retsepti bor
  (ishlab chiqariladi), `raw` esa faqat xariddan keladi; semantik farq muhim.

### 6. Yarim Fabrika lokatsiyasi — alohida `supply` location (OS-4 hal qilindi)

Egasi qaroriga ko'ra (2026-05-22) Yarim Fabrika `production` ichidagi bo'g'in emas,
balki **alohida `supply` location** (`location.type='supply'`) — Tort va Perojniy
ta'minot bo'limlari bilan bir xil turda. Sabab:
- Yarim Fabrika o'z ostatkasiga va o'z min/max iga ega bo'lishi kerak — alohida
  `location` bu uchun zarur (`stock` PK `(location_id, product_id)`).
- D2 ikki tomonlama oqim shu location'da kechadi: Yarim Fabrika `supply` location'idan
  markaziy skladga `transfer`, hamda ishlab chiqarish zayafkasiga `production_input`.
- Yarim Fabrika'ning o'z boshlig'i bo'ladi (D6) — `locations.manager_user_id`.

Demak `semi` — `product_type` enum qiymati (mahsulot turi), Yarim Fabrika esa
`location` (bo'g'in). Ikkisi alohida o'q: `semi` mahsulot Yarim Fabrika `supply`
location'ida ham, boshqa bo'g'inlarda ham `stock` qatoriga ega bo'lishi mumkin.

## Oqibatlar

- (+) Ikki tomonlama oqim mavjud jadvallar bilan, qo'shimcha sxemasiz.
- (+) `semi` mahsulot zanjirning istalgan bo'g'inida `stock` va min/max ga ega.
- (+) Movement `reason` orqali ikki oqim auditda ajraladi.
- (+) Yarim Fabrika alohida `supply` location — o'z ostatkasi, min/max va boshlig'i bilan.
- (−) BOM tsikli (`semi` → `semi` → ...) ilova darajasida tekshirilishi shart — DB
  faqat to'g'ridan-to'g'ri o'z-komponentni bloklaydi.
