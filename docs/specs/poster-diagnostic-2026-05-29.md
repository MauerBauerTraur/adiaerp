# Poster integratsiya diagnostikasi — 2026-05-29

> Muallif: backend-engineer (Wave-1, EPIC 0 + EPIC 0+ blocker).
> Usul: `apps/backend/scripts/poster-diagnostic.ts` — FAQAT read-only GET
> (`storage.getStorages`, `access.getSpots`, `dash.getPaymentsReport`,
> `dash.getAnalytics`) + lokal DB cross-check. Poster'ga hech narsa yozilmadi.
> Token hech qayerda chop etilmaydi (URL'da `token=<redacted>`).

---

## (a) Haqiqiy ombor ro'yxati (LIVE `storage.getStorages`, 25 ta)

Bu MAPPING uchun yagona ishonchli manba (doc §4 2026-05-07 ro'yxati bilan
mos keldi — eskirmagan ekan).

| Poster id | Poster nomi |
|-----------|-------------|
| 2 | Основной склад |
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

Spotlar (`access.getSpots`, 5 ta): 1=Кукча, 2=Рабочий, 3=Чигатай,
4=**Кукча центральный** (doc'da "Центральный" deb yozilgan edi — live nomi
"Кукча центральный"), 7=Доставка.

> Izoh: egasi ro'yxatidagi "Склад Полуфабрикаты" va "Склад торт загатовка"
> live ro'yxatda YO'Q. Poster'da faqat `35 Склад Заготовок` va
> `36 Склад Украшений` bor. Mapping shularga tayanishi kerak (architect/2.2).

---

## (b) To'lov birligi xulosasi — DALIL bilan

**Xulosa: Poster endpoint'lari TURLI birlik ishlatadi.**

| Endpoint | Birlik | Dalil (2026-05-29, bitta kun) |
|----------|--------|-------------------------------|
| `dash.getAnalytics` (`data`, `counters.revenue`) | **so'm** (to'g'ri) | kunlik revenue = `19553300.0000` |
| `dash.getPaymentsReport` (`total.payed_*_sum`) | **TIYIN** (×100) | `payed_sum_sum = 1955330000` |

`1955330000 / 19553300 = 100` (aniq). 05-28 da ham tasdiqlandi:
`6666172000 / 66661720 = 100`.

**Demak:**
- `getPaymentsReport` summalari so'mga aylantirilishi uchun **÷100** qilinishi
  shart. Eski `client.ts` izohi ("tiyin ÷100") `getPaymentsReport` uchun
  TO'G'RI edi.
- doc §8 q.505 "to'g'ri so'm, tiyin emas" — bu `getAnalytics`/`getTransactions`
  ga taalluqli, `getPaymentsReport` ga emas. Ziddiyat aslida ikki xil
  endpoint haqida edi.

### Nega breakdown 0%/0 ko'rsatardi
`GET /api/dashboard/revenue-breakdown` **demo rejimda** edi: Poster'ni
umuman chaqirmasdan, lokal `sales` jadvalidan qat'iy 40/35/15/10 nisbat
sintez qilardi. So'ralgan kunda lokal `sales` bo'sh bo'lsa → `grand=0` →
hamma bucket 0%/0. Headline (11M) esa boshqa (buzilgan) lokal agregatdan
kelardi. Endi route real `getPaymentsReport`ni chaqiradi va ÷100 qiladi.

---

## (c) Chart / summa root-cause

Dashboard headline va 30-kunlik chart **lokal `sales` jadvalidan**
hisoblanardi. Lokal `sales` ma'lumoti buzilgan:

- 2026-05-28: 382 qator, bittasining `price` = **43 200 000**, kun jami =
  **120 mlrd** (image10 spike, image11 11M headline shu yerdan).
- `price` taqsimoti: 219 qator `price ≥ 2 000 000` (max 46 000 000) — bu
  realsiz; tiyin-masshtabli (×100) yoki dublikat/garbage backfill.
- Real Poster (`getAnalytics`) esa toza ~20–58 mln so'm/kun ko'rsatadi.

**Root-cause:** chart/summa noto'g'ri MANBADAN (buzilgan lokal `sales`
agregati) keladi. Tarixiy backfill ham noto'g'ri birlik/dublikat bilan
kirgan. Yechim: revenue chart va headline'ni **Poster `dash.getAnalytics`**
(yagona to'g'ri so'm manba) dan olish.

Shu Wave'da qo'shildi: `client.getAnalytics()` typed wrapper +
`analyticsToDailySom()` helper (dated kunlik so'm seriyasi). Bu chart manbasini
ko'chirish va tarixiy backfillni Poster'dan to'g'ri qayta yuklash uchun
poydevor. (Chart route'ni almashtirish — keyingi kichik qadam; helper +
wrapper test bilan tayyor.)

---

## (d) Webhook holati

`poster_webhook_events`: **atigi 1 qator** (`changed`, 2026-05-23, hali
`processed=false`). Ya'ni `transaction.close` webhook **amalda kelmayapti**.

`poster_sync_log` (oxirgi 10): har daqiqada `transactions/webhook ok in=0`
(ya'ni qayta ishlanadigan event yo'q) + `transactions/poll failed in=0`
(poll xato beryapti — ehtimol shu sandboxning IPv6 routing muammosi yoki
sana format mo'rtligi, P6).

**Tavsiya (P7):** Poster admin → Настройки → Уведомления → API Webhook'ga
`/api/integrations/poster/webhook/<secret>` URL yozilishi va
`transaction.close` yoqilishi tasdiqlanishi kerak. Hozircha sotuv faqat poll
orqali keladi (ishonchsiz).

---

## (e) Qilingan tuzatishlar

| EPIC | O'zgarish | Fayl |
|------|-----------|------|
| 0.3 | Revenue-breakdown demo rejimdan **real Poster** `getPaymentsReport`ga ko'chirildi; tiyin→so'm ÷100; bucketlar jami = total | `src/routes/dashboard.ts` |
| 0.3 | Yangi `posterMoney.ts`: `tiyinToSom`, `paymentReportToBuckets` (real `{days,total}` + legacy row-array, ewallet/cert→`other`, reconcile) | `src/integrations/poster/posterMoney.ts` |
| 0.1/0.2 | `client.getAnalytics()` typed wrapper (P4) — yagona to'g'ri so'm revenue manbasi | `src/integrations/poster/client.ts` |
| 0.2 | `analyticsToDailySom()` — chart backfill uchun dated kunlik so'm seriyasi | `src/integrations/poster/posterMoney.ts` |
| diag | One-off read-only diagnostika skripti (token redaction; IPv4-forcing faqat shu skriptda, dev sandbox uchun) | `apps/backend/scripts/poster-diagnostic.ts` |

### Testlar
- `test/posterMoney.test.ts` — 8 test (tiyin→so'm, reconcile, legacy shape,
  analytics seriyasi).
- `test/posterClient.test.ts` — `getAnalytics` unwrap + param testi (jami 11).
- `test/routes.dashboard.revenue-breakdown.test.ts` — real Poster yo'liga
  yangilandi (5 test).
- `npm test -w @adia/backend`: **71 fayl / 639 test — hammasi PASS.**
- `tsc --noEmit`: toza.

### Hali ochiq (bu Wave'dan tashqari, keyingi qadam)
- **P1/0.6/2.2 — sklad mapping:** `seedSync.upsertStorage` hamon hammasini
  `central_warehouse` qiladi (default). Yuqoridagi 25-ombor ro'yxati mapping
  migratsiyasi uchun manba — `system-architect` ADR + migration.
- **0.1/0.2 — chart/headline manbasini ko'chirish:** `getAnalytics` wrapper
  tayyor; `ecosystem.sales_chart` va `poster_status.sales_today_sum`'ni
  lokal `sales`dan Poster analytics'ga ulash + buzilgan tarixiy `sales`
  qatorlarini tozalash/qayta-backfill (alohida kichik task).
- **P7 — webhook:** Poster admin'da `transaction.close` URL'ini tasdiqlash.
