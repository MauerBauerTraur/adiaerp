# ADR-0003 — Transaksion stock_movement modeli

- Status: Qabul qilingan (taklif — egaga tasdiqlashga)
- Sana: 2026-05-22
- Muallif: system-architect
- Bog'liq: TZ §8.4, CLAUDE.md §6 (invariant 1, 3, 5), `db-schema-phase-1.sql`

## Kontekst

ADIA ning eng muhim invarianti: har stock o'zgarishi atomar — manba kamayadi, qabul
oshadi, audit yoziladi; ostatka hech qachon manfiy bo'lmaydi. Bu do'kon savdosi
(yuqori yuk), ishlab chiqarish "tayyor" oqimi va bo'g'inlararo jo'natmalar uchun bir xil
ishlashi kerak.

Talablar:
- Invariant 1: har movement — bitta atomar tranzaksiya yoki hech narsa.
- Invariant 3: `stock.qty >= 0` har doim.
- Invariant 5: "tayyor" — BOM bo'yicha bir nechta xom-ashyo chiqimi + sklad kirimi, hammasi atomar.
- Parallel savdo (high-load) ostatkani buzmasligi kerak.

## Qaror

### 1. `stock_movements` — append-only ledger
`stock` joriy holatni saqlaydi; `stock_movements` har o'zgarishni o'zgarmas yozuv
sifatida saqlaydi. `stock_movements` qatorlari hech qachon `UPDATE`/`DELETE` qilinmaydi.
`stock.qty` — ledger'dan kelib chiqadigan denormalizatsiyalangan joriy holat (tezlik uchun).

### 2. Har movement — bitta DB tranzaksiya
Backend har stock o'zgarishini quyidagi ketma-ketlikda bitta `BEGIN ... COMMIT` ichida bajaradi:
```sql
BEGIN;
  -- 1. Guard'li kamaytirish: WHERE qty >= :qty manfiy natijani imkonsiz qiladi
  UPDATE stock SET qty = qty - :qty
    WHERE location_id = :from AND product_id = :pid AND qty >= :qty;
  -- ROW COUNT = 0  ->  'insufficient stock'  ->  ROLLBACK + 409
  -- 2. Qabul oshirish (upsert)
  INSERT INTO stock (location_id, product_id, qty) VALUES (:to, :pid, :qty)
    ON CONFLICT (location_id, product_id) DO UPDATE SET qty = stock.qty + :qty;
  -- 3. Ledger yozuvi
  INSERT INTO stock_movements (...) VALUES (...);
  -- 4. Audit
  INSERT INTO audit_log (...) VALUES (...);
COMMIT;
```

### 3. Manfiy ostatka — ikki qatlamli himoya
- **Birlamchi:** `UPDATE ... WHERE qty >= :qty` — yetmasa hech qanday qator o'zgarmaydi,
  `ROW COUNT = 0` ni ilova "insufficient stock" deb talqin qiladi.
- **Oxirgi himoya:** `CHECK (qty >= 0)` constraint — har qanday kod yo'li orqali manfiy
  qiymat kelsa tranzaksiya rad etiladi.
Ikkalasi birga: mantiqiy xato ham ma'lumotni buza olmaydi.

### 4. Parallellik — guard'li UPDATE atomik
`UPDATE ... WHERE qty >= :qty` PostgreSQL'da row-level lock oladi va atomik. Ikki parallel
savdo bir stock qatoriga kelganda biri ikkinchisini kutadi; ikkalasi ham `qty >= :qty`
ni alohida tekshiradi — overselling imkonsiz. `SELECT` + keyin `UPDATE` (read-modify-write)
ANTI-pattern — ishlatilmaydi.

### 5. "Tayyor" oqimi — bitta tranzaksiya, ko'p movement (invariant 5)
`production_order` `done` ga o'tkazilganda bitta tranzaksiya ichida:
- har BOM komponenti uchun `production_input` movement (xom-ashyo `stock` kamayadi, guard'li);
- ishlab chiqarilgan mahsulot uchun `production_output` movement (target sklad oshadi);
- `production_orders.status='done'`, `done_at`;
- audit.
Bironta komponent yetmasa — butun tranzaksiya `ROLLBACK`, `409 INSUFFICIENT_STOCK`.

### 6. Reason kodlari movement semantikasi uchun
`movement_reason` enum (`sale`, `production_input`, `production_output`, `transfer`,
`purchase`, `adjust`) har movement nima sababdan kelganini belgilaydi va dashboard/audit
uchun filtrlash imkonini beradi. `from`/`to` location qoidasi: `sale` — faqat `from`;
`purchase`/`production_output` — faqat `to`; `transfer` — ikkalasi.

## Muqobillar

- **`stock.qty` ni ledger'dan har safar `SUM()` bilan hisoblash:** rad etildi — dashboard
  < 1s talabi va high-load savdoda sekin; denormalizatsiyalangan `qty` + ledger ma'qul.
- **Optimistik lock (`version` ustun):** rad etildi — savdoda konflikt tez-tez bo'ladi,
  retry ko'payadi; guard'li `UPDATE` soddaroq va atomik.
- **Faqat ilova darajasida tekshirish (DB CHECK siz):** rad etildi — invariant 3
  buzilishi mumkin; DB CHECK oxirgi himoya sifatida shart.

## Oqibatlar

- (+) Invariant 1, 3, 5 DB darajasida kafolatlanadi.
- (+) Overselling parallel savdoda ham imkonsiz.
- (+) To'liq audit; `stock` ledger'dan qayta tiklanadi.
- (−) `stock.qty` denormalizatsiya — ledger bilan mos bo'lishi kod intizomiga bog'liq
  (faqat movement orqali yoziladi; Poster sync ham `adjust` movement orqali).
- Backend kodi har stock yo'lida shu pattern'ni ishlatishi shart — `code-reviewer`
  tekshiradigan asosiy nuqta.
