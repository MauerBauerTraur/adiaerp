# ADIA ERP — Texnik Topshiriq (TZ)
PM nomidan full-stack jamoaga Versiya: 1.0 · Tayyorlandi: Rayyona (PM) uchun · Status: Draft (tasdiqlashga)


## 1. Loyiha haqida
### 1.1. Muammo
Hozir butun ishlab chiqarish–ta'minot zanjiri (xom-ashyo → ishlab chiqarish → ta'minot bo'limlari → markaziy sklad → do'konlar) qo'lda, alohida-alohida boshqariladi. Natijada:

mahsulot qachon tugayotgani aniq emas, do'konda tovar tugab qoladi yoki ortib ketadi;
har bir bo'g'inda "qancha kerak" degan qaror odamning xotirasiga bog'liq;
buyurtma (zayafka) kechikadi, ishlab chiqarish noto'g'ri rejalashtiriladi;
rahbar butun zanjirni bitta joyda ko'ra olmaydi.
### 1.2. Yechim
Bir butun avtomatlashgan ERP eko-tizimi quriladi. Har bir bo'g'inda har bir mahsulotga min/max (par level) belgilanadi. Tizim ostatkani kuzatadi, min'dan tushganda avtomatik buyurtma (replenishment) zanjirini ishga tushiradi va butun jarayonni bitta dashboardda ko'rsatadi. Eng tepada AI assistant — rahbar savol berib, holatni so'rab, buyruq bera oladi.
### 1.3. Maqsad (bitta jumlada)
Do'konda tovar minimumdan tushishi bilan tizim o'zi tekshirib, kerakli bo'g'inga buyurtma berib, ishlab chiqarishni qo'zg'atib, tovarni do'konga yetkazib beradigan — o'zini-o'zi to'g'rilaydigan tizim.


## 2. Glossariy
| Termin | Ma'nosi |
| --- | --- |
| Mahsulotlar Ombori (xom-ashyo) | Zanjir boshidagi ombor: un, shakar, krem va h.k. kiradi/chiqadi |
| Ishlab chiqarish bo'limlari | Xom-ashyodan tayyor/yarim tayyor mahsulot tayyorlovchi sexlar |
| Ta'minot bo'limi | Tayyor/yarim tayyor mahsulotni qabul qiluvchi bo'lim. Bo'limlar: Tort, Perojniy, Yarim Fabrika |
| Yarim Fabrika | Tayyor emas (hamir va boshqa yarim tovar) — keyin ishlab chiqarishda qayta ishlatiladi |
| Markaziy Sklad (Markaziy Ombor) | Tayyor mahsulotlar saqlanadigan markaziy ombor, do'konlarga shu yerdan tarqaladi |
| Do'kon | Sotuv nuqtasi |
| min / max (par level) | Har mahsulotga: min = quyi chegara (buyurtma nuqtasi), max = to'ldirish darajasi |
| Zayafka (buyurtma) | "Bugun 4 ta tort tayyorla" kabi ishlab chiqarish/ta'minot buyrug'i |
| Replenishment | Min'dan tushganda avtomatik to'ldirish jarayoni |
| Reorder Point (ROP) | Buyurtma berish kerak bo'lgan ostatka darajasi |



## 3. Rollar va ruxsatlar (RBAC)
| Rol | Nima ko'radi / qiladi |
| --- | --- |
| Super Admin / PM | Hammasi: barcha modullar, sozlamalar, hisobotlar, min/max o'zgartirish |
| Ombor menejeri (xom-ashyo) | Xom-ashyo kirim/chiqim, ostatka, min/max |
| Ishlab chiqarish | Kelgan zayafkalar, ishlab chiqarish rejasi, "tayyor" deb belgilash |
| Ta'minot menejeri | Tort/Perojniy/Yarim Fabrika ostatkasi, skladga jo'natish |
| Sklad menejeri | Markaziy sklad ostatkasi, do'konlarga jo'natma |
| Do'kon menejeri | Faqat o'z do'koni ostatkasi va savdosi |
| AI Assistant | Read + tavsiya + tasdiqlangan buyruqlarni bajarish (rol cheklovi bilan) |


Har bir foydalanuvchi faqat o'z bo'g'inini ko'radi; PM/Admin butun zanjirni ko'radi.


## 4. Tizim arxitekturasi (yuqori daraja)
┌──────────────────────────────────────────┐

│   BOSH AI DASHBOARD (assistant + monitoring) │

└───────────────┬──────────────────────────┘

│ (read/monitor/command)

─────────────────────────  TA'MINOT OQIMI (forward)  ─────────────────────────►

Xom-ashyo Ombori → Ishlab chiqarish → Ta'minot (Tort/Perojniy/Yarim Fab.) → Markaziy Sklad → Do'konlar

◄─────────────────────────  TALAB SIGNALI (reverse / auto)  ─────────────────

Do'kon min< → Sklad tekshir → Xom-ashyo tekshir → Ishlab chiqarishga buyruq → tayyorlab qaytarish

Forward (yuqori oqim): mahsulot harakati — chapdan o'ngga.
Reverse (auto tsikl): talab signali — o'ngdan chapga, tizim o'zi qo'zg'atadi.
AI qatlami: butun ma'lumotni ustidan o'qiydi, monitoring qiladi, buyruq beradi.


## 5. End-to-end jarayon (asosiy ssenariy)
Ssenariy: "Do'konda tort tugayapti"

Do'kon menejeri sotuvni kiritadi (yoki kassa/integratsiya orqali avtomatik). Tort ostatkasi min'dan tushadi.
Tizim avtomatik replenishment request yaratadi → Markaziy Skladga yuboradi.
Markaziy Sklad tekshiradi: yetarli tort bormi?
Ha → do'konga jo'natma yaratiladi (shipment). Tugadi.
Yo'q → request yuqoriga: Ta'minot / Ishlab chiqarish bo'limiga o'tadi.
Ishlab chiqarish uchun xom-ashyo yetarli ekanini tekshiradi (Mahsulotlar Ombori).
Yetarli → ishlab chiqarishga zayafka (masalan "20 ta tort tayyorla").
Yetarli emas → xom-ashyo xarid buyurtmasi (purchase order) yaratiladi.
Ishlab chiqarish tort tayyorlaydi → "tayyor" deb belgilaydi → Markaziy Skladga kiradi.
Skladdan do'konga jo'natiladi → ostatka max'gacha to'ldiriladi.
Har bir qadam AI dashboardda real-time ko'rinadi, tarix audit logga yoziladi.


## 6. Modullar (batafsil)
### 6.1. Mahsulotlar Ombori (xom-ashyo)
Xom-ashyo ro'yxati (un, shakar, krem...), o'lchov birligi (kg, dona, litr).
Kirim (qabul) va chiqim (ishlab chiqarishga berildi) operatsiyalari.
Har xom-ashyoga min, max, joriy ostatka.
Ostatka min'dan tushsa → xom-ashyo xarid buyurtmasi signali.
Acceptance: kirim/chiqim qilinganda ostatka avtomatik yangilanadi; min'dan tushganda dashboardda qizil ogohlantirish + Telegram xabar.
### 6.2. Ishlab chiqarish
Kelgan zayafkalar ro'yxati (kim, qancha, qaysi mahsulot, deadline).
Har mahsulotning retsepti (BOM — Bill of Materials): 1 tort = qancha un + krem + ... → ishlab chiqarishda xom-ashyo avtomatik chiqim bo'ladi.
Status: Yangi → Jarayonda → Tayyor.
"Tayyor" bosilganda → mahsulot Markaziy Skladga kirim bo'ladi, xom-ashyo chiqim bo'ladi.
Acceptance: "Tayyor" bosilsa BOM bo'yicha xom-ashyo ostatkasi kamayadi, sklad ostatkasi oshadi (transaksiya atomar bo'lsin).
### 6.3. Ta'minot bo'limi (Tort / Perojniy / Yarim Fabrika)
Har bo'limning o'z ostatkasi va min/max'i.
Yarim Fabrika alohida oqimga ega: u tayyor mahsulot emas → ishlab chiqarishga qayta kirish sifatida ham ishlatilishi mumkin (BOM komponenti). (Ochiq savol — 16-bo'lim.)
Bo'limdan Markaziy Skladga jo'natma.
Acceptance: bo'lim → sklad jo'natmasi ikkala ostatkani to'g'ri o'zgartiradi.
### 6.4. Markaziy Sklad
Tayyor mahsulotlar ostatkasi, har biriga min/max.
Do'konlardan kelgan replenishment requestlarni qabul qiladi, yetsa jo'natadi, yetmasa yuqoriga uzatadi.
Acceptance: do'kon requesti kelganda yetarlilik avtomatik tekshiriladi va to'g'ri yo'naltiriladi.
### 6.5. Do'konlar
Har do'kon — alohida lokatsiya, o'z ostatkasi va min/max'i.
Savdo kiritiladi (qo'lda yoki integratsiya: kassa/AmoCRM/POS — keyingi faza).
Ostatka min'dan tushsa → replenishment request avtomatik.
Acceptance: savdo kiritilganda ostatka kamayadi; min'da request avtomatik yaratiladi (qayta-qayta dublikat yaratmasin — debounce).
### 6.6. Min/Max & Avtomatik buyurtma dvigateli (eng muhim modul)
Markazlashgan replenishment engine — barcha bo'g'inlar uchun bir xil logika.
Har N daqiqada (yoki har operatsiyada) ostatkalarni tekshiradi, min'dan past bo'lganlarga request yaratadi.
Requestlar state machine orqali yuradi (8-bo'limga qarang).
Acceptance: sun'iy ravishda ostatkani min'dan pasaytirsak — to'liq tsikl avtomatik ishga tushadi.
### 6.7. Savdoga bog'langan dinamik min/max
min/max qotib qolmaydi — kunlik sotuvga qarab avtomatik o'zgaradi.
Formula (8.3-bo'lim) kunlik o'rtacha sotuvni hisoblab min/max'ni yangilab boradi.
Acceptance: sotuv oshgan do'konda min/max ertasiga yuqoriga ko'tariladi (va aksincha).
### 6.8. AI Dashboard / Assistant
Butun zanjir real-time: qaysi bo'g'inda nima qizil holatda, qaysi requestlar ochiq, bugungi ishlab chiqarish rejasi.
Chat assistant: "Bugun qaysi do'konda nima tugayapti?", "Tort bo'yicha hozir nechta ochiq zayafka bor?", "Filial-2 ga 10 ta tort jo'nat" kabi savol/buyruqlar.
AI ma'lumotni o'qiydi (tool/function calling orqali DB'ga so'rov), tavsiya beradi, tasdiqlangan buyruqni bajaradi (rol cheklovi bilan).
Acceptance: assistant joriy ostatka/requestlar bo'yicha aniq javob beradi; xavfli buyruqni tasdiqsiz bajarmaydi.
### 6.9. Bildirishnomalar (Telegram)
Min'dan tushish, yangi zayafka, "tayyor", jo'natma — har biri tegishli rolga Telegram orqali xabar.
Grammy bot orqali; bitta xabarga "Tasdiqlash / Rad etish" inline tugmalari (keyingi faza).


## 7. Ma'lumotlar modeli (DB schema — yuqori daraja)
| Jadval | Asosiy maydonlar |
| --- | --- |
| locations | id, name, type (raw_warehouse/production/supply/central_warehouse/store), parent_id |
| products | id, name, type (raw/semi/finished), unit, sku |
| recipes (BOM) | id, product_id, component_product_id, qty_per_unit |
| stock | id, location_id, product_id, qty, min_level, max_level, updated_at |
| stock_movements | id, product_id, from_location_id, to_location_id, qty, reason (sale/production/transfer/purchase/adjust), created_by, created_at |
| replenishment_requests | id, product_id, requester_location_id, target_location_id, qty_needed, status, created_at |
| production_orders (zayafka) | id, product_id, qty, deadline, status, location_id, created_at |
| purchase_orders | id, product_id, qty, supplier, status, created_at |
| sales | id, store_id, product_id, qty, price, sold_at |
| sales_stats_daily | location_id, product_id, date, qty_sold, avg_7d, avg_30d |
| users | id, name, role, location_id, telegram_id |
| audit_log | id, actor, action, entity, entity_id, payload(jsonb), created_at |


Eslatma: min/max har bir (location_id, product_id) juftligida bo'ladi — chunki bitta mahsulotning chegarasi har do'konda har xil.


## 8. Biznes qoidalari va algoritmlar
### 8.1. Replenishment trigger
EACH stock row:

IF qty <= min_level AND no_open_request(product, location):

create replenishment_request(qty_needed = max_level - qty)
### 8.2. Request state machine
NEW

→ CHECK_STORE_SUPPLIER (Markaziy Sklad)

• enough?  → SHIP_TO_REQUESTER → CLOSED

• not enough → CHECK_PRODUCTION_INPUT

→ CHECK_PRODUCTION_INPUT (xom-ashyo bormi?)

• enough → CREATE_PRODUCTION_ORDER (zayafka)

• not enough → CREATE_PURCHASE_ORDER (xom-ashyo) → (kelgach) → CREATE_PRODUCTION_ORDER

→ PRODUCING → DONE_TO_WAREHOUSE → SHIP_TO_REQUESTER → CLOSED
### 8.3. Dinamik min/max formulasi (sotuvga bog'liq)
avg_daily   = 7 yoki 30 kunlik o'rtacha sotuv

lead_time   = tovar yetib kelish kuni (bo'g'inga qarab)

safety      = xavfsizlik koeffitsiyenti (masalan 1.3)

review_days = qayta to'ldirish davri (masalan 2 kun)

min_level (ROP) = avg_daily * lead_time * safety

max_level       = min_level + (avg_daily * review_days)

order_qty       = max_level - current_qty

Bu hisob har kechasi (cron) qayta hisoblanadi → min/max savdo o'sishiga qarab o'zi siljiydi.
### 8.4. Muhim invariantlar
Har stock_movement — atomar transaksiya (manba kamayadi, qabul oshadi, log yoziladi).
Bitta product+location uchun bir vaqtda bitta ochiq request (dublikatga yo'l yo'q).
Ostatka hech qachon manfiy bo'lmaydi (DB constraint + tekshiruv).


## 9. API (asosiy endpointlar — namuna)
| Metod | Endpoint | Vazifa |
| --- | --- | --- |
| GET | /api/stock?location_id= | Bo'g'in ostatkasi |
| POST | /api/stock/movement | Kirim/chiqim/transfer |
| POST | /api/sales | Savdo kiritish (do'kon) |
| GET | /api/replenishment?status= | Ochiq requestlar |
| POST | /api/replenishment/:id/advance | State machine'ni keyingi bosqichga |
| POST | /api/production-orders | Zayafka yaratish |
| PATCH | /api/production-orders/:id | Status: tayyor |
| GET | /api/dashboard/overview | Butun zanjir holati (AI/dashboard) |
| POST | /api/assistant/query | AI assistant savol/buyruq |


Auth: JWT + rol; har endpoint rol bo'yicha cheklanadi.


## 10. Tavsiya etilgan texnik stek
| Qatlam | Texnologiya |
| --- | --- |
| Frontend | React + Vite + TypeScript, UI: shadcn/ui + Tailwind (dark premium aesthetic) |
| Charts | Recharts (sotuv/ostatka grafiklari) |
| Backend | Node.js + Express (yoki Fastify) |
| DB | PostgreSQL + raw SQL (yoki yengil query layer) |
| Auth | JWT + RBAC middleware |
| Background jobs | cron (replenishment skan, min/max qayta hisob) — node-cron yoki BullMQ |
| Bot/Notif | Grammy (Telegram), inline tugmalar |
| AI | Claude (Sonnet) — function/tool calling DB ustiga (read + tasdiqlangan command) |
| Deploy | Hetzner VPS · PM2 · Nginx (mavjud infratuzilmaga mos) |


Stek qasddan jamoangiz allaqachon ishlatadigan texnologiyalarga moslandi — yangi narsa o'rganishga vaqt ketmaydi.


## 11. Avtomatik tsikl — pseudocode (replenishment worker)
// har 5 daqiqada ishlaydigan worker

for (const row of belowMinStock()) {

if (hasOpenRequest(row.product_id, row.location_id)) continue;

const req = createRequest({

product_id: row.product_id,

requester: row.location_id,

qty: row.max_level - row.qty,

status: 'NEW',

});

await advance(req); // state machine: sklad → xom-ashyo → ishlab chiqarish → ...

notifyTelegram(req); // tegishli rolga xabar

audit('replenishment_started', req);

}


## 12. AI assistant — texnik detallar
Tool/function calling: get_stock, get_open_requests, get_production_plan, create_transfer, create_production_order — har biri rol cheklovi bilan.
AI faqat read so'rovlarni erkin bajaradi; write (jo'natma/zayafka) buyruqlarini foydalanuvchi tasdiqlasa bajaradi.
Javoblar joriy DB holatiga asoslanadi (gallyutsinatsiya bo'lmasin — har raqam tooldan keladi).
System prompt: tizim qoidalari + foydalanuvchi roli + ruxsat etilgan amallar.


## 13. Non-functional talablar
Audit: har o'zgarish kim/qachon/nima — audit_log'da.
Ruxsatlar: RBAC qattiq; do'kon faqat o'zini ko'radi.
Ishonchlilik: ostatka operatsiyalari transaksion; high-load do'kon savdosida ham to'g'ri.
Tezlik: dashboard overview < 1s; replenishment skan fon rejimda.
Til: UI o'zbek tilida; raqam/sana mahalliy format.


## 14. Bosqichlar (Roadmap)
MVP (Faza 1):

locations, products, stock, movements
qo'lda kirim/chiqim/savdo
min/max + avtomatik replenishment request + state machine
oddiy dashboard + Telegram xabar

Faza 2:

BOM/retsept + ishlab chiqarish moduli (xom-ashyo avtomatik chiqim)
dinamik min/max (sotuvga bog'liq)
AI assistant (read + savol-javob)

Faza 3:

AI write-buyruqlar (tasdiq bilan), Telegram inline tugmalar
POS/kassa/AmoCRM integratsiya (savdo avtomatik)
chuqur analitika, bashorat (forecasting)


## 15. Acceptance criteria (umumiy)
Ostatkani min'dan pasaytirsak — to'liq tsikl avtomatik ishlaydi va do'kon max'gacha to'ladi.
"Tayyor" bosilganda xom-ashyo BOM bo'yicha kamayadi, sklad oshadi (atomar).
Sotuv o'sgan do'konda min/max ertasiga avtomatik ko'tariladi.
PM dashboardda butun zanjirni real-time ko'radi; har rol faqat o'zini.
AI assistant joriy holat bo'yicha aniq javob beradi, write buyruqni tasdiqsiz bajarmaydi.


## 16. Ochiq savollar / tasdiqlanishi kerak bo'lgan qarorlar
Mahsulotlar Ombori va Markaziy Sklad — alohida fizik joymi? (TZ shunday faraz qildi.)
Yarim Fabrika skladga ham boradimi yoki faqat ishlab chiqarishga qayta kiradimi (BOM komponenti)?
Dinamik min/max faqat do'kon darajasidami yoki barcha bo'g'inlardami?
Savdo manbai: MVP'da qo'lda kiritish yetadimi yoki birinchidan POS/AmoCRM integratsiyasi kerakmi?
Xom-ashyo yetmaganda purchase order kimga ketadi (yetkazib beruvchi ro'yxati kerakmi)?



Ushbu hujjat MVP rejalashtirish uchun asos. 16-bo'limdagi savollar tasdiqlangach, har modulga alohida batafsil spetsifikatsiya va DB migratsiya yoziladi.

