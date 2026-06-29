# ADIA — Poster API ishlatish qo'llanmasi

> Adia restoran tarmog'i uchun Poster POS API'sidan ma'lumot olish bo'yicha amaliy hujjat.
> Tuzilgan: 2026-05-07

---

## 1. Akkaunt ma'lumotlari

| Parametr | Qiymat |
|---|---|
| Akkaunt nomi (subdomain) | `adia` |
| Admin panel | https://adia.joinposter.com |
| Akkaunt raqami | `290845` |
| API base URL | `https://joinposter.com/api/` |
| App ID | `4884` |
| App Secret | _`.env` faylda: `POSTER_APP_SECRET` — xavfsizlik uchun hujjatdan olindi, git'ga yuklanmaydi_ |

### Authentication token

Personal Integration token shu yerda yaratiladi:
**Доступ → Интеграции → "+ Yangi token"**

Format: `<account_number>:<32-belgi-hex>`

Misol (faqat format namunasi): `290845:0000000000000000000000000000abcd`
Haqiqiy token `.env` faylda — `POSTER_TOKEN`.

> ⚠️ Token paroldek maxfiy. Git'ga, public repoga yuklamang. `.env` faylda saqlang.
> Amal qilish muddati: **2 yil**.

```bash
# .env faylda
POSTER_TOKEN=290845:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POSTER_ACCOUNT=adia
```

---

## 2. So'rov yuborish formati

Hamma so'rovlar `GET` (yozish operatsiyalari `POST`). Token har doim `token` parametri orqali uzatiladi.

```bash
curl "https://joinposter.com/api/<METHOD>?token=$POSTER_TOKEN&format=json&<params>"
```

Yoki akkaunt subdomain orqali:
```bash
curl "https://adia.joinposter.com/api/<METHOD>?token=$POSTER_TOKEN&format=json"
```

### Javob formati
                                                                                                                                                                                                           
```json
{
  "response": { ... }   // muvaffaqiyat
}
```
yoki
```json
{
  "error": { "code": 10, "message": "..." }
}
```

Asosiy xato kodlari:
- `10` — Access token ko'rsatilmagan yoki noto'g'ri
- `30` — Method Not Allowed (metod ishlatilmagan)
- `35` — Param ko'rsatilmagan
- `40` — Sintaktik xato

---

## 3. Filiallar (Spots)

Adia tarmog'ida **5 ta filial** bor:

| spot_id | Nomi | Manzil | Ombor |
|---|---|---|---|
| `1` | Кукча | Кукча дарвоза ko'chasi | Склад Кукча (id=3) |
| `2` | Рабочий | Рабочий городок | Склад Рабочий (id=4) |
| `3` | Чигатай | Farobi ko'chasi | Склад Чигатай (id=5) |
| `4` | Кукча центральный | Кукча дарвоза | Склад Центральный (id=8) |
| `7` | Доставка | Кукча дарвоза | Склад Кукча (id=3) |

```bash
# Barcha filiallarni olish
curl "https://joinposter.com/api/access.getSpots?token=$POSTER_TOKEN&format=json"
```

---

## 4. Omborlar (Storages)

Jami **25 ta ombor**:

| storage_id | Nomi |
|---|---|
| 2 | Основной склад (asosiy markaziy) |
| 3 | Склад Кукча |
| 4 | Склад Рабочий |
| 5 | Склад Чигатай |
| 8 | Склад Центральный |
| 12 | Склад Песочный |
| 15 | Склад Самсы |
| 19 | Склад Тортов |
| 20 | Производственный Цех |
| 21 | Склад Каймок |
| 25 | Склад Тартов |
| 26 | Склад Бисквит |
| 27 | Склад Декора |
| 28 | Склад Спец |
| 29 | Склад Горячих |
| 30 | Склад Тошми |
| 31 | Склад Минор |
| 32 | Склад Наполеон |
| 33 | Склад Салат |
| 34 | Склад Эклеров |
| 35 | Склад Заготовок |
| 36 | Склад Украшений |
| 37 | Склад Круассанов |
| 38 | Склад Евро |
| 39 | Склад Пирогов |

```bash
# Omborlar ro'yxati
curl "https://joinposter.com/api/storage.getStorages?token=$POSTER_TOKEN&format=json"
```

---

## 5. Asosiy API metodlar

### 5.1. Hisobotlar (Reports)

#### `dash.getAnalytics` — Asosiy sotuv hisoboti
Eng muhim metod. Daromad/foyda/cheklar/o'rtacha chek beradi.

```bash
curl "https://joinposter.com/api/dash.getAnalytics\
?token=$POSTER_TOKEN\
&format=json\
&dateFrom=20260407\
&dateTo=20260507\
&interpolate=day\
&type=waiters\
&select=revenue"
```

Parametrlar:

| Parametr | Tavsif |
|---|---|
| `dateFrom` | `YYYYMMDD` (default: dateTo - 30 kun) |
| `dateTo` | `YYYYMMDD` (default: bugun) |
| `interpolate` | `day` / `week` / `month` |
| `select` | `revenue` / `profit` / `transactions` / `visitors` / `average_receipt` / `average_time` |
| `type` | `waiters` / `workshops` / `category` / `products` / `spots` / `clients` |
| `id` | type ichidagi aniq ID (masalan, products → product_id) |
| `business_day` | `true` / `false` |

Javob (type=spots yoki kategoriyali):
```json
{
  "response": {
    "data": ["34813153.00", "36238832.20", ...],   // kunlik
    "data_hourly": [0,0,0,0,0,0,0,0, "77006834.40", ...],   // 24 ta
    "data_weekday": ["178094774.80", ...],   // 7 ta (Du-Yak)
    "counters": {
      "revenue": "1119646769.40",
      "profit": "815711458.22",
      "transactions": "8598",
      "visitors": "8598",
      "average_receipt": 130267.22,
      "average_time": "16.26"
    }
  }
}
```

#### `dash.getSpotsSales` — Filial bo'yicha sotuv
```bash
# Aniq filial uchun
curl "https://joinposter.com/api/dash.getSpotsSales\
?token=$POSTER_TOKEN&format=json\
&dateFrom=20260407&dateTo=20260507\
&spot_id=1"
```

#### `dash.getCategoriesSales` — Kategoriya bo'yicha
```bash
curl "https://joinposter.com/api/dash.getCategoriesSales\
?token=$POSTER_TOKEN&format=json\
&dateFrom=20260407&dateTo=20260507"
```

#### `dash.getProductsSales` — Mahsulot bo'yicha
```bash
curl "https://joinposter.com/api/dash.getProductsSales\
?token=$POSTER_TOKEN&format=json\
&dateFrom=20260407&dateTo=20260507\
&spot_id=1"
```

#### `dash.getWaitersSales` — Ofitsiantlar reytingi
#### `dash.getClientsSales` — TOP mijozlar
#### `dash.getPaymentsReport` — To'lov turlari (naqd/karta)

#### `dash.getTransactions` — Cheklar tarixi
```bash
curl "https://joinposter.com/api/dash.getTransactions\
?token=$POSTER_TOKEN&format=json\
&dateFrom=20260507&dateTo=20260507\
&spot_id=1\
&num=100"   # max 1000
```

#### `dash.getTransaction` — Bitta chek (mahsulotlar bilan)
```bash
curl "https://joinposter.com/api/dash.getTransaction\
?token=$POSTER_TOKEN&format=json\
&transaction_id=12345\
&include_products=true"
```

#### `dash.getTransactionProducts` — Chek ichidagi mahsulotlar
#### `dash.getTransactionsProducts` — Bir nechta chek mahsulotlari

---

### 5.2. Ombor (Storage)

#### `storage.getStorageLeftovers` — **Hozirgi qoldiqlar**
Eng muhim ombor metodi. Har bir ingredientning hozirgi miqdori va summasi.

```bash
curl "https://joinposter.com/api/storage.getStorageLeftovers\
?token=$POSTER_TOKEN&format=json\
&storage_id=3"   # Kukcha ombori
```

Javob har bir element:
```json
{
  "ingredient_id": "2402",
  "ingredient_name": "Г/П ПИРОГ С ТВОРОГОМ",
  "ingredient_left": "-22.00",          // umumiy qoldiq (barcha omborlar)
  "storage_ingredient_left": "-1.56",   // shu omborda qoldiq
  "storage_ingredient_sum": "0",        // summa (so'm)
  "storage_ingredient_sum_netto": "0",
  "prime_cost": "274005",               // tannarx
  "prime_cost_netto": "274005",
  "ingredient_unit": "kg",
  "ingredients_type": "2",              // 1=ingredient, 2=tayyor mahsulot
  "limit_value": "0",                   // minimum qoldiq (alert)
  "hidden": "0"
}
```

> 💡 **Manfiy qoldiq** (`storage_ingredient_left < 0`) — sotilgan, lekin kirim qilinmagan ingredient. Hisob-kitob xatosi belgisi.

#### `storage.getStorages` — Omborlar ro'yxati
#### `storage.getReportMoves` — Filiallar orasida o'tkazmalar
#### `storage.getMoves` / `storage.getMove` — Transferlar
#### `storage.getSupplies` / `storage.getSupply` — Yetkazib berishlar
#### `storage.getSuppliers` — Yetkazib beruvchilar
#### `storage.getIngredientWriteOff` — Списания (yo'qotish/zarar)
#### `storage.getManufactures` — Tayyorgarliklar
#### `storage.createSupply`, `createMoving`, `createWriteOff` — Yozish (POST)

```bash
# Списание (yo'qotish) yaratish
curl -X POST "https://joinposter.com/api/storage.createWriteOff?token=$POSTER_TOKEN" \
  -d "storage_id=3" \
  -d "type=1" \
  -d "date=2026-05-07 12:00:00" \
  -d "ingredients[0][id]=1234" \
  -d "ingredients[0][type]=1" \
  -d "ingredients[0][weight]=2.5"
```

---

### 5.3. Mahsulotlar (Menu)

| Metod | Tavsif |
|---|---|
| `menu.getCategories` | Mahsulot kategoriyalari |
| `menu.getCategory` | Bitta kategoriya |
| `menu.getProducts` | Barcha mahsulot/taom |
| `menu.getProduct` | Bitta mahsulot tafsiloti |
| `menu.getPrepacks` | Yarim tayyorlar |
| `menu.getIngredients` | Ingredientlar |
| `menu.getWorkshops` | Ishxonalar (oshxona/bar/vp) |
| `menu.createProduct`, `createDish`, `updateProduct` | CRUD |

```bash
# Barcha taomlar
curl "https://joinposter.com/api/menu.getProducts?token=$POSTER_TOKEN&format=json"
```

---

### 5.4. Mijozlar (Clients)

| Metod | Tavsif |
|---|---|
| `clients.getClients` | Barcha mijozlar (filtr bilan) |
| `clients.getClient` | Bitta mijoz |
| `clients.getGroups` | Mijoz guruhlari |
| `clients.createClient` / `updateClient` | CRUD |

```bash
curl "https://joinposter.com/api/clients.getClients\
?token=$POSTER_TOKEN&format=json\
&num=200&offset=0"
```

---

### 5.5. Xodimlar (Access / Employees)

| Metod | Tavsif |
|---|---|
| `access.getEmployees` | Ofitsiantlar/oshpazlar |
| `access.getEmployee` | Bitta xodim |
| `access.getRoles` | Lavozimlar |
| `access.getSpots` | Filiallar (yuqorida ishlatildi) |

---

### 5.6. Moliya (Finance)

| Metod | Tavsif |
|---|---|
| `finance.getCashshifts` | Smenalar (kassa ochish/yopish) |
| `finance.getReport` | Moliyaviy hisobot |
| `finance.getTransactions` | Moliyaviy operatsiyalar |
| `finance.getAccounts` | Hisob raqamlar |
| `finance.createTransaction` | Daromad/xarajat yozish |

---

### 5.7. Buyurtmalar (Incoming Orders — Online)

Onlayn buyurtma kassaga yuborish:

```bash
curl -X POST "https://joinposter.com/api/incomingOrders.createIncomingOrder?token=$POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "spot_id": 1,
    "phone": "+998901234567",
    "products": [
      {"product_id": 123, "count": 2, "modifications": []}
    ],
    "comment": "Дверь не звонить"
  }'
```

| Metod | Tavsif |
|---|---|
| `incomingOrders.createIncomingOrder` | Buyurtma yaratish |
| `incomingOrders.getIncomingOrders` | Olingan buyurtmalar |
| `incomingOrders.changeIncomingOrderStatus` | Statusni o'zgartirish |

---

### 5.8. Webhook'lar

Real vaqt ma'lumot olish uchun:
- `transaction.add` — yangi chek ochildi
- `transaction.update` — chek yangilandi
- `transaction.close` — chek yopildi
- `incoming_order.add` — yangi onlayn buyurtma
- `client.add` / `client.update` — mijoz
- `product.add` / `product.update` — mahsulot

Webhook URL ni Поster admin → **Настройки → Уведомления → API Webhook** ga yozing.

---

## 6. Foydali skriptlar

### 6.1. Oxirgi 30 kun jamlanma — har filial

```bash
#!/bin/bash
TOKEN="$POSTER_TOKEN"
DATE_FROM=$(date -d "30 days ago" +%Y%m%d)
DATE_TO=$(date +%Y%m%d)

declare -A SPOTS=( [1]="Кукча" [2]="Рабочий" [3]="Чигатай" [4]="Центральный" [7]="Доставка" )

printf "%-15s %15s %15s %10s %12s\n" "Filial" "Aylanma" "Foyda" "Cheklar" "O'rt.chek"
echo "------------------------------------------------------------------------"
for sid in "${!SPOTS[@]}"; do
  data=$(curl -s "https://joinposter.com/api/dash.getSpotsSales?token=$TOKEN&format=json&dateFrom=$DATE_FROM&dateTo=$DATE_TO&spot_id=$sid")
  rev=$(echo "$data" | python3 -c "import json,sys;d=json.load(sys.stdin)['response'];print(int(d['revenue']))")
  prof=$(echo "$data" | python3 -c "import json,sys;d=json.load(sys.stdin)['response'];print(int(d['profit']))")
  cl=$(echo "$data" | python3 -c "import json,sys;d=json.load(sys.stdin)['response'];print(d['clients'])")
  mi=$(echo "$data" | python3 -c "import json,sys;d=json.load(sys.stdin)['response'];print(int(d['middle_invoice']))")
  printf "%-15s %15d %15d %10s %12d\n" "${SPOTS[$sid]}" "$rev" "$prof" "$cl" "$mi"
done
```

### 6.2. Ombor qoldig'i tekshirish (manfiy = muammo)

```bash
#!/bin/bash
TOKEN="$POSTER_TOKEN"
for sid in 2 3 4 5 8; do
  echo "=== Storage $sid ==="
  curl -s "https://joinposter.com/api/storage.getStorageLeftovers?token=$TOKEN&format=json&storage_id=$sid" \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)['response']
neg = [x for x in data if float(x['storage_ingredient_left']) < 0]
print(f'Manfiy qoldiq: {len(neg)} ta')
for n in sorted(neg, key=lambda x: float(x['storage_ingredient_left']))[:10]:
    print(f\"  {n['ingredient_name'][:40]:<40} {float(n['storage_ingredient_left']):>10.2f} {n['ingredient_unit']}\")
"
done
```

### 6.3. Bugungi cheklar JSON

```bash
TODAY=$(date +%Y%m%d)
curl -s "https://joinposter.com/api/dash.getTransactions\
?token=$POSTER_TOKEN&format=json\
&dateFrom=$TODAY&dateTo=$TODAY&num=1000" > today.json
```

---

## 7. Node.js / Python kutubxonalari

### Python
```python
import os, requests
TOKEN = os.environ["POSTER_TOKEN"]
BASE = "https://joinposter.com/api"

def poster(method, **params):
    params["token"] = TOKEN
    params["format"] = "json"
    r = requests.get(f"{BASE}/{method}", params=params)
    data = r.json()
    if "error" in data:
        raise Exception(data["error"])
    return data["response"]

# Ishlatish
spots = poster("access.getSpots")
analytics = poster("dash.getAnalytics", dateFrom="20260407", dateTo="20260507")
leftovers = poster("storage.getStorageLeftovers", storage_id=3)
```

### Node.js
```javascript
const TOKEN = process.env.POSTER_TOKEN;
const BASE = "https://joinposter.com/api";

async function poster(method, params = {}) {
  const url = new URL(`${BASE}/${method}`);
  url.searchParams.set("token", TOKEN);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.response;
}

const spots = await poster("access.getSpots");
const analytics = await poster("dash.getAnalytics", {
  dateFrom: "20260407",
  dateTo: "20260507"
});
```

### PHP
Rasmiy SDK: https://github.com/joinposter/api-php
```bash
composer require poster/api
```
```php
use poster\src\PosterApi;
PosterApi::init([
  'account_name' => 'adia',
  'access_token' => getenv('POSTER_TOKEN'),
]);
$leftovers = PosterApi::storage()->getStorageLeftovers(['storage_id' => 3]);
```

---

## 8. Limitlar va eslatmalar

- **Rate limit:** Poster rasmiy hujjatda yozilmagan, lekin amaliyotda ~5 req/sec dan oshmang
- **Sana formati:** har doim `YYYYMMDD` (chizilarsiz). Bitta metodda `Y-m-d H:i:s` ham bor (transactions)
- **Pagination:** `num` (sahifa o'lchami, max 1000) va `offset` parametrlari
- **Pul birligi:** so'm minor units (tiyin) emas — to'g'ri so'm (`UZS` raqamlar haqiqiy)
- **Hujjatdagi misollardagi "hryvnias"** — Ukraina valyutasi, sizda UZS chiqadi
- **`ingredient_unit`:** `kg`, `l` (litr), `p` (dona — perfect/piece)
- **`type` ingredientda:** `1` = ingredient (xom-ashyo), `2` = tayyor mahsulot (G/P)

---

## 9. OAuth flow (boshqa restoranlar uchun)

Agar siz boshqa restoranni ulashni xohlasangiz (masalan, Adia tarmog'idan tashqari):

**1-qadam** — foydalanuvchini brauzerda quyidagi URL'ga yo'naltiring:
```
https://joinposter.com/api/auth?application_id=4884&redirect_uri=https://yoursite.uz/cb&response_type=code
```

**2-qadam** — `redirect_uri?code=XXX&account=AKKAUNT` qaytadi

**3-qadam** — code'ni access_token'ga almashtiring (POST, `multipart/form-data`):
```bash
curl -X POST "https://AKKAUNT.joinposter.com/api/v2/auth/access_token" \
  -F "application_id=4884" \
  -F "application_secret=$APP_SECRET" \
  -F "grant_type=authorization_code" \
  -F "redirect_uri=https://yoursite.uz/cb" \
  -F "code=XXX"
```

Javobda `access_token` keladi (2 yil amal qiladi).

---

## 10. Rasmiy hujjatlar

- Poster API hujjati: https://dev.joinposter.com/en/docs/v3/start/index
- Auth: https://dev.joinposter.com/en/docs/v3/start/authApi
- Sotuv hisobotlari: https://dev.joinposter.com/en/docs/v3/web/dash/index
- Ombor: https://dev.joinposter.com/en/docs/v3/web/storage/index
- Xato kodlari: https://dev.joinposter.com/en/docs/v3/web/errors
- PHP SDK: https://github.com/joinposter/api-php
- Webhook: https://dev.joinposter.com/en/docs/v3/web/webhooks

---

## 8. BOM import tekshiruvi (VAZIFA 0 — backend-engineer, 2026-05-23)

Spec §5.5 talab qilgan real API tekshiruvi: `menu.getProduct` va `menu.getPrepacks`
javobi ingredient/retsept tarkibini qaytaradimi.

**Holat: BAJARILDI — BOM import to'liq imkoni bor.** `.env` dagi `POSTER_TOKEN`
ishlaydi (`menu.getProducts` 293 mahsulot qaytaradi). Quyidagi real chaqiruvlar
o'tkazildi va javoblar tahlil qilindi.

### 8.1. `menu.getProducts` — ro'yxat (293 ta)

Ro'yxatda ingredient tarkibi **YO'Q**. Lekin har qatorda `product_id`, `ingredient_id`
(stocked product uchun), `type` (`2` = oddiy taom/mahsulot, `3` = modifikatsiyali —
masalan tarif/porsiyali), `menu_category_id`, `workshop` mavjud. Type taqsimoti:
type=2 — 209 ta, type=3 — 84 ta.

### 8.2. `menu.getProduct?product_id=X` — bitta mahsulot

**type=2 mahsulotlar — `ingredients` array QAYTARADI.** Misol: `product_id=847`
("ПЕЧЕНЬЕ ШОКОЛАДНОЕ", `ingredient_id=1434`) 8 ta ingredient qaytarib berdi.
Har element shu kalitlarni o'z ichiga oladi:

```json
{
  "structure_id": "22208",
  "ingredient_id": "1431",
  "structure_unit": "g",            // brutto miqdor birligi
  "structure_type": "1",            // 1=ingredient, 2=prepack (yarim fabrika)
  "structure_brutto": 2000,         // BOM kirim miqdori
  "structure_netto": 2000,
  "structure_lock": "0",
  "structure_selfprice": "30872434",
  "ingredient_name": "бон шоколад черный",
  "ingredient_unit": "kg"           // ingredient o'lchov birligi
}
```

Mapping qoidasi:
- ADIA `recipes.qty_per_unit` ← Poster `structure_netto` (yoki `structure_brutto`).
  `structure_unit` "g" bo'lib, `ingredient_unit` "kg" bo'lsa — `/1000` ga aylantirib
  kg ga keltirish kerak. `structure_unit==ingredient_unit` bo'lganda to'g'ridan to'g'ri.
- ADIA `recipes.component_product_id` ← `products.poster_ingredient_id` orqali yechiladi.
- Recipe parent (`recipes.product_id`) ← `products.poster_product_id` (parent menu mahsuloti).

**type=3 mahsulot — `ingredients` YO'Q.** Misol: `product_id=477` ("Adia") — type=3,
modifikatsiyalar bilan keladi (har modifikatsiyaning o'z `ingredient_id` si), lekin
to'g'ridan-to'g'ri retsept biriktirilmagan. Type=3 mahsulotlar ADIA Faza-1 da
**alohida hisobga olinmaydi** — modifikatsiya ingredient_id orqali ostatka kamayadi.
Agar PM bunday mahsulot uchun retsept kerak deb topsa — `PUT /api/products/:id/recipe`
qo'lda yo'l ishlatiladi.

### 8.3. `menu.getPrepacks` — yarim tayyorlar (1121 ta)

**HAR PREPACK ICHIDA `ingredients` array TO'LIQ QAYTADI.** Misol: prepack
`product_id=978` ("Г/П ПИРОГ С ТВОРОГОМ КВ (ЦЕЛЫЙ)", `ingredient_id=2402`) —
`out: 1000` (yield), `ingredients: [...]`. `structure_type` qiymati 1 yoki 2 —
ya'ni yarim tayyor boshqa yarim tayyordan ham yasalishi mumkin (rekursiv BOM —
ADR-0004 §"semi-finished dual flow"). `out` — bir batch yarim tovardan chiqish
miqdori (yield); `recipes.qty_per_unit` ni hisoblashda komponentlar `out` ga
nisbatan normallashtirilishi mumkin.

### 8.4. Yakuniy qaror — BOM IMPORT TO'LIQ

Spec §5.5 ning "agar mumkin bo'lsa" sharti **bajarildi**. M7 seed/sync chaqiruvi
quyidagilarni amalga oshiradi:

1. `menu.getIngredients` → `products(type='raw', poster_ingredient_id=...)` upsert.
2. `menu.getPrepacks` → `products(type='semi', poster_ingredient_id, poster_product_id)`
   upsert + har biri uchun `recipes` to'ldirish.
3. `menu.getProducts` → `products(type='finished', poster_product_id, poster_ingredient_id)`
   upsert; har type=2 mahsulot uchun `menu.getProduct?product_id=X` chaqirib BOM
   olib `recipes` ga yoziladi (rate-limit ~5 req/sec).
4. Qo'lda yo'l (`PUT /api/products/:id/recipe`) — saqlanadi (override yo'li sifatida).

> Eslatma: birlik konversiyasi (`structure_unit='g'` ↔ `ingredient_unit='kg'`) —
> import qatlamida amalga oshiriladi; ADIA ichida har doim `ingredient_unit` da
> normallashtiriladi.

