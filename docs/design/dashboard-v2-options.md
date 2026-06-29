# Dashboard v2 — 3 ta variant taklif

> Sana: 2026-05-25
> Maqsad: Hozirgi "card-spam" dashboard'ni **manoli va vizual xilma-xil** boshqaruv paneli ga aylantirish.

## Muammo (hozirgi holat)

- Yuqori KPI strip (4 card) + ChainFlow (5 card) + Kritik signallar/Actions (2 panel) = **11 ta uxshash kartochka** yonma-yon.
- Vizual xilma-xillik yo'q: hammasi kvadrat card, hammasi label+number.
- Chart yo'q. Trend yo'q. Pipeline diagrammasi yo'q.
- Boshliq ko'zi qaerga tushishini bilmaydi — hamma narsa "teng".

## Boshliq nimani xohlaydi (3 ta savol)

1. **Bugun yaxshimi?** — bir qarashda joriy ahvol (revenue, sotuv soni, trendlar).
2. **Hozir nima bo'lyapti?** — zanjirning qaysi bo'g'inida nima holatda (live status).
3. **Hozir nima diqqat talab qiladi?** — kritik alertlar, kutayotgan tasdiqlar.

Har variant shu 3 savolga **boshqacha tarzda** javob beradi.

---

## VARIANT A — "Executive Summary First" (analitik fokusda)

> Falsafa: yuqorida BIG NUMBER + TREND CHART, pastda zanjir status, eng pastda action queue.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HERO BLOCK (260px) — Bugungi savdo + trend                                      │
│ ┌──────────────────────┐ ┌──────────────────────────────────────────────────┐ │
│ │ BUGUNGI TUSHUM        │ │   📈 30 kunlik savdo trendi (area chart)       │ │
│ │  93,250,000 so'm     │ │                                                   │ │
│ │  +12.4% ↑ kechaga    │ │   [smooth area chart, primary gradient]          │ │
│ │  ──────────────       │ │                                                   │ │
│ │  893 ta chek          │ │                                                   │ │
│ │  104,425 o'rtacha     │ │                                                   │ │
│ └──────────────────────┘ └──────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ZANJIR PIPELINE (140px) — 5 bo'g'in gorizontal flow + arrows                    │
│ ┌──┐ → ┌──┐ → ┌──┐ → ┌──┐ → ┌──┐                                                │
│ │RW│   │PR│   │SU│   │CW│   │ST│  ← har biri kichik card (80×120):              │
│ │✓ │   │● │   │✓ │   │⚠ │   │✓ │     • status dot + bo'g'in nomi                │
│ │  │   │  │   │  │   │  │   │  │     • 1 ta hero KPI                            │
│ │3 │   │1│   │0│   │2│   │6│     • mini sparkline (7 kun trend)             │
│ │SKU│  │faol│ │so'rov│xato│do'kon│                                              │
│ └──┘   └──┘  └──┘  └──┘   └──┘                                                  │
│        click → drawer ochiladi                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ACTION ROW (300px) — 3 ta keng panel                                            │
│ ┌───────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐  │
│ │ 🔴 KRITIK         │  │ ⏳ TASDIQ KUTAY  │  │ 📊 BUGUN AKTIVLIK            │  │
│ │ • Un < min        │  │ • PO #128 ...    │  │ ┌─────┐                     │  │
│ │ • Shakar < min    │  │ • PO #131 ...    │  │ │chart│ Production: 53kg     │  │
│ │ • Tort tugaydi 2k │  │ • Repl R#42 ...  │  │ │     │ Supply jo'natma: 80  │  │
│ │ • PO #131 muddat  │  │ • Repl R#43 ...  │  │ │     │ Store transit: 12    │  │
│ │ [Hammasini ko'r]  │  │ [Hammasini ko'r] │  │ │     │ Sync: 1 daq oldin    │  │
│ └───────────────────┘  └──────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Vizual elementlar:**
- 1 ta katta **area chart** (30 kunlik savdo trendi) — eng katta vizual
- 5 ta **mini sparkline** (har bo'g'in ichida, 60×30 px)
- 2 ta list (kritik signallar, tasdiq kutmoqda)
- 1 ta **mini bar chart** (bugungi aktivlik)
- Status dot va ranglar har joyda

**Plyuslar:** Trend ochiq, analitik. Boshliq tezda "yaxshilanyaptimi/yomonlashayaptimi" ni ko'radi.
**Minuslari:** Zanjir bo'limlari kichkina, kontent kam.

---

## VARIANT B — "Operations Cockpit" (jonli holat fokusda)

> Falsafa: zanjir markazda mega-card sifatida, har bo'g'inda mini chart, alertlar va action'lar yon panelda.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HEADER (56px) — greeting · DateRange · sana/soat                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ┌── 4 KPI compact strip (90px) ────────────────────────────────────────────┐   │
│ │ Tushum 93K +12% │ Cheklar 893 │ Aktiv 1 │ Tugash 25                       │   │
│ └───────────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                ┌─ Action panel ┐│
│ ZANJIR COCKPIT (560px) — 5 ta katta card o'z chart bilan      │ 🔴 Kritik     ││
│ ┌────────────┐ ┌────────────┐ ┌────────────┐                  │ • Un          ││
│ │ Xom-ashyo  │ │ Ishlab ch. │ │ Ta'minot   │                  │ • Tort       ││
│ │ ●ok        │ │ ⚠ overdue  │ │ ●ok        │                  │ • PO #128    ││
│ │            │ │            │ │            │                  │ [Hammasi →]  ││
│ │ KPI: 3     │ │ KPI: 1 faol│ │ KPI: 80    │                  │              ││
│ │ ▁▃▅▇█▆ Spk│ │ ▁▂▁▃▅▇ Spk │ │ ▂▄▆▇▆▄▂ Spk│                  │ ──────────── ││
│ └────────────┘ └────────────┘ └────────────┘                  │ ⏳ Tasdiq    ││
│ ┌────────────┐ ┌────────────────────────┐                     │ • PO #131    ││
│ │ Markaziy   │ │ Do'konlar              │                     │ • Repl R#42  ││
│ │ ⚠ 2 xato   │ │ 506.72mlrd so'm        │                     │ [Hammasi →]  ││
│ │            │ │ ▁▃▆█▇▅▂▁ kunlik chart   │                     │              ││
│ │ KPI: 281   │ │ Top: Bug'irsoq         │                     │ ──────────── ││
│ │ Sync: 1m   │ │ Avg: 1.63mlrd          │                     │ 📊 Status    ││
│ │ ──── ▂▅▇▄ │ │ 6 do'kon ranking →     │                     │ Sync 1m ok   ││
│ └────────────┘ └────────────────────────┘                     │ Forecaster ✓ ││
│                                                                └──────────────┘│
├─────────────────────────────────────────────────────────────────────────────────┤
│ AKTIVLIK FEED (220px) — real-time event ticker                                  │
│ • 18:01  Sotuv  Bug'irsoq · Do'kon 1 · 12,400 so'm                              │
│ • 17:54  Sync   Poster leftovers · 509 records                                  │
│ • 17:32  Order  PO #131 muddat o'tdi                                            │
│ • 17:15  Sotuv  Pahlava · Do'kon 3 · 8,200 so'm                                 │
│ [Hammasini ko'rish →]                                                           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Vizual elementlar:**
- 5 ta **mini sparkline** har chain card ichida (har biri yaqin 7 kun trendi)
- 1 ta **area chart** Do'konlar card ichida (kattaroq — eng faol bo'g'in)
- **Live activity feed** (real-time ticker, har 30s yangilanadi)
- Pipeline arrow yo'q — chain cardlar markazda kompozitsiya
- Yon panel actions uchun fixed

**Plyuslari:** Zanjir mega-card sifatida ko'rinadi. Real-time aktivlik feed.
**Minuslari:** Yon panel kontentni siqib qo'yadi. Activity feed e'tiborni chalg'itadi.

---

## VARIANT C — "Story Pipeline" (povest fokusda)

> Falsafa: dashboard hikoya gapiradi — quyidan yuqoriga zanjir oqimi vizual ko'rinadi. Boshliq ko'zi tabiiy yo'l bilan qaerga qarash kerakligini biladi.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HERO BLOCK (180px) — 2 ustun                                                    │
│ ┌─────────────────────────┐ ┌────────────────────────────────────────────────┐│
│ │ Bugun                   │ │ ZANJIR SOG'LIGI (live indicator)               ││
│ │  93.25M so'm            │ │ ●  ●  ●  ●  ●                                  ││
│ │  893 chek · +12.4%      │ │ RW PR SU CW ST  →  4/5 yaxshi · 1 alert        ││
│ │                          │ │                                                  ││
│ │ ▁▂▃▄▅▆▇█▆▄▃▂ 7 kun     │ │ ⚠ Markaziy sklad — 2 sync xato 24h            ││
│ └─────────────────────────┘ └────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────────────────┤
│ ZANJIR POYI (480px) — vertikal pipeline (chap), data charts (o'ng)              │
│ ┌────────┐                                                                       │
│ │Xom-asho│ ──┐ 3 SKU · 0 below                  ┌─ Production output chart ──┐ │
│ │  ●     │   │                                  │ ▁▂▃▅▇█▇▆▅▃▁ 7 kun         │ │
│ └────────┘   │                                  │ Bugun: 53kg ishlab chiq.  │ │
│   ↓ today   │                                  └─────────────────────────────┘ │
│ ┌────────┐   │                                                                 │
│ │ Ishlab │ ──┤ 1 faol · 1 overdue!              ┌─ Sotuv lentasi (live) ──── │ │
│ │  ⚠     │   │                                  │ 18:01 Bug'irsoq 12,400     │ │
│ └────────┘   │                                  │ 17:54 Pahlava 8,200        │ │
│   ↓ today   │                                  │ 17:32 Eklen 5,500          │ │
│ ┌────────┐   │                                  │ [Hammasi →]                │ │
│ │Ta'minot│ ──┤ 80 SKU · 0 so'rov                └─────────────────────────────┘ │
│ │  ●     │   │                                                                 │
│ └────────┘   │                                  ┌─ Top mahsulot bugun ───────┐ │
│   ↓ today   │                                  │ 1. Bug'irsoq    82.7M     │ │
│ ┌────────┐   │                                  │ 2. Kushtili      78.8M     │ │
│ │Markaziy│ ──┤ 281 SKU · 2 sync error           │ 3. Pahlava       30.6M     │ │
│ │  ⚠     │   │                                  │ 4. Naryn          25.8M     │ │
│ └────────┘   │                                  │ 5. Samsa          23.9M     │ │
│   ↓ today   │                                  └─────────────────────────────┘ │
│ ┌────────┐   │                                                                 │
│ │Do'konlar│──┘ 6 do'kon · 506.72mlrd            ┌─ 6 do'kon ranking ──────── │ │
│ │  ●     │                                      │ Kukcha    255.3M           │ │
│ └────────┘                                      │ Rabochiy  175.4M           │ │
│                                                  │ ...                        │ │
│                                                  └─────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────────┤
│ ACTION + ALERTS (260px) — kritik signallar + tasdiq kutmoqda (gorizontal)       │
│ [oldingi pattern saqlanadi — 2 ustun]                                           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Vizual elementlar:**
- **Vertikal zanjir pipeline** — yuqori → past, arrowlar bilan, gorizontal chizilgan strelka
- **Production output chart** (sparkline yoki area)
- **Sotuv lentasi** — live feed
- **Top mahsulot** — bar list (top 5)
- **6 do'kon ranking** — bar list
- **7 kunlik trend mini chart** (hero block ichida)

**Plyuslari:** Hikoya ravon — boshliq zanjirning haqiqiy oqimini ko'radi. Charts va listlar muvozanatda.
**Minuslari:** Vertikal layout kichik ekranlarda qisqaradi. Murakkabroq implement.

---

## §0 Umumiy vizual qoidalar (har 3 variant uchun)

- **Rang gradientlari** har chain card uchun yumshoq (`radial-gradient` accent)
- **Status indicator**: `● yashil` ok · `● amber` warn · `● qizil` danger · pulsatsiya faqat danger uchun
- **Recharts** — area, line, bar, sparkline. Compact, axis'siz ko'pchilik joyda.
- **Live counter** — har 30 soniyada yangilanadi (allaqachon bor)
- **Charts loading** — skeleton shimmer

---

## §1 Texnik talablar

- 3 variant ham mavjud `chain_summary` shape'idan ishlaydi (backend o'zgartirish kerak emas).
- Yangi komponentlar:
  - `MiniSparkline` (mavjud, kengaytirish kerak — chain tone)
  - `LiveActivityFeed` (yangi — `recent_movements` + `sales` real-time poll)
  - `ChainPipeline` (yangi — vertical/horizontal flow indicator)
  - `TopProductList` (yangi — `top_products_today` ranglik bar list)
  - `StoreRanking` (yangi — 6 do'kon savdo bo'yicha ranking)
  - `HeroBlock` (yangi — savdo + trend chart birgalikda)
- Charts: 30 kunlik savdo `sales_chart.days` mavjud (Sprint C).
- Aktivlik feed: backend yangi endpoint kerak (`GET /api/dashboard/activity?limit=20`) — yoki mavjud `recent_movements` + `sales` `union`.

---

## §2 Implementation sprintlari (variant tasdiqlangach)

**Tanlangan variant uchun (taxmin: 1 hafta):**

- **Sprint v2.1** — `HeroBlock` (savdo + trend chart) + KPI compact strip refactor
- **Sprint v2.2** — Variant'ga mos chain layout (mega-card / pipeline / cockpit)
- **Sprint v2.3** — Yangi widgetlar (`LiveActivityFeed`, `TopProductList`, `StoreRanking`)
- **Sprint v2.4** — Polish + test + a11y

---

## §3 Egadan tasdiqlash savollari

1. **Qaysi variant?**
   - A (Executive Summary First) — analitik fokus, katta trend chart
   - B (Operations Cockpit) — chain mega-card + activity feed
   - C (Story Pipeline) — vertikal zanjir povesti, listlar va charts muvozanatli
   - Yoki **gibrid** (mas. A ning hero + C ning pipeline)?
2. **Live activity feed kerakmi?** (Variant B va C da bor) — `GET /api/dashboard/activity` yangi endpoint.
3. **Vertikal pipeline (C)** kichik ekranlarda **gorizontal** ga o'zgaradimi yoki saqlanadimi?

Tanlasangiz, frontend-engineer + designer parallel implementation boshlaydi.
