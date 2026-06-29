# ADR-0016 — Ishlab chiqarish: zagatovka → ukrasheniye oqimi va AI-driven dialog

> Holat: **Taklif** (egasi tasdig'ini kutmoqda)
> Sana: 2026-05-29
> Muallif: system-architect
> Faza: 4 (post-MVP, eng katta domen bo'lagi) — EPIC 5
> Bog'liqlik: D2 (Yarim Fabrika dual flow), D6 (har location o'z boshlig'i),
> ADR-0001 (replenishment state machine), ADR-0004 (semi dual flow),
> ADR-0007 (dynamic min/max), ADR-0015 (sex_storage remodeling),
> migration 0021/0022/0025/0026.
> Manba: `docs/specs/changes-2026-05-owner-feedback.md` §EPIC 5; egasi feedback'i
> (2026-05-29) — zagatovka 70% tort, ukrasheniye, AI dialog web+telegram.

---

## 1. Kontekst

Egasi ishlab chiqarish oqimini operatsion haqiqat darajasida aniqlashtirdi.
Joriy model (ADR-0001 + ADR-0015) ishlab chiqarishni **bitta atomar qadam** deb
qaraydi: `production_order` "tayyor" bo'lganda BOM butunligicha iste'mol qilinib,
tayyor mahsulot bir zumda markaziy skladga tushadi (`consumeBomAndProduce`).

Lekin tort sexining haqiqiy oqimi **ikki bosqichli**:

1. **Zagatovka (zagotovka) bosqichi** — tort 70% tayyor: hamir/biskvit pishirilgan,
   sovutilgan, sex skladida (`sex_storage`) turadi. Bu bosqich oldindan, buyurtmadan
   mustaqil bajariladi va sex skladida **min/max bilan** doimo zaxirada saqlanadi
   (buyurtmani tez bajarish uchun).
2. **Ukrasheniye (bezash) bosqichi** — buyurtma tushganda ishlab chiqarish zagatovkani
   sex skladidan oladi, ustiga krem + bezak qo'yib **yakunlaydi**, va markaziy skladga
   jo'natadi.

Bu ikki bosqich ikki xil retsept-qismiga (BOM section) ajraladi:
- **hamir/asos qismi** (un, biskvit, shakar...) — zagatovka tayyorlash uchun;
- **ukrasheniye qismi** (krem, bezak, dekor) — yakuniy bezash uchun.

Egasi bergan asosiy stsenariy (so'zma-so'z):
> "10ta tortga buyurtma. 20 zagatovka bor — tayyordan olasanmi yoki 0dan qilasanmi?"
> - **"0dan"** → hamir retsepti bo'yicha xom-ashyo so'rovnomasi (un, biskvit...) mahsulot omboriga.
> - zagatovka tayyor bo'lgach → ukrasheniye bosqichi.
> - kremlarni tekshir: 0 yoki yangi tayyorlash kerak bo'lsa → ukrasheniye materiallari uchun mahsulot omboriga so'rov.

Bu yerda ikkita yangi talab bor:
1. **Conditional BOM expansion** — agar sex skladida zagatovka yetarli bo'lsa, hamir
   retsepti **o'tkazib yuboriladi** (faqat ukrasheniye materiallari so'raladi).
2. **AI-driven dialog** — bu qaror (tayyordan olish yoki 0dan qilish) avtomatik emas;
   AI sex foydalanuvchisidan **so'raydi**, javobga qarab so'rovnoma shakllanadi. Dialog
   **web UI'da ham, Telegram bot'da ham** ishlashi shart (egasi qarori Q5).

Somsa sexi misoli (egasidan) shuni tasdiqlaydi: tayyor hamir + qiyma sex skladidan
olinib pechda pishiriladi — ya'ni "asos" (hamir) allaqachon zagatovka sifatida tayyor,
faqat yig'ish/pishirish qoladi.

**Joriy kod nima qiladi va nega yetarli emas:**
- `recipes` jadvali **bitta tekis BOM** — section (hamir/krem/bezak) tushunchasi yo'q.
  EPIC 1.5 ham BOM'ni section'larga ajratib ko'rsatishni talab qiladi.
- `consumeBomAndProduce` butun BOM'ni `production` location'dan iste'mol qiladi —
  zagatovka bosqichini hisobga olmaydi.
- ADR-0015 §4 R1 aniq aytadi: sex skladi state machine'dan **tashqarida**; manager qo'lda
  transfer qiladi. ADR-0015 oxirida bu kelajak ADR'ga (aynan shu fayl) qoldirilgan.
- recent commit `fa851ba` `advanceCheckProductionInput`ga "sex_storage check-first"
  qo'shgan — har BOM komponenti uchun avval sex skladidan, keyin raw'dan oladi. Bu
  **komponent darajasida** to'g'ri, lekin **zagatovka = yarim tayyor mahsulot** (alohida
  `semi` product) darajasidagi qarorni va AI dialogni qoplamaydi.

Demak kerak: (a) BOM'ni section'larga ajratish, (b) zagatovka'ni alohida `semi` mahsulot
sifatida modellash, (c) ikki bosqichli ishlab chiqarish state machine, (d) AI dialog
kontrakt (web+telegram), (e) sex skladi min/max replenishment.

---

## 2. Domen modeli — entity, holat, o'tishlar

### 2.1 Asosiy tushunchalar va ularning kod ekvivalenti

| Domen atamasi | Kod ekvivalenti | Izoh |
|---|---|---|
| Zagatovka (70% tort) | `products.type = 'semi'` mahsulot | Sex skladida `stock` qatori bilan yashaydi; o'z min/max |
| Tayyor tort | `products.type = 'finished'` mahsulot | Ukrasheniye'dan keyingi yakuniy mahsulot |
| Hamir/asos retsepti | zagatovka mahsulotning `recipes` qatorlari (`stage='base'`) | un, biskvit, shakar → zagatovka |
| Ukrasheniye retsepti | tayyor mahsulotning `recipes` qatorlari (`stage='decoration'`) | krem, bezak → tayyor tort |
| "0dan qilish" | zagatovka uchun production sub-order yaratish | hamir BOM iste'mol qilinadi |
| "Tayyordan olish" | sex skladidagi zagatovka'ni ukrasheniye'ga o'tkazish | hamir BOM o'tkazib yuboriladi |

**Asosiy modellash qarori:** zagatovka — alohida `semi` mahsulot, tayyor tort — alohida
`finished` mahsulot. Ular o'rtasidagi bog'lanish `recipes` orqali: tayyor tortning BOM'ida
zagatovka **komponent** sifatida turadi (ADR-0004 §2 ruxsat beradi — `semi` ham
`product_id`, ham `component_product_id` bo'la oladi).

```
finished tort  --recipes(stage='decoration')-->  [zagatovka(semi), krem, bezak]
zagatovka semi --recipes(stage='base')-------->  [un, biskvit, shakar]
```

Bu mavjud `recipes` sxemasiga **bitta yangi ustun** (`stage`) qo'shish bilan ifodalanadi —
yangi jadval kerak emas (ADR-0004 §1 falsafasiga sodiq).

### 2.2 Recipe stage (BOM section) — yangi `recipes.stage` ustuni

```sql
ALTER TABLE recipes ADD COLUMN stage recipe_stage NOT NULL DEFAULT 'base';
-- CREATE TYPE recipe_stage AS ENUM ('base','decoration','assembly');
```

- `base` — hamir/asos (zagatovka tayyorlash); somsa misolida hamir.
- `decoration` — ukrasheniye (krem + bezak); yakuniy bezash.
- `assembly` — yig'ish/pishirish (somsa: pechda pishirish, qiyma qo'shish). Ixtiyoriy,
  agar sex section'lar uchburchak bo'lsa. MVP'da `base` + `decoration` yetarli.

**Default `base`** — barcha mavjud retseptlar (Poster'dan sinxlangan tekis BOM)
buzilmasdan ishlaydi; ular bitta-bosqichli mahsulotlar deb qaraladi (`stage` butunlay
`base` bo'lsa, eski oqim aynan ishlaydi). EPIC 1.5 (BOM section UI) shu ustundan oziqlanadi.

### 2.3 Production order — ikki bosqichni qanday ifodalaymiz

Ikki variant ko'rib chiqildi:

**Variant A (tanlangan) — bitta finished `production_order`, lekin ikki fazali done flow + ixtiyoriy zagatovka sub-order.**

- Tayyor tort uchun `production_order` (`product_id = finished`) yaratiladi.
- Uning BOM'i `recipes WHERE stage='decoration'` — zagatovka + krem + bezak.
- "Tayyor" oqimida (`consumeBomAndProduce`):
  - **zagatovka komponentini** (semi) sex skladidan oladi (sex_storage check-first,
    `fa851ba` mantiqi `semi` darajasida ham ishlaydi);
  - krem/bezakni sex skladidan yoki raw'dan oladi;
  - tayyor tortni markaziy skladga chiqaradi.
- Agar **zagatovka sex skladida yetmasa** → uni avval ishlab chiqarish kerak. Bu
  **alohida zagatovka `production_order`** (`product_id = semi`, BOM = `stage='base'`),
  uning target'i — **sex skladi** (markaziy sklad emas).

**Variant B (rad etilgan) — `production_order`ga `stage` ustuni qo'shib, har bosqich alohida order.**
- Murakkabroq: state machine har order'ni alohida boshqarishi kerak, ikkala order
  o'rtasida bog'lanish (`parent_production_order_id`) talab qiladi.
- Variant A allaqachon `replenishment_id` orqali bog'lanishni beradi va zagatovka
  sub-order'ni faqat **kerak bo'lganda** yaratadi (conditional) — bu egasi stsenariysiga
  ("20 zagatovka bor — olasanmi?") to'g'ridan-to'g'ri mos keladi.

**Tanlov: Variant A.** Lekin zagatovka sub-order'ni bog'lash uchun bitta yengil ustun
qo'shamiz:

```sql
ALTER TABLE production_orders
  ADD COLUMN parent_production_order_id BIGINT REFERENCES production_orders(id) ON DELETE SET NULL,
  ADD COLUMN stage_role TEXT NOT NULL DEFAULT 'final'
    CHECK (stage_role IN ('final','zagatovka'));
```

- `stage_role='final'` — tayyor tort order'i (decoration BOM, target=central).
- `stage_role='zagatovka'` — zagatovka order'i (base BOM, target=sex_storage),
  `parent_production_order_id` final order'ga ishora qiladi.

### 2.4 Production order state machine — ikki bosqichli (kengaytirilgan)

`production_order_status` enum o'zgarmaydi (`new → in_progress → done` + `cancelled`).
Yangilik — **zagatovka gating**: final order `done` bo'lishidan oldin zagatovka mavjud
bo'lishi (sex skladida yetarli yoki zagatovka sub-order `done`) shart.

```
                       ┌─────────────────── AI DIALOG (kerak bo'lsa) ───────────────────┐
                       ▼                                                                │
  REPLENISHMENT      NEW (final PO yaratildi, stage_role='final')                       │
  (CREATE_PRODUCTION   │                                                                │
   _ORDER state)       │ guard: zagatovka (semi) sex skladida yetarlimi?                │
                       │                                                                │
            ┌──────────┴───────────┐                                                    │
            │ HA (>= kerak)         │ YO'Q (kam)                                         │
            ▼                       ▼                                                    │
   final.in_progress      zagatovka sub-PO yaratiladi (stage_role='zagatovka',          │
   (ukrasheniye boshlandi) target=sex_storage, BOM=stage='base')                        │
            │                       │                                                    │
            │             ┌─────────┴──────────┐                                        │
            │             │ base BOM raw yetarli│ base BOM raw KAM                       │
            │             ▼                    ▼                                         │
            │     zagatovka.in_progress   PURCHASE so'rovnoma (raw warehouse)───────────┘
            │             │                    │ (kelgach qaytadan)
            │     zagatovka.done                ▼
            │     (semi → sex_storage)    [base raw kelganda → zagatovka.in_progress]
            │             │
            │             └──► sex skladida zagatovka qty oshdi ──┐
            ▼                                                     ▼
   ── ukrasheniye fazasi: krem/bezak tekshiruvi ──        final order endi davom etadi
            │
            │ guard: krem/bezak (decoration komponentlari) yetarlimi?
            │
   ┌────────┴─────────┐
   │ HA                │ YO'Q (krem 0 / kam)
   ▼                   ▼
 final.done    PURCHASE/PRODUCE so'rovnoma (ukrasheniye materiallari → raw warehouse)
 (consumeBom:        │ (kelgach qaytadan)
  semi sex'dan,      ▼
  krem/bezak,  [materiallar kelganda → final.done]
  → central)
```

**Holat o'tishlar jadvali (production_order, kengaytirilgan guard'lar bilan):**

| from | to | guard | action |
|---|---|---|---|
| `new` (final) | `in_progress` | zagatovka (semi) sex_storage'da `>= qty` | — |
| `new` (final) | (kutadi) | zagatovka kam | zagatovka sub-PO yaratiladi |
| `new` (zagatovka) | `in_progress` | base BOM raw yetarli | base BOM raw→production transfer |
| `new` (zagatovka) | (kutadi) | base raw kam | purchase order (raw) |
| `in_progress` (zagatovka) | `done` | — | base BOM consume; semi → sex_storage (production_output) |
| `in_progress` (final) | `done` | decoration komponentlari yetarli | decoration BOM consume (semi sex'dan + krem/bezak); finished → central |
| `in_progress` (final) | (kutadi) | krem/bezak kam | purchase/produce so'rovnoma (ukrasheniye material) |
| `new`/`in_progress` | `cancelled` | — | ADR-0001 §11 qoidalari |

**Atomarlik (invariant 1, 5):** har `done` o'tishi bitta `withTransaction` ichida —
BOM consume + output + audit. Zagatovka sub-PO `done` bo'lganda semi sex skladiga tushadi
(`production_output`, target=sex_storage). Final PO `done` bo'lganda semi sex skladidan
consume bo'ladi (`production_input`), finished central'ga chiqadi.

### 2.5 Replenishment state machine bilan integratsiya

ADR-0001 state machine asosan **o'zgarishsiz** qoladi. `CREATE_PRODUCTION_ORDER` holati
allaqachon final `production_order` yaratadi. Yangi zagatovka gating final order'ning
**done flow'i ichida** kechadi — replenishment uchun bu shaffof: replenishment faqat final
order `done` bo'lishini kutadi (`PRODUCING → DONE_TO_WAREHOUSE`, ADR-0001 §SM-4).

**Bitta aniqlik kerak (R3, §6):** hozir `advanceCheckProductionInput` BOM'ni
`recipes WHERE product_id=$1` bilan **butunligicha** o'qiydi. Zagatovka modeli bilan u
faqat `stage='decoration'` BOM'ni o'qishi kerak (final tort uchun) — aks holda hamir
komponentlarini ham raw'dan transfer qilib, ikki marta hisoblaydi. Bu kichik, lekin
muhim o'zgarish (§5).

---

## 3. AI-driven production dialog — web + Telegram umumiy kontrakt

### 3.1 Dizayn prinsipi: kanal-agnostik backend, ikki ifoda (web + telegram)

Egasi qaroriga ko'ra (Q5) dialog **ikkala kanalda** ishlaydi. Buni qo'shaloq logikasiz
qilish uchun **backend yagona dialog davlat mashinasini** (production dialog session)
boshqaradi; web UI va Telegram bot faqat **render + javob yetkazish** qatlami bo'ladi.

```
                ┌───────────────────────────────────────────────┐
                │  production_dialog_sessions (backend)         │
                │  - holat: AWAITING_SOURCE_DECISION,            │
                │    AWAITING_CREAM_CONFIRM, RESOLVED, EXPIRED   │
                │  - savol + variantlar (options) JSON           │
                └───────────────────────────────────────────────┘
                        ▲                          ▲
        GET/POST /api/production/dialog      Telegram bot (Grammy)
        (web modal)                          (inline tugmalar, ADR-0011)
```

**Yagona kontrakt:** dialog savoli `{ session_id, question_text, options[] }` ko'rinishida —
web modal radio/tugma sifatida ko'rsatadi, Telegram inline keyboard sifatida. Foydalanuvchi
javobi `{ session_id, option_id }` — ikkala kanaldan bir xil endpoint'ga keladi.

### 3.2 Dialog session — yangi jadval

```sql
CREATE TABLE production_dialog_sessions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  replenishment_id BIGINT REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  production_order_id BIGINT REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id      BIGINT NOT NULL REFERENCES products(id),
  location_id     BIGINT NOT NULL REFERENCES locations(id),  -- sex (production)
  assigned_user_id BIGINT REFERENCES users(id),              -- qaysi sex user'iga
  state           TEXT NOT NULL                              -- dialog state (3.3)
                    CHECK (state IN ('AWAITING_SOURCE_DECISION',
                                     'AWAITING_CREAM_CONFIRM',
                                     'RESOLVED','EXPIRED','CANCELLED')),
  qty_ordered     NUMERIC(14,4) NOT NULL,
  context         JSONB NOT NULL DEFAULT '{}',  -- {zagatovka_have, zagatovka_need, options...}
  decision        JSONB,                        -- foydalanuvchi javoblari (audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '6 hours'
);
CREATE INDEX ix_pds_open ON production_dialog_sessions(assigned_user_id, state)
  WHERE state IN ('AWAITING_SOURCE_DECISION','AWAITING_CREAM_CONFIRM');
```

`context`/`decision` JSONB — chunki dialog qadamlari yengil va o'zgaruvchan; qattiq ustun
kerak emas. Audit uchun `decision` to'liq saqlanadi (kim, nima tanladi).

### 3.3 Dialog state machine va qaror nuqtalari

```
  Buyurtma tushadi (replenishment CREATE_PRODUCTION_ORDER yoki manual)
         │
         ▼
  AI sex skladidagi zagatovka qty ni o'qiydi
         │
   ┌─────┴──────────────────────────────────────────┐
   │ zagatovka >= qty_ordered                        │ zagatovka < qty_ordered (yoki = 0)
   │ (savol kerak: tayyordan yoki 0dan?)             │ (qisman yoki umuman yo'q)
   ▼                                                 ▼
 SAVOL 1: AWAITING_SOURCE_DECISION              SAVOL 1' (variant kamroq):
 "Nta tortga buyurtma. M zagatovka bor —        "Nta buyurtma, faqat M zagatovka bor.
  [Tayyordan ol] [0dan qil]"                     [Bor M tasini tayyordan, qolganini 0dan]
   │                                              [Hammasini 0dan]"
   ├── "Tayyordan ol" ─────────► zagatovka consume yo'li (sub-PO YO'Q)
   │                                                 │
   ├── "0dan qil" ────────────► zagatovka sub-PO yaratiladi (base BOM)
   │                            (raw tekshiruvi → kerak bo'lsa purchase so'rovnoma)
   │                                                 │
   └─────────────────────────► ikkalasidan keyin ───┘
                                                     ▼
                                  SAVOL 2: AWAITING_CREAM_CONFIRM
                                  AI decoration komponentlarini (krem/bezak) tekshiradi:
                                  ┌──────────────────────────────────┐
                                  │ krem/bezak yetarli → savol YO'Q   │ → RESOLVED
                                  │ krem 0 / kam:                      │
                                  │ "Krem yetarli emas (bor X, kerak Y)│
                                  │  [Yangi krem tayyorlash]           │ → ukrasheniye
                                  │  [Ombordan so'rash]"               │   material so'rovnoma
                                  └──────────────────────────────────┘
                                                     ▼
                                                  RESOLVED
                                  (qaror → so'rovnoma(lar) shakllanadi → §4)
```

**Qaror nuqtalari va kimga/qachon savol:**

| # | Qachon | Kimga | Savol | Javoblar → natija |
|---|---|---|---|---|
| Q1 | Final PO `new` bo'lganda, zagatovka mavjud | Sex (production) manager / assigned user | "Nta buyurtma, M zagatovka bor — tayyordan yoki 0dan?" | "Tayyordan" → sub-PO yo'q; "0dan" → zagatovka sub-PO |
| Q1' | zagatovka qisman/yo'q | Sex user | "M tasini tayyordan, qolganini 0dan?" yoki "hammasini 0dan?" | aralash → qisman sub-PO |
| Q2 | Zagatovka hal bo'lgach | Sex user | (faqat krem kam bo'lsa) "Krem kam, yangi tayyorlash yoki ombordan?" | "tayyorlash" → krem produce so'rov; "ombordan" → purchase so'rov |

**Avtomatik o'tkazib yuborish (no-dialog yo'llari):**
- Agar zagatovka **aniq yetarli** va egasi "har doim tayyordan ol" siyosatini yoqsa
  (lokatsiya-darajali flag, §6 ochiq savol) — Q1 o'tkazib yuboriladi.
- Agar decoration komponentlari yetarli — Q2 o'tkazib yuboriladi.
- Dialog `expires_at` (6 soat) o'tsa → `EXPIRED`; default xavfsiz yo'l (tayyordan ol,
  agar yetarli bo'lsa) qo'llanadi va PM'ga eskalatsiya bildirishnomasi yuboriladi.

### 3.4 API kontrakt (web + telegram bir xil endpoint)

```
GET  /api/production/dialog?status=open
     → ochiq dialog session'lar (assigned user uchun; RBAC: o'z sexi)
     200 { sessions: [ { id, product_name, qty_ordered, state,
                         question: { text, options: [{id,label,hint}] } } ] }

POST /api/production/dialog/:id/answer
     body { option_id: string, qty?: number }   // qty — qisman tanlovlar uchun
     200 { session: {...}, next_question?: {...}, resolved: bool,
           created_requests: [ { type:'purchase'|'production', id, ... } ] }
     409 SESSION_EXPIRED | INVALID_OPTION
     403 FORBIDDEN (boshqa sex user'i)

POST /api/production/dialog/:id/cancel   // sex user / pm bekor qiladi
     200 { session: {...} }
```

**Telegram tomoni (Grammy, ADR-0011 inline actions bilan):**
- Dialog ochilganda bot `assigned_user`ning TG id'siga xabar + inline keyboard yuboradi
  (`question.options` → inline tugmalar). Inline callback `dialog:<id>:<option_id>`.
- Callback handler **xuddi shu** `POST /api/production/dialog/:id/answer` xizmat
  funksiyasini chaqiradi (HTTP emas, ichki service call). Natija — bot xabarini
  tahrirlaydi ("Tanlandi: 0dan qil; un uchun so'rovnoma yaratildi").
- TG self-link (EPIC 3.2) bilan har sex user TG id'siga ega bo'ladi.

**Web tomoni:** dashboard'da "Ishlab chiqarish dialogi" paneli / modal; `GET .../dialog`
poll yoki SSE; har savol radio/tugma; javob `POST .../answer`. Egasi qaroriga ko'ra
ikkala kanal teng.

### 3.5 AI rolining aniqligi (Vertex Gemini, ADR-0006/0009)

AI **so'rov matnini shakllantiradi** va **default tavsiya beradi** (masalan "tavsiya:
tayyordan ol — 20 zagatovka bor"), lekin **qarorni foydalanuvchi qabul qiladi**. AI
function calling DB ustida (ADR-0006) zagatovka/krem qoldig'ini o'qiydi. Write-action
(so'rovnoma yaratish) faqat foydalanuvchi tasdig'idan keyin (ADR-0009 confirmation
qoidasi). Bu invariantlarni buzmaydi — so'rovnoma yaratish ikki bosqichli tasdiq (D5)
oqimiga tushadi.

---

## 4. Retseptdan avtomatik so'rovnoma shakllantirish algoritmi

Dialog qarori (`decision`) RESOLVED bo'lganda backend so'rovnoma(lar) shakllaydi.
Algoritm **conditional BOM expansion** — zagatovka mavjudligiga qarab `base` qismini
o'tkazib yuboradi.

### 4.1 Algoritm (pseudo, kod EMAS — implementatsiya backend-engineer'ga)

```
INPUT: finished product P, qty Q, sex location S (production),
       sex_storage SS, raw_warehouse RW, dialog.decision

zagatovka_product = recipes(P, stage='decoration').components
                    da type='semi' bo'lgan komponent (zagatovka)
zagatovka_have    = stock(SS, zagatovka_product).qty
zagatovka_need    = Q * qty_per_unit(P, zagatovka_product)

# 1-BOSQICH — zagatovka manbasi (dialog Q1 qaroriga ko'ra)
take_from_ready = decision.source == 'ready' ? min(zagatovka_have, zagatovka_need) : 0
make_from_zero  = zagatovka_need - take_from_ready

IF make_from_zero > 0:
    # base BOM (hamir) bo'yicha xom-ashyo tekshiruvi — FAQAT 0dan qilinadiganiga
    base_bom = recipes(zagatovka_product, stage='base')
    FOR each component c in base_bom:
        need_c = make_from_zero * qty_per_unit(zagatovka_product, c)
        have_c = stock(SS, c) + stock(RW, c)   # sex_storage check-first
        IF have_c < need_c:
            shortage_list_base += {c, need_c - have_c}
    IF shortage_list_base not empty:
        → PURCHASE so'rovnoma (raw warehouse) — yetishmaganini so'raydi
    ELSE:
        → zagatovka sub-PO (stage_role='zagatovka', base BOM, target=SS)
# ELSE (hammasi tayyordan): base BOM BUTUNLAY o'tkazib yuboriladi ✅

# 2-BOSQICH — ukrasheniye materiallari (krem + bezak)
deco_bom = recipes(P, stage='decoration') MINUS zagatovka komponenti
FOR each component d in deco_bom:
    need_d = Q * qty_per_unit(P, d)
    have_d = stock(SS, d) + stock(RW, d)
    IF have_d < need_d:
        IF d is 'semi' (krem o'zi ishlab chiqariladi) AND decision.cream=='make':
            → krem produce so'rovi (sub-PO yoki replenishment, krem BOM)
        ELSE:
            shortage_list_deco += {d, need_d - have_d}
IF shortage_list_deco not empty:
    → PURCHASE so'rovnoma (raw warehouse) — ukrasheniye materiallari

# NATIJA: 0..2 ta so'rovnoma + 0..2 ta sub-PO, finished PO esa zagatovka
#         va krem tayyor bo'lgach `done` ga o'tadi.
```

### 4.2 Asosiy qoidalar

1. **Zagatovka tayyor bo'lsa hamir retsepti kerak emas** (egasi talabi): `make_from_zero=0`
   bo'lsa `base_bom` butunlay tekshirilmaydi va so'ralmaydi.
2. **So'rovnoma faqat yetishmaganini so'raydi** (egasi talabi): har komponentda
   `need - have` (sex_storage + raw birga, check-first) hisoblanadi; ortig'i so'ralmaydi.
3. **Bitta nakladnoy, bo'limlarga ajratilgan** (EPIC 8.4 bilan moslashish): base va
   decoration shortage'lari bitta so'rovnomada section sifatida ko'rsatiladi (hamir
   uchun: un/shakar; ukrasheniye uchun: krem/bezak; itogo). Bu EPIC 8.4 nakladnoy
   formatiga to'g'ridan-to'g'ri mos keladi.
4. **Ikki bosqichli tasdiq (D5):** har purchase so'rovnoma boshliq + skladchi tasdig'iga
   tushadi (mavjud supply request oqimi).
5. **Atomarlik:** so'rovnoma + sub-PO yaratish dialog `answer` ichida bitta tranzaksiyada;
   xato bo'lsa hammasi rollback, dialog state o'zgarmaydi.

### 4.3 Somsa misoli (egasidan) bilan tekshiruv

Somsa: tayyor hamir (zagatovka, semi) + qiyma sex skladida. Pechda pishiriladi.
- `finished = Somsa`, `recipes(Somsa, stage='decoration')` = [hamir(semi), qiyma].
  `stage='assembly'` ham bo'lishi mumkin (pishirish — material yo'q, faqat mehnat).
- Hamir va qiyma sex skladida yetarli bo'lsa → so'rovnoma yo'q, faqat consume + pech.
- Hamir kam bo'lsa → "0dan" → hamir base BOM (un, suv, achitqi) → raw tekshiruvi.

Model somsa stsenariysini buzmasdan qoplaydi. ✅

---

## 5. Sex skladi min/max + avto-to'ldirish (replenishment engine bilan ulanish)

### 5.1 Talab

Egasi: "Sex skladida ham min/max — buyurtma tez bajarilishi uchun doim minda zagatovka
turadi; 10ta olinса qaytadan to'ldiriladi." Ya'ni zagatovka (semi) sex skladida
**replenishment-driven** zaxirada saqlanadi.

### 5.2 Dizayn — mavjud engine'ni sex skladiga kengaytirish

ADR-0015 §4 R1 sex skladini state machine'dan tashqarida qoldirgan edi. **Bu ADR uni
ichkariga kiritadi** — chunki sex skladidagi zagatovka aynan ishlab chiqarish orqali
to'ldirilishi kerak, bu esa replenishment'ning to'liq oqimi.

**Kalit kuzatuv:** sex skladidagi zagatovka (semi) uchun replenishment **production**
yo'liga tushishi kerak (CHECK_STORE_SUPPLIER emas — sex skladi uchun "store supplier"
markaziy sklad emas, balki o'z sexi). Ikki variant:

**Variant A (tanlangan) — sex_storage requester uchun topologiyani moslash.**
`resolveTopology` sex_storage'dan boshlanganda:
- `target` (CHECK_STORE_SUPPLIER bosqichi) — **o'z sexining production location'i emas**,
  balki to'g'ridan-to'g'ri `CHECK_PRODUCTION_INPUT`ga o'tadi (sex skladi uchun "supplier"
  yo'q, faqat o'z ishlab chiqarishi). Ya'ni `advanceCheckStoreSupplier` sex_storage
  requester uchun darhol `CHECK_PRODUCTION_INPUT`ga o'tadi.
- `CHECK_PRODUCTION_INPUT` zagatovka (semi) BOM'ini (`stage='base'`) tekshiradi → kerak
  bo'lsa raw transfer / purchase → zagatovka `production_order` (target = **sex_storage**,
  central emas).
- `DONE_TO_WAREHOUSE → SHIP_TO_REQUESTER`: zagatovka allaqachon sex skladida (target =
  sex_storage = requester), shuning uchun "ship" no-op yoki o'z-o'ziga (qisqartiriladi →
  to'g'ridan CLOSED).

**Variant B (rad etilgan) — alohida "internal replenishment" yo'li.** Yangi state'lar
talab qiladi; mavjud audit/transition infratuzilmasini takrorlaydi.

**Tanlov: Variant A** — mavjud state machine'ni topologiya-aware qiladi, yangi state yo'q.

### 5.3 Min/max manbasi

- **Manual (Faza-4 boshi):** PM/sex manager zagatovka uchun sex skladida min/max kiritadi
  (masalan, min=10, max=30 zagatovka).
- **Dynamic (ADR-0007):** sex skladi uchun "sotuv" yo'q, lekin **iste'mol** bor (final
  PO'lar zagatovkani consume qiladi). Dynamic formula `avg_daily` o'rniga
  **zagatovka consume rate** (production_input movements, reason-filtered) ishlatadi.
  Bu ADR-0007 §2 sales-aggregate'ning kengaytmasi: `consumption_stats_daily` (yangi
  agregat) yoki mavjud `sales_stats_daily`ga `consumption` ustun. → §6 ochiq savol.

### 5.4 Scan worker

Mavjud replenishment scan (`qty <= min_level → createRequest`) sex_storage qatorlariga
ham qo'llanadi — hozir ham `stock` bo'ylab yuradi, sex_storage qatorlari hech qanday
maxsus filtrsiz kiradi. Faqat `advanceCheckStoreSupplier`dagi topologiya moslash (§5.2)
kerak. "10ta olinса to'ldiriladi" — qty min'dan tushganda avtomatik request.

---

## 6. Mavjud kod / sxemaga ta'sir (ro'yxat + reja — kod YOZILMAYDI)

### 6.1 Migration'lar (yangi)

| # | Fayl (taklif) | Mazmun |
|---|---|---|
| M1 | `00XX_recipe_stage.sql` | `CREATE TYPE recipe_stage`; `recipes.stage` ustuni (default `base`); Poster sinx eski retseptlar `base` qoladi |
| M2 | `00XX_production_order_stages.sql` | `production_orders.parent_production_order_id`, `stage_role` ustunlari |
| M3 | `00XX_production_dialog_sessions.sql` | `production_dialog_sessions` jadvali + indeks |
| M4 | (ixtiyoriy) `00XX_sex_minmax_policy.sql` | lokatsiya-darajali "always from ready" flag + dynamic consumption rejimi (§6 ochiq savol hal bo'lgach) |

Hech bir migration mavjud ma'lumotni o'chirmaydi — barchasi additive (default'lar bilan
backward-compatible). Destructive emas, egasi tasdig'isiz ham xavfsiz scaffold.

### 6.2 Service qatlami (o'zgaradigan / yangi)

| Fayl | O'zgarish |
|---|---|
| `services/productionOrder.ts` | `consumeBomAndProduce` — `stage='decoration'` BOM bilan ishlash; zagatovka (semi) komponentini sex_storage'dan consume; zagatovka sub-PO done flow (base BOM → semi → sex_storage) |
| `services/replenishment.ts` | `advanceCheckProductionInput` — BOM o'qishni `stage='decoration'` ga moslash; `advanceCheckStoreSupplier` — sex_storage requester uchun darhol `CHECK_PRODUCTION_INPUT`; `resolveTopology` — sex_storage requester uchun target=sex_storage |
| `services/productionDialog.ts` (yangi) | dialog session lifecycle: create/answer/cancel/expire; conditional BOM expansion algoritmi (§4); so'rovnoma+sub-PO yaratish |
| `services/purchaseOrder.ts` | bo'limlarga ajratilgan nakladnoy (base/decoration section) — EPIC 8.4 bilan birga |
| Telegram bot (Grammy) | dialog inline keyboard + callback → `productionDialog.answer` (ADR-0011) |
| AI tool layer (`integrations/vertex/tools.ts`) | zagatovka/krem qoldig'ini o'qish tool'i; dialog savol matni generatsiyasi |

### 6.3 Route qatlami (yangi)

| Endpoint | Izoh |
|---|---|
| `GET /api/production/dialog` | ochiq dialog session'lar (RBAC: sex) |
| `POST /api/production/dialog/:id/answer` | javob → so'rovnoma/sub-PO |
| `POST /api/production/dialog/:id/cancel` | bekor |

### 6.4 Frontend

- Ishlab chiqarish dialog paneli/modal (web kanal, §3.4).
- BOM section ko'rinishi (hamir/krem/bezak) — EPIC 1.5 bilan birga (`recipes.stage`).
- "Секс склады" typo tuzatish — EPIC 10.1 (alohida).

### 6.5 Test (acceptance, TZ §15)

- Zagatovka yetarli → "tayyordan" → base BOM **so'ralmaydi**, faqat decoration.
- Zagatovka yo'q → "0dan" → base BOM raw tekshiruvi → zagatovka sub-PO → semi sex_storage.
- Krem 0 → Q2 → ukrasheniye material so'rovnoma.
- Sex skladi qty <= min → avto replenishment → zagatovka production.
- Dialog web va telegram bir xil natija beradi (kanal-agnostik).
- Atomarlik: so'rovnoma+sub-PO yaratishda xato → hammasi rollback.
- Invariantlar: stock manfiy emas; bitta ochiq request per (semi, sex_storage).

---

## 7. Oqibatlar

**Yaxshi:**
- (+) Domen operatsion haqiqatga to'liq mos: zagatovka → ukrasheniye ikki bosqich.
- (+) Conditional BOM — hamir tayyor bo'lsa qayta so'ralmaydi (egasi talabi aynan).
- (+) Kanal-agnostik AI dialog — web + telegram bir backend, kod takrorlanmaydi.
- (+) Mavjud sxemaga minimal qo'shimcha: `recipes.stage`, 2 ta `production_orders`
  ustuni, 1 ta yangi jadval. Yangi jadval portlashi yo'q (ADR-0004 falsafasi).
- (+) Sex skladi min/max replenishment'ga ulanadi — "10ta olinса to'ldiriladi".
- (+) `fa851ba` sex_storage check-first mantiqi semi darajasida qayta ishlatiladi.

**Yomon / cheklovlar:**
- (−) `advanceCheckProductionInput`ga `stage` filtri qo'shilmasa, hamir komponentlari
  ikki marta hisoblanadi (R3 — implementatsiyada ehtiyot bo'lish kerak).
- (−) Dialog session lifecycle (expire, eskalatsiya) qo'shimcha operatsion yuk —
  cron `EXPIRED` belgilashi kerak.
- (−) Dynamic min/max sex skladi uchun consumption rate'ga muhtoj — ADR-0007 kengaytmasi
  (Faza-4 oxiriga qoldirilishi mumkin; boshida manual).
- (−) Telegram va web ikkala kanal sinxron qoldirilishi shart (bir dialog ikki joyda
  ochilsa — `state` DB'da yagona manba, lekin UI eskirishi mumkin → poll/SSE kerak).

---

## 8. Ochiq savollar / risklar (egasi tasdig'iga muhtoj)

### Egasi tasdig'iga muhtoj savollar
- **OQ1.** "Har doim tayyordan ol" siyosati — lokatsiya-darajali avtomatik flag bo'lsinmi
  (zagatovka yetarli bo'lsa Q1 o'tkazib yuboriladi), yoki **har buyurtmada** sex user'dan
  so'ralsinmi? (TZ §16 yangi — egasi stsenariysi har doim so'raydi, lekin avtomatlashtirish
  tezlikni oshiradi.)
- **OQ2.** Sex skladi dynamic min/max manbai — production consumption rate (yangi agregat)
  kerakmi, yoki Faza-4 da **faqat manual** min/max yetarlimi? (ADR-0007 kengaytmasi hajmi.)
- **OQ3.** Zagatovka tort uchun "70% tayyor" — bitta `semi` mahsulot bilan ifodalanadimi,
  yoki har tort modeli (Napoleon, Medoviy...) **o'z zagatovkasiga** ega bo'ladimi? (Bu
  `products` da nechta `semi` zagatovka mahsulot bo'lishini belgilaydi; ehtimol har tort
  oilasiga bitta.)
- **OQ4.** Dialog `expires_at` (6 soat default) va eskirgan dialog uchun **default yo'l**
  (xavfsiz "tayyordan ol" yoki PM eskalatsiya) — to'g'rimi?
- **OQ5.** Krem — alohida `semi` mahsulot (o'z BOM bilan, "yangi tayyorlash" = krem sub-PO),
  yoki raw material (faqat "ombordan so'rash")? Egasi "kremlarni tekshir, yangi tayyorlash"
  deydi → krem `semi` ko'rinadi. Tasdiqlash kerak.

### TZ §16 / spec ochiq savollariga bog'liqlik (dizayn ularga tayanadi)
- **Q5 (EPIC 5.2) — HAL QILINDI:** AI dialog **web + telegram** ikkalasida (egasi
  2026-05-29). Bu ADR shu qarorga qurilgan.
- **Q4 (EPIC 4.3):** "Yetkazib berish" moduli o'chiriladimi/qabulga aylanadi — sex skladi
  → markaziy oqimi (final PO done → central) shu qarorga to'g'ri kelishi kerak.
- **Q8 / P1 (EPIC 2.2):** sklad klassifikatsiya mapping (qaysi Poster storage = sex_storage,
  qaysi = sex/production). Bu ADR `sex_storage` va `production` location'lar to'g'ri
  ajratilganiga tayanadi — mapping tasdiqlanmaguncha zagatovka oqimi sinab ko'rilmaydi.
- **EPIC 1.5 / EPIC 8.4:** `recipes.stage` (BOM section) va bo'limlarga ajratilgan
  nakladnoy shu ADR bilan **umumiy** — birga rejalashtirilishi kerak.

### Risklar
- **R1.** Poster'dan sinxlangan retseptlar `stage` belgisiz keladi — barchasi `base`
  bo'ladi. Tort retseptlarini `base`/`decoration` ga **qo'lda yoki AI bilan** ajratish
  kerak (EPIC 1.3 AI kategoriya bilan birga). Aks holda zagatovka oqimi ishlamaydi.
- **R2.** Zagatovka (semi) mahsulot Poster'da alohida ingredient/prepack sifatida
  mavjudmi? Agar yo'q bo'lsa, ADIA ichida yaratilishi kerak (Poster read-only, Q7).
- **R3.** `advanceCheckProductionInput`da hozir BOM **butunligicha** o'qiladi (`fa851ba`).
  `stage` filtri qo'shilmasa hamir komponentlari ikki marta hisoblanadi — implementatsiyada
  birinchi tuzatiladigan nuqta.

---

## 9. Bog'liq hujjatlar

- `docs/specs/changes-2026-05-owner-feedback.md` §EPIC 5, §EPIC 0+ (P1 sklad mapping).
- `docs/architecture/adr-0001-replenishment-state-machine.md` (§7 raw transfer, §9 target).
- `docs/architecture/adr-0004-semi-finished-dual-flow.md` (semi mahsulot modeli).
- `docs/architecture/adr-0007-dynamic-minmax-engine.md` (sex min/max kengaytma).
- `docs/architecture/adr-0015-sex-storage-remodeling.md` (§4 R1 — bu ADR uni davom ettiradi).
- `docs/architecture/adr-0011-telegram-inline-actions.md` (dialog inline keyboard).
- migration 0021/0022/0025/0026 (sex_storage, location_flows).
- `apps/backend/src/services/replenishment.ts` (`advanceCheckProductionInput` — `fa851ba`).
- `apps/backend/src/services/productionOrder.ts` (`consumeBomAndProduce`).
</content>
</invoke>
