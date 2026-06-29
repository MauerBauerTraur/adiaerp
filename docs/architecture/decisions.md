# ADIA ERP — Qarorlar jurnali (Decisions Log)

Loyiha bo'yicha qabul qilingan asosiy qarorlar shu yerda yoziladi. Yangi qaror — tepaga, sana bilan.

---

## 2026-05-28 — D7. Ta'minot → Sex skladi re-modeling

Har sex (Tort, Perojniy, Yarim Fabrika) o'z `sex_storage` typedagi buferiga ega. Sex va sex skladi alohida `location_id`. Migration 0021 `location_type` enum'iga `sex_storage` qiymatini qo'shdi (`supply` dan oldin). Migration 0022 mavjud uchta supply qatorni `sex_storage` ga ko'chirdi va Yarim Fabrika sexi (production) qaytadan yaratildi:

  | id  | eski nom                  | eski type | yangi nom              | yangi type   | parent      |
  |-----|---------------------------|-----------|------------------------|--------------|-------------|
  | 3   | Ta'minot — Tort           | supply    | Tort skladi            | sex_storage  | Tort sexi   |
  | 38  | Ta'minot — Yarim Fabrika  | supply    | Yarim Fabrika skladi   | sex_storage  | Yarim F. s. |
  | 39  | Ta'minot — Perojniy       | supply    | Perojniy skladi        | sex_storage  | Perojniy s. |

D2 (Yarim Fabrika dual flow) **saqlanadi** — Yarim Fabrika sexi `production` typli alohida lokatsiya, uning skladi (sex_storage) — ham Markaziy Skladga jo'natadi, ham boshqa sexlar uchun BOM komponenti sifatida ishlaydi. D6 (har location o'z menejeri) **saqlanadi** — sex skladi o'zining `manager_user_id` ga ega bo'ladi. `supply_manager` rol **sinonim sifatida saqlanadi** (sex skladlarining menejeriga biriktiriladi). `supply` ENUM qiymati backward-compat uchun qoldi — barcha kodbazada o'tkazilgandan keyin (1-2 sprint), alohida migratsiya bilan DEPRECATE qilinadi. Tafsilot: `docs/architecture/adr-0015-sex-storage-remodeling.md`.

---

## 2026-05-22 — TZ §16 ochiq savollari hal qilindi

Loyiha egasi tomonidan tasdiqlangan qarorlar:

### D1. Xom-ashyo ombori va Markaziy Sklad — alohida fizik omborlar
Mahsulotlar Ombori (xom-ashyo) va Markaziy Sklad — **alohida fizik omborlar**. `locations` jadvalida ikki alohida yozuv (`type = raw_warehouse` va `type = central_warehouse`).

### D2. Yarim Fabrika — ikki tomonlama oqim
Yarim Fabrika **ham Markaziy Skladga, ham Ishlab chiqarishga** beradi:
- Markaziy Skladga — jo'natma (`shipment`) sifatida;
- Ishlab chiqarishga — BOM komponenti sifatida qayta kirish.
DB sxemasi va logika ikkala oqimni ham qo'llab-quvvatlashi shart.

### D3. Dinamik min/max — barcha bo'g'inlarda
Sotuvga bog'langan dinamik min/max **har bir bo'g'in (location)** uchun ishlaydi — faqat do'konlarda emas. Tungi cron har `(location_id, product_id)` juftligi uchun min/max ni qayta hisoblaydi.

### D4. Sotuv va ombor ma'lumotlari manbai — Poster POS integratsiyasi
MVP'da savdo **qo'lda kiritilmaydi**. ADIA ERP **Poster POS platformasiga integratsiya qilinadi** — dastur ham, AI assistant ham.
- Poster akkaunti: `adia` (joinposter.com). API qo'llanma: `docs/adia-poster-api.md`. Maxfiy kalitlar: `.env` (`POSTER_*`).
- Poster'da allaqachon **5 ta filial (spot)** va **25 ta ombor (storage)** bor — ADIA `locations` shularga moslanadi (mapping).
- Ostatka — `storage.getStorageLeftovers` dan; savdo/cheklar — `dash.getTransactions` va webhook'lardan (`transaction.close`) sinxronlanadi.
- ADIA ERP — Poster ustidagi **orkestratsiya / "miya" qatlami**: bo'g'inlararo replenishment, min/max engine, request state machine, ishlab chiqarish va AI dashboard. Poster — POS va ma'lumot manbai.

### D5. Ta'minot so'rovlari — ikki bosqichli tasdiq
Xom-ashyo yoki tovar yetmaganda yaratiladigan buyurtma **"Yetkazib berishga so'rov"** (supply request) sifatida boshliqqa ko'rinadi. Har bir so'rov **boshliq (manager) va skladchi (ombor menejeri) — ikkalasi tasdiqlagandan keyin** kuchga kiradi. (TZ dagi `purchase_order` shu ikki-bosqichli tasdiq oqimiga aylanadi.)

### D6. Har bo'g'inning o'z boshlig'i
Zanjirning **har bir bo'g'inida (location) o'z boshlig'i (manager)** bo'ladi — bo'g'in shu rol orqali ishlaydi. RBAC: har `location` ga kamida bitta manager-foydalanuvchi biriktiriladi; manager faqat o'z bo'g'inini boshqaradi.

---

## Ta'siri va hali aniqlanishi kerak bo'lgan nuqtalar

- **D4 (Poster)** — eng katta arxitektura ta'siri. `system-architect` aniqlashi kerak: Poster (spots / storages / ingredients / transactions) va ADIA (`locations` / `products` / `stock` / `sales`) o'rtasidagi mapping; sinxronlash strategiyasi (webhook + davriy poll); Poster `limit_value` bilan ADIA `min_level` munosabati.
- **D5** — yetkazib beruvchilar (supplier) ro'yxati MVP'da soddaroq bo'lishi mumkin; asosiy talab — ikki bosqichli tasdiq oqimi va boshliqqa ko'rinish.
- **Keyingi qadam:** `system-architect` shu qarorlar asosida Faza-1 (MVP) spec va DB sxemasini tayyorlaydi → reja egaga tasdiqlashga yuboriladi.
