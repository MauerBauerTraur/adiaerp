# ADIA ERP — Dashboard MEGA Redesign Plan

> Sana: 2026-05-25
> Muallif: ui-ux-designer (subagent)
> Maqsad: Boshliq (PM) dashboardini "flat shadcn default"dan **dark premium, zanjir-markazli** ERP ko'rinishiga ko'tarish.
> Holat: **Plan** — egasining tasdig'i kerak, kod implementation alohida sprintda.

---

## §0 Tadqiqot xulosa

### A. 10+ zamonaviy dashboard tahlili

| # | Mahsulot | URL | Ustunlik (2-3) | ADIA uchun olib o'tilishi |
|---|---|---|---|---|
| 1 | **Linear** | https://linear.app | LCH color space (perceptual uniform); minimal gradient'siz, glass blur + specular highlight (Liquid Glass); <100ms interaktsiyalar; opacitydan elevation kelib chiqadi | LCH/HSL token sistemi, glass-card uchun blur+gradient overlay pattern, lightning-fast hover; 5 bo'g'in card uchun "ambient highlight" |
| 2 | **Mercury Banking** | https://mercury.com | Lime + black premium fintech palette; balance card markazda gradient; "money first" hierarchy — son eng katta | Hero KPI gradient (bugungi savdo katta currency); fintech-darajadagi son+sparkline ritm |
| 3 | **Stripe Dashboard** | https://dashboard.stripe.com | Tinch kulrang fon + magenta/violet accent; sparkline har KPI'da; skeleton shimmer | Sparkline pattern saqlanadi (allaqachon bor); skeleton shimmer qo'shish |
| 4 | **Vercel Dashboard** | https://vercel.com/dashboard | Pure black bg + tezkor monochrome — deployment status status-pill; geist font; bordered card | Borderless deep-black variant (level-1 surface); tezlik holatining KPI dotlari |
| 5 | **Tremor.so Blocks** | https://blocks.tremor.so | KPI block kataloglari, Tracker bars (rang-kodli statuslar timeline), bar list (top-N), Recharts asosida | Production sex yuklamasi uchun **Tracker bar**; central warehouse 26 blok uchun **bar list** pattern |
| 6 | **PostHog** | https://posthog.com | Custom data-color themes (chart palette ajratish); 6-7 ranglik chart palette tizimli | Chart palette: 5 bo'g'in rangidan birinchi 5 ta data-color sifatida ishlatish |
| 7 | **Retool** | https://retool.com | 2-ranglik qoida: bitta primary brand, bitta accent CTA; tahlilchi-friendly density | Primary cobalt (217°) + warning amber (36°) saqlanadi; aksent qoidasini qattiq qo'llaymiz |
| 8 | **Ramp** | https://ramp.com | Spend dashboard'da timeline cards; "approve/decline" tezkor CTA chiziq | Bizning "Mening harakatim" listga: tezkor approve CTA inline (purchase_order, replenishment) |
| 9 | **Notion** | https://notion.so | Tinch fon + chap minimalist sidebar; ikonkalar sokin emoji-style | Sidebar tartibi (allaqachon bor); icon ritmi |
| 10 | **Tailwind UI Catalyst (Pulse)** | https://catalyst.tailwindui.com | shadcn-darajadagi token cleanliness; "stat" component pattern; ring + offset focus | Focus ring pattern (a11y), stat va divider tokenlari |
| 11 | **Cube.dev playground** | https://cube.dev | OLAP cube dashboard — savdo soatlik heatmap, kun bo'yicha drill-down | Stores soatlik savdo heatmap pattern (bizda `sales.sold_at` bor) |
| 12 | **Geist UI / Vercel design** | https://vercel.com/design | Geist sans; hover'da subtle border lift; loading dot triad | Yuklash holati uchun dot triad; hover micro-elevation |

### B. "Katta zanjir / multi-location ERP" tahlili

| # | Mahsulot | Multi-location pattern | Real-time pattern | Stock-out alert pattern | Bizga olinadi |
|---|---|---|---|---|---|
| 1 | **NetSuite** | Saved Search + portlet dashboard, har location KPI'si alohida tile | Auto-refresh tile + portlet | Severity-coded reorder list (red/yellow/green) | Tile portlet g'oyasi → har bo'g'in detail card mustaqil yangilanadi |
| 2 | **SAP Fiori** | Launchpad tiles, har biri "Top N below-min" KPI ko'rsatadi; semantic colors (Negative/Critical/Positive/Neutral) | Tile-da live counter + delta | Semantic flat tile (red bg, miqdor katta) | Semantik 5 rang qoidasi: ADIA da har bo'g'in o'z aniq ranggi bilan ajratiladi (allaqachon TZ §10) |
| 3 | **Cin7 Core** | "Stock by Location" matrix table (product × location); ranglar bilan health | Webhook-driven dot indicator | Smart routing (eng yaqin warehouse) — colour pinpoint | 5 bo'g'in card-larida "smart route" hint: qaysi bo'g'indan to'ldirish kelishi mumkin |
| 4 | **Lightspeed Retail X** | Top centralized panel + multi-store tabs; KPI lent yuqorida; har store o'z mini-card | Real-time POS feed (sales chart auto-tick) | Reorder point chiziq + alert chip | "Bugun jo'natilgan / Bugun qabul qilingan" oqim ko'rsatkichi (allaqachon TZ data inventoryda) |
| 5 | **Odoo Inventory** | Kanban view of warehouses; har card-da "to do" badge | List + colour badges | Replenishment view ("rules" — automatic) | Kanban-style 5 bo'g'in: har card yopiq+ochiq toggle bilan tafsil panel ochadi |
| 6 | **Shopify POS Pro** | Smart store selector + comparison sparkline | Sales feed live | Inventory threshold + automated PO | Stores card: 6 do'kon mini-sparkline + bugungi summa qatori |

### C. NotebookLM (MCP holati)

**Status: Uzilgan / sxema yuklanmagan.** `mcp__notebooklm__*` toollari sessiya boshida deferred listda ko'rinmadi — server hozir ulanmagan. Shu sabab bu bo'limni planga `research-analyst` keyingi sessiyada qo'shsin (mavzular: "ERP dashboard best practice — bakery/food", "majburiy KPI'lar", "multi-location replenishment cadence").

### Asosiy 5 kashfiyot

1. **Zanjir markazda — ammo yagona katta card emas, balki 5 ta o'zaro bog'langan card.** Egasi eskizidagi "markazda mega card + atrofda detail" idea o'rniga **5 ta nodelar gorizontal chain pattern** (Mercury balance + Linear elevation) eng yaxshi vibe beradi. Markazga bitta katta blok joylash diqqatni bo'sha qiladi; **5 chain card** har biri o'z rangida — yaxlit kompozitsiya.
2. **Premium vibe = qora emas, balki ko'p qatlamli graphite + ambient color glow.** Mercury, Linear, Ramp uchta uchligi: surface'lar pure black emas, ko'p tier (sidebar `#0a0c10` → bg `#0e1014` → card `#181b21` → popover `#1b1e25`). Hozirgi `index.css` da bu allaqachon to'g'ri — lekin **glow / gradient overlay** etishmayapti.
3. **Rang har bo'g'inga rivoyat (narrative) beradi.** Egasining eskizidagi 5 rang (cyan/coral/emerald/amber/violet) — bu shunchaki dekoratsiya emas, **zanjir oqimi vizual hikoyasi**. Har bo'g'in cardda 60% asosiy rang `tint` (15%) + 40% rang glow → ranglar zanjir bo'ylab oqib o'tadi (cyan → red → emerald → amber → violet).
4. **Above-fold 100vh — barcha narsa scrollsiz, lekin nafas oladi.** 1440×900 da 56px header + 220px KPI + 380px 5-bo'g'in zanjir + 220px tezkor harakatlar = ~876px. 1280×720 da KPI 180px, chain 320px, actions 160px — siqilgan ritm.
5. **Tafsil panellari "modal/drawer" emas — inline expand.** Egasi "atrofda har bo'g'inning rang-kodlangan tafsil paneli" desa, bu **chain card click → 7-row inline panel below-fold animatsiya bilan expand** orqali tabiiy. Modaldan ko'ra dashboard ichida qoladi (Odoo Kanban + Linear card expand).

---

## §1 Qisqa xulosa

Hozirgi ExecutiveDashboard "shadcn light default" hissini beradi: ko'p oq fon, kam ierarxiya, ranglar status uchun, vibe yo'q. Mega redesign — **dark-first** (light variant qoladi), **zanjir-markazli kompozitsiya** (5 bo'g'in markazda gorizontal chain), **5 bo'g'in rang-tokenlari** (cyan/coral/emerald/amber/violet ADR-darajada loyiha tokeniga aylanadi), va **ambient depth** (3 tier surface + glow + gradient overlay). Above-fold 100vh ichida butun ekosistema o'qiladi; tafsil panellari inline expandable.

---

## §2 Dizayn yo'nalishi (vibe + palette)

### 2.1 Ranglar nazariyasi — ERP qanday vibe berishi kerak

ADIA ERP boshliqlik kabinetida ishlatiladi — kun bo'yi ochiq turadi. Vibe quyidagi 3 ta qarama-qarshilikni hal qilishi shart:

1. **Authority vs comfort** — qora juda agressiv, kulrang juda sust. Yechim: graphite (`hsl(222 15% 7%)`) — bir oz issiq, neytral, soat suratidagidek calm.
2. **Density vs breath** — ERP information-dense, lekin chiqib turgan KPIga "puls" kerak. Yechim: 5 bo'g'in card-larida 8-12% rang `tint` + 4-6% glow → ko'z bo'g'inni bir necha millisekundda topadi.
3. **Status vs identity** — qizil "below min" alert va red bo'g'in rangi (production = coral) bir-biriga aralashmasligi shart. Yechim: bo'g'in ranglarining `lightness` ni status ranglariga qarshi qutblantirish: production coral 14° (warm red) — destructive 0° (pure red). 14° farq vizual ravishda yetarli.

### 2.2 Yangi palette tokenlari

**Saqlanadigan (asos):** Hozirgi `apps/frontend/src/index.css:18-134` token sistemi yaxshi — graphite + cobalt. Ularni **buzmaslik**, ustiga 5 bo'g'in tokenlarini qo'shish kerak.

**Qo'shiladigan dark mode tokenlari (`index.css:71-124` ichiga):**

```css
/* Chain tokens — har bo'g'in uchun semantik rang */
--chain-raw:        188 85% 50%;  /* cyan-teal — xom-ashyo kirish */
--chain-raw-tint:   188 60% 14%;  /* card bg tint (8-12%) */
--chain-raw-glow:   188 85% 50% / 0.18;  /* ambient glow */

--chain-production: 14 85% 58%;   /* coral — issiq, "olov", sex */
--chain-production-tint:  14 60% 14%;
--chain-production-glow:  14 85% 58% / 0.18;

--chain-supply:     152 60% 48%;  /* emerald — oqim, "yashil oqim" */
--chain-supply-tint:      152 50% 12%;
--chain-supply-glow:      152 60% 48% / 0.18;

--chain-central:    36 95% 56%;   /* amber-gold — markaziy sklad */
--chain-central-tint:     36 60% 14%;
--chain-central-glow:     36 95% 56% / 0.18;

--chain-store:      268 75% 64%;  /* violet — chiqish, savdo */
--chain-store-tint:       268 50% 14%;
--chain-store-glow:       268 75% 64% / 0.18;

/* Surface elevation tiers (allaqachon partially bor — kengaytirish) */
--surface-0: 222 18% 6%;        /* sidebar — eng past */
--surface-1: 222 15% 7%;        /* background */
--surface-2: 220 13% 11%;       /* card — default */
--surface-3: 220 13% 14%;       /* card elevated (hover) */
--surface-4: 220 13% 17%;       /* popover, dropdown */

/* Glow tokens — ambient gradient overlay uchun */
--glow-primary: 217 91% 60% / 0.12;
--glow-success: 152 56% 48% / 0.10;
--glow-danger:  0 84% 60% / 0.14;

/* Border depth */
--border-soft:   220 10% 16%;
--border-strong: 220 10% 22%;
```

**Light mode (kelajakda toggle, hozir secondary)** — har chain rang `lightness` 36% ga tushadi: `--chain-raw: 188 70% 36%` va shunga o'xshash. Tint o'rniga 4% rang `fill`.

### 2.3 Swatch preview (markdown-da text approximation)

| Token | HSL | Approx hex | Vazifasi |
|---|---|---|---|
| `--chain-raw` | `hsl(188 85% 50%)` | ~`#14b8d4` | Xom-ashyo Ombori — sovuq kirish |
| `--chain-production` | `hsl(14 85% 58%)` | ~`#f06a3a` | Ishlab Chiqarish — olov |
| `--chain-supply` | `hsl(152 60% 48%)` | ~`#36b27a` | Ta'minot — oqim |
| `--chain-central` | `hsl(36 95% 56%)` | ~`#f6a623` | Markaziy Sklad — boylik |
| `--chain-store` | `hsl(268 75% 64%)` | ~`#9a64e8` | Do'konlar — chiqish/savdo |
| `--surface-1` (bg) | `hsl(222 15% 7%)` | ~`#0e1014` | Asosiy graphite fon |
| `--surface-2` (card) | `hsl(220 13% 11%)` | ~`#181b21` | Card sirti |
| `--primary` | `hsl(217 91% 60%)` | ~`#3b82f6` | Cobalt CTA |
| `--destructive` | `hsl(0 84% 60%)` | ~`#ef4444` | Below-min alert |
| `--warning` | `hsl(36 96% 56%)` | ~`#f6a623` | Tasdiq kutmoqda (= central rang bilan deyarli teng — **ehtiyot bo'lish kerak**; pastda risk §8) |

### 2.4 Typography hierarchy

| Token | Font / size / weight | Tracking | Ishlatish |
|---|---|---|---|
| `display-2xl` | Inter / 56px / 600 | -0.04em | Hero KPI son (`Bugungi savdo` katta `2.4M`) |
| `display-xl` | Inter / 44px / 600 | -0.03em | KPI sonlar (1440 da), Chain card miqdor |
| `display-lg` | Inter / 32px / 600 | -0.02em | Sub-KPI |
| `text-lg-medium` | Inter / 18px / 500 | -0.01em | Card title |
| `text-base` | Inter / 14px / 400 | 0 | Body |
| `text-sm` | Inter / 13px / 400 | 0 | Secondary |
| `text-xs` | Inter / 12px / 500 | 0.04em uppercase | Label uppercase |
| `text-mono` | JetBrains Mono / 13px | 0 | Raqamlar (tabular-nums) |

**Eslatma:** `tabular-nums` allaqachon hozirgi kodda — saqlanadi.

### 2.5 Surface depth — 3 tier elevation

| Tier | Token | Shadow | Border | Ishlatish |
|---|---|---|---|---|
| **0 — flat** | `surface-2` | none | `1px solid border-soft` | Default Card (allaqachon) |
| **1 — lifted** | `surface-3` | `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.40)` | `1px solid border-strong` | Hover Card, Chain card |
| **2 — floating** | `surface-4` | `0 1px 0 rgba(255,255,255,0.06) inset, 0 24px 60px rgba(0,0,0,0.55)` | `1px solid border-strong` | Popover, DateRangePicker, Tafsil panel |

**Gradient overlay (ambient color):** har chain card-da `background-image: radial-gradient(at 90% 0%, hsl(var(--chain-X-glow)) 0%, transparent 60%)` — yuqori-o'ng burchakdan yumshoq glow.

### 2.6 Border-radius rejimi

| Token | Qiymat | Ishlatish |
|---|---|---|
| `radius-xs` | `6px` | Pill, badge, chip |
| `radius-sm` | `8px` | Button, input |
| `radius-md` | `10px` | Card (default — hozirgi `--radius: 0.625rem`) |
| `radius-lg` | `14px` | Chain card (kattaroq), KPI card |
| `radius-xl` | `20px` | Mega container (zanjir bg block) |

### 2.7 Microinteraktsiya

| Element | Hover | Active | Loading |
|---|---|---|---|
| Chain card | 120ms `border-color`, `surface-2 → surface-3`, glow `opacity 0 → 0.6` | scale 0.99 (50ms) | Skeleton shimmer (`from-muted via-muted/60 to-muted` 1.6s loop) |
| KPI card | 100ms `border-color → primary/40`, son 1px lift (`translateY(-1px)`) | scale 0.99 | Shimmer + son `tabular-nums` "—" |
| Sparkline | Last point pulse (`box-shadow` ring 1.8s) | — | Static dashed line |
| Status dot | 100ms scale 1 → 1.15 | — | "Breathing" ring (2.4s) — faqat `danger` |
| Filter pill | 80ms bg | bg shifts | — |
| Tafsil panel | 240ms `max-height: 0 → auto` + opacity | — | Skeleton 3-row table |

**Eslatma:** Linear "specular highlight" yoki "Liquid Glass" effektiga **kirmaymiz** — bu Faza 3 ehtimoliy improvement. MVP da static gradient + opacity glow yetarli (perf + kod oddiyligi).

---

## §3 Lazyweb / real-product referenslari (5+ aniq URL)

> Lazyweb (lazyweb.com) o'zi 404 berdi (skill API hozir ochiq emas), shu sabab ekvivalent real-mahsulot screenshotlariga ishora qildim. `frontend-engineer` implementation paytida ularni o'z brauzerida ochib referansga ko'rsatishi kerak.

1. **Linear — Inbox & Triage view** — `https://linear.app/now/how-we-redesigned-the-linear-ui` — opacity'dan elevation, accent ring around active row; bizning **Chain card hover state** uchun reference.
2. **Mercury — Account overview** — `https://mercury.com` (logged-in screen marketing pages-da) — katta currency value markazda, sparkline pastida, action button o'ngda; **Hero KPI** uchun.
3. **Vercel — Project deployments dashboard** — `https://vercel.com/dashboard` — status pill ranglari + tezkor deploy CTA; **Critical alerts list item** uchun.
4. **Tremor Blocks — Operations dashboard** — `https://blocks.tremor.so/blocks#operations` — Tracker bars (7 kunlik status), kanban-style metric tile; **Production sex yuklamasi** uchun.
5. **PostHog — Web analytics** — `https://app.posthog.com` (public dashboard) — chart palette tartibi, hover tooltip stil; **Sales chart** uchun.
6. **SAP Fiori — Launchpad** — `https://experience.sap.com/fiori-design-web` (tile gallery) — semantic colored KPI tile; ADIA chain card-larining "data-driven tone" pattern uchun.
7. **Odoo Inventory — Kanban warehouses** — `https://www.odoo.com/app/inventory` (demo screenshots) — kanban view of warehouses with badge counts; **Chain card detail panel toggle** uchun.

`frontend-engineer` ushbu URL-larni ish davomida 2 ekranli setupda o'ng tomonda ochiq tutsin.

---

## §4 Above-the-fold (100vh) layout

### 4.1 ASCII mockup — 1440×900 (desktop, eng asosiy maqsad)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ HeaderStrip 56px                                                                     │
│ Xayrli kun, Akmal Karimov     [ Bugun | Hafta | Oy | 6 oy | 📅 ]    25-may, yakshanba│
│                                                                            13:24:08  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ HeroKpiStrip 220px                                                                   │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                      │
│ │BUGUNGI SAVDO│ │FAOL ZAYAFKA │ │QIZIL POZ.   │ │TASDIQ KUTM. │                      │
│ │             │ │             │ │             │ │             │                      │
│ │   24.6M    │ │   8 / 12    │ │   ●  14     │ │   ●  3      │                      │
│ │   so'm      │ │             │ │  min'dan p. │ │  mendan     │                      │
│ │  ▁▂▃▄▆▇█▇ │ │ vs. kecha   │ │             │ │             │                      │
│ │  +12.4%     │ │             │ │             │ │             │                      │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ChainFlow 380px — 5 bo'g'in gorizontal zanjir, har biri click-expandable             │
│ ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│ │XOM-ASHYO │    │ISHLAB CH.│    │TA'MINOT  │    │MARKAZIY  │    │DO'KONLAR │         │
│ │ ombori   │ →  │ 4 sex    │ →  │ 1 markaz │ →  │ 26 blok  │ →  │ 6 do'kon │         │
│ │ (cyan)   │    │ (coral)  │    │ (emerald)│    │ (amber)  │    │ (violet) │         │
│ │          │    │          │    │          │    │          │    │          │         │
│ │ 378 SKU  │    │ 8 zayafka│    │ 142 SKU  │    │ 1,254 SKU│    │ 248 SKU  │         │
│ │ ● 5 min<│    │ ● 2 muddat│    │ ● me'yor │    │ ● 7 min< │    │ ● 14 min<│         │
│ │          │    │          │    │          │    │          │    │          │         │
│ │ Bugun    │    │ Bugun    │    │ Bugun    │    │ Poster   │    │ Bugun    │         │
│ │ qabul:   │    │ chiqdi:  │    │ jo'natdi:│    │ sync:    │    │ savdo:   │         │
│ │ 42 kg    │    │ 320 dona │    │ 380 dona │    │ 3 daq.   │    │ 24.6M    │         │
│ │ chiqdi:  │    │ tugatdi: │    │ qabul:   │    │ oldin    │    │ ▁▃▅▇█▆▄▂│         │
│ │ 38 kg    │    │ 5 zay.   │    │ 320 dona │    │ ✓ ok     │    │          │         │
│ │          │    │          │    │          │    │          │    │          │         │
│ │  [▸ ko'r] │    │  [▸ ko'r] │    │  [▸ ko'r] │    │  [▸ ko'r] │    │  [▸ ko'r] │         │
│ └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ QuickActionsRow 220px — 2 ustun                                                      │
│ ┌────────────────────────────────────┐  ┌────────────────────────────────────────┐   │
│ │ Mening harakatlarim (3+2=5)        │  │ Tezkor ogohlantirishlar                │   │
│ │ ────────────────────────────────── │  │ ────────────────────────────────────── │   │
│ │ ● PO #128 Un yetkazib beruvchi     │  │ ● Tort sex — Sevgi (tugamoqda 2 kun)   │   │
│ │   2.4M  [Tasdiqlash] [Rad etish]   │  │ ● Do'kon 3 — Shokoladli (0 dona)       │   │
│ │ ● Replenish R#42 Do'kon 5          │  │ ● PO #131 muddat o'tdi (1 kun)         │   │
│ │   120 dona  [Tasdiqlash]           │  │ ● Poster sync xato (15 daq oldin)      │   │
│ │ ● PO #129 Tuxum 80k...             │  │                                        │   │
│ │   [Barchasini ko'rish →]           │  │   [Hammasini ko'rish →]                │   │
│ └────────────────────────────────────┘  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────┘

Jami: 56 + 12gap + 220 + 12gap + 380 + 12gap + 220 = ~912px ≈ 100vh@900px (toza fit)
```

### 4.2 ASCII mockup — 1280×720 (kichikroq laptop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HeaderStrip 48px                                                         │
│ Xayrli kun, Akmal  [Bugun|Hafta|Oy|6 oy|📅]   25-may 13:24               │
├──────────────────────────────────────────────────────────────────────────┤
│ HeroKpiStrip 180px (4 card siqilgan)                                     │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │SAVDO 24.6M│ │ZAY. 8/12 │ │QIZIL 14 ●│ │TASDIQ 3 ●│                      │
│ │ ▁▂▃▄▆▇█  │ │ vs.kecha │ │ min<     │ │ mendan   │                      │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                      │
├──────────────────────────────────────────────────────────────────────────┤
│ ChainFlow 320px (kichikroq, son+status faqat)                            │
│ ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐                              │
│ │XOM  │→ │PROD │→ │SUPP │→ │CENT │→ │STORE│                              │
│ │378  │  │8 zay│  │142  │  │1254 │  │248  │                              │
│ │● 5  │  │● 2  │  │● ok │  │● 7  │  │● 14 │                              │
│ │qabul│  │chiqdi│  │jo'n.│  │sync │  │24.6M│                              │
│ │42kg │  │320  │  │380  │  │3'   │  │▁▃▅▇█│                              │
│ │[▸]  │  │[▸]  │  │[▸]  │  │[▸]  │  │[▸]  │                              │
│ └─────┘  └─────┘  └─────┘  └─────┘  └─────┘                              │
├──────────────────────────────────────────────────────────────────────────┤
│ QuickActionsRow 160px (siqilgan)                                         │
│ Mening harakatlarim (5) │ Tezkor ogohlantirishlar (4)                    │
│ ● PO #128 ...            │ ● Tort sex Sevgi 2 kun                        │
│ ● R#42 ...               │ ● Do'kon 3 Shokoladli 0                       │
│ [Barchasi →]             │ [Hammasi →]                                   │
└──────────────────────────────────────────────────────────────────────────┘

Jami: 48 + 8 + 180 + 8 + 320 + 8 + 160 = 732px (~720vh — siqilgan, lekin chiqib ketmaydi)
```

### 4.3 Layout rules

- **Outer container:** `max-w-[1440px] mx-auto px-6 py-4` — keng monitorlarda yaxlit.
- **Vertical rhythm:** `gap-3` (12px) above-fold; `gap-6` below-fold.
- **Grid:** Chain card `grid-cols-5 gap-3` ≥`lg`, `grid-cols-2 gap-2` <`lg`, `grid-cols-1` <`sm`.
- **Sidebar:** allaqachon `Sidebar` mavjud (`apps/frontend/src/components/Sidebar.tsx` — alohida tekshiriladi) — `w-60` (240px) — content `calc(100vw - 240px)`.

---

## §5 Below-fold tafsil panellari — expand vs scroll

### 5.1 Tavsiya: **inline expand below chain row**

Egasi "atrofda har bo'g'inning tafsil paneli" idea bergan edi — `markazda mega card + 4 yon panel` literal interpretatsiya **layout cheklovga uchraydi**: 1440×900 da har panelga 240px qoladi, son va chart sig'maydi. Shu sabab quyidagi pattern tavsiyalanadi:

**Pattern:** Chain card-ga click qilinganda — **u tanlangan card markered** + below-fold qismi `380px` balandlikda `expand` qilinadi, tanlangan bo'g'in tafsil paneli (4 sub-card + 1 chart) joylanadi. Boshqa chain card-ga click — panel content **fade-swap** (220ms).

**Afzalliklar:**
- Layout ChainFlow kompozitsiyani buzmaydi.
- Tafsillar to'liq kenglikda (1440px) — chart va table'ga joy.
- "Modal feel" yo'q — dashboard ichida qoladi.
- Klaviatura: chain card-ni `Tab` orqali kezish, `Enter` orqali expand toggle.

**Alternativa:** literal "atrof panel" — faqat ultra-wide (≥1920px) variantida — chain card markazda 480px, 4 ta yon panel chap+o'ngda 240px har biri. Bu **Faza-2** sifatida qoldiriladi.

### 5.2 Tafsil panel kontenti (har bo'g'in uchun)

**Raw Warehouse (cyan):**
- 4 sub-card: ostatka (kg/l), qabul kutilmoqda (yo'lda), bugun qabul/chiqim, min'dan past N
- Chart: 7 kunlik ostatka chizig'i (Recharts area, cyan stroke + tint fill)
- Inline table: min'dan past 5 mahsulot (`qty | min | manageriga signal` chip)

**Production (coral):**
- 4 sub-card: faol zayafka, bugun tugatildi, muddat o'tgan, sex yuklama
- Tracker bar: 7 kun × 4 sex grid (Tremor-style, har kun coral/amber/red)
- Inline list: faol 5 zayafka (`product | deadline | progress bar`)

**Supply (emerald):**
- 4 sub-card: joriy qoldiq, bugun kirim, bugun jo'natma, ochiq so'rovlar
- Chart: kirim (production_output) vs chiqim (transfer) ikki-chiziq
- List: do'kon bo'yicha bugungi jo'natma top-5

**Central Warehouse (amber):**
- 4 sub-card: bloklar (26), Poster sync holati, min'dan past, oxirgi sync
- Chart: bloklar bo'yicha qoldiq taqsimoti (horizontal bar, top-10)
- List: Poster sinxron xatolari (24h) — `error_detail` + retry CTA

**Stores (violet):**
- 4 sub-card: bugungi savdo (so'm), cheklar soni, o'rtacha chek, eng faol do'kon
- Chart: 6 do'kon × 24 soat heatmap (Cube.dev pattern); yoki agregat: 6 sparkline
- List: 6 do'kon mini-card (savdo, chek, ochiq so'rov)

### 5.3 Empty / loading / error

| Holat | Pattern |
|---|---|
| Loading initial | Skeleton chain row (5 ta `surface-2` placeholder, shimmer) |
| Loading expand | Sub-card 4 skeleton + chart skeleton |
| Empty data | Card ichida `"Hozircha ma'lumot yo'q"` + bo'g'in iconi muted (allaqachon hozirgi `SecondaryRowGuard`da bor) |
| Error | Inline `ErrorState` qatori chain card ichida; whole-page xato — `HeaderStrip` qoladi, ostiga `ErrorState` |
| Stale (>2 daqiqa refresh yo'q) | Yuqori-o'ng burchakda `●` amber dot + tooltip "Sinxron 2 daq oldin" |

---

## §6 Komponent inventari

| # | Komponent | Vazifa | Props (TS shape) |
|---|---|---|---|
| 1 | `ChainFlowRow` | 5 bo'g'in zanjir konteyner; tanlangan + expanded holat | `{ nodes: ChainNode[]; selectedType: LocationType \| null; onSelect(t): void; expanded: boolean }` |
| 2 | `ChainCard` | Bitta bo'g'in summary card | `{ type: LocationType; tone: 'raw'\|'production'\|'supply'\|'central'\|'store'; summary: ChainSummary; status: 'ok'\|'warn'\|'danger'; selected: boolean; onClick(): void }` |
| 3 | `ChainArrow` | Card orasidagi `→` (kompozitsion gluon) | `{ active: boolean }` |
| 4 | `ChainDetailPanel` | Expand below-fold paneli (bo'g'in tafsili) | `{ type: LocationType; tone: ChainTone; data: DetailData; isLoading: boolean }` |
| 5 | `KpiHero` (mavjud HeroKpiStrip qayta brending) | 4 ta katta KPI | (mavjud `HeroKpiCard[]` — props o'zgartirilmaydi) |
| 6 | `ActionListPanel` | "Mening harakatlarim" (PO + Replenishment) | `{ items: ActionItem[]; onApprove(id): void; onReject(id): void; emptyText: string }` |
| 7 | `AlertsTickerPanel` | "Tezkor ogohlantirishlar" (real-time feed) | `{ alerts: AlertItem[]; maxVisible: number; onItemClick(id): void }` |
| 8 | `StatusDot` | Reusable `ok/warn/danger` dot, optional "breathing" pulse | `{ status: 'ok'\|'warn'\|'danger'; pulse?: boolean; label?: string }` |
| 9 | `MetricNumber` | `display-2xl` son + `tabular-nums` + tone | `{ value: number\|string; tone?: KpiTone; suffix?: string; size?: '2xl'\|'xl'\|'lg' }` |
| 10 | `MiniSparkline` (mavjud `Sparkline` brendlash) | 14-30 nuqtali sparkline | `{ values: number[]; tone: KpiTone; height?: number }` |
| 11 | `GlowCard` | Card + radial gradient overlay tokenidan | `{ tone: ChainTone\|'primary'; elevation: 0\|1\|2; children: ReactNode }` |
| 12 | `TrackerBar` (yangi, Tremor-stil) | 7 kun × N sex status grid | `{ rows: { label: string; days: ('ok'\|'warn'\|'danger'\|'empty')[] }[] }` |
| 13 | `HourlyHeatmap` (do'konlar uchun) | 7 kun × 24 soat heatmap | `{ matrix: number[][]; max?: number; tone: ChainTone }` |
| 14 | `BlockBarList` (markaziy sklad uchun) | Horizontal bar list top-10 | `{ items: { id: string; label: string; value: number; tone?: ChainTone }[]; total: number }` |
| 15 | `SyncStatusBadge` | Poster sync holati (vaqt + status) | `{ lastSyncAt: string; status: 'ok'\|'partial'\|'failed'; errorsLast24h: number }` |

**Saqlanadi:** `HeaderStrip`, `DateRangeFilter`, `HeroKpiStrip`, `MyActionsList`, `CriticalAlerts`, `EcosystemHealthBar` — yangi `ChainFlowRow` ekvivalent katta brending bilan; `EcosystemHealthBar` `ChainFlowRow` ga `evolve` qilinadi (rename emas — qayta tuziladi).

**O'chiriladi yoki rebrending:** `DashboardSecondaryRow` — uning content'i `ChainDetailPanel` ga ko'chadi; standalone secondary row endi kerak emas.

---

## §7 Implementation sprint breakdown

> Bu MEGA redesign — kichik sprintlarga bo'lib, har birida vizual ko'chish bor.

### Sprint A — "Token foundation" (S/M, ~1 kun)
**Maqsad:** rang + surface + glow tokenlari `index.css` ga, Tailwind config ga aksent qo'shish.

| Task | Agent | Size |
|---|---|---|
| A1 — `index.css` ga 5 chain token (DEFAULT/tint/glow) + 5 surface tier qo'shish | frontend-engineer | S |
| A2 — `tailwind.config.js` da `colors.chain.{raw,production,supply,central,store}` extend | frontend-engineer | S |
| A3 — `lib/chainTokens.ts` (TS type + reverse-map `LocationType → ChainTone`) | frontend-engineer | S |
| A4 — Visual sanity check (`/dashboard` da rang token swatch debug page) | frontend-engineer + designer review | S |

### Sprint B — "Chain flow row" (M, ~2 kun)
**Maqsad:** 5 bo'g'in zanjir card + `ChainArrow` + status dot + expand selected state. `EcosystemHealthBar` o'rniga ChainFlowRow.

| Task | Agent | Size |
|---|---|---|
| B1 — `ChainCard` komponent (props, hover, selected, tone) + Storybook (yoki test fixture) | frontend-engineer | M |
| B2 — `ChainArrow` + `ChainFlowRow` containerdan 5 cardni mapping | frontend-engineer | S |
| B3 — `GET /api/dashboard/ecosystem` data fitting → `ChainSummary` shape (backend hozirgi `DashboardChainNode` aggregate qiladi) | backend-engineer | M |
| B4 — `ExecutiveDashboardPage` da `EcosystemHealthBar` o'rniga `ChainFlowRow` qo'yish | frontend-engineer | S |
| B5 — Unit + interaction test (`ChainCard click → selected`, a11y `role=button`, keyboard `Enter`) | qa-engineer | M |

### Sprint C — "Detail panel + expand" (M/L, ~3 kun)
**Maqsad:** Tanlangan card → below-fold inline panel. Har 5 bo'g'in uchun o'z `Detail<X>Panel` komponenti.

| Task | Agent | Size |
|---|---|---|
| C1 — `ChainDetailPanel` shell (tone, transition, loading skeleton, error) | frontend-engineer | M |
| C2 — 5 ta `Detail<X>Panel` komponent (4 sub-card + chart + list) — har biri o'z endpoint'i | frontend-engineer | L |
| C3 — Backend endpoint'lar: `/api/dashboard/raw`, `/production`, `/supply`, `/central`, `/stores` — chain detail har biri uchun | backend-engineer | L |
| C4 — `TrackerBar`, `HourlyHeatmap`, `BlockBarList` reusable komponentlar | frontend-engineer | M |
| C5 — Visual + a11y test, Recharts color binding (chain tone, screen reader text) | qa-engineer | M |

### Sprint D — "Hero polish + risklar tuzatish" (S/M, ~1.5 kun)
**Maqsad:** KPI strip refresh (`MetricNumber`, sparkline glow), warning vs central rang to'qnashuvini hal qilish, light mode parity (tokenlar bor — kontrast tekshiruvi), accessibility AA majburiy.

| Task | Agent | Size |
|---|---|---|
| D1 — `MetricNumber` + sparkline glow update | frontend-engineer | S |
| D2 — `--warning` ni 36° dan 28° ga siljitish (central amber 36° dan ajraltirish) + WCAG kontrast re-test | designer + frontend-engineer | S |
| D3 — Light mode token parity (5 chain rang light variant) | designer + frontend-engineer | S |
| D4 — Manual accessibility audit (axe + keyboard) — barcha `ChainCard`, panel, KPI | qa-engineer | M |
| D5 — Browser test (Chrome DevTools MCP) — 1440×900, 1280×720, 1024×768 screenshot | qa-engineer | S |

**Umumiy:** ~7.5 kun (Faza-1 sprint sifatida). Parallel ishlash: A → B+C3 (parallel) → C → D.

---

## §8 Risklar va o'lcham

| # | Risk | Ehtimol | Effect | Mitigatsiya |
|---|---|---|---|---|
| 1 | `--warning` 36° va `--chain-central` 36° rang to'qnashuvi — alert va central bo'g'in farqlanmaydi | yuqori | yuqori | `--warning` ni 28° ga (warm orange) ko'chirish — D2 vazifasi. Test: ikkalasini yonma-yon ko'rsatish; ko'r-sinov |
| 2 | `production` (coral 14°) va `destructive` (red 0°) yaqin — below-min alert production card-da chalkash bo'ladi | o'rta | o'rta | Alert dotni production card ichida **outline white ring** bilan ajraltirish (`box-shadow: 0 0 0 1px white`) |
| 3 | 5 chain card 1280px da siqilib son ko'rinmaydi | o'rta | yuqori | <1280px da `grid-cols-2` ga o'tish, `font-size: text-xl` ga tushish (4.2 ASCII) |
| 4 | Gradient overlay perf — har card-da radial gradient = 5 ta paint layer | past | o'rta | `will-change: opacity` faqat hover'da; gradient `background-image` cache; Lighthouse Performance ≥90 maqsad |
| 5 | Backend `/api/dashboard/raw|production|...` endpointlari hozir mavjud emas | yuqori | yuqori | C3 da yangi endpointlar; `dashboard-data-inventory.md` da formula tayyor — Sprint A boshidan backend bu yo'lda |
| 6 | Light mode kontrast bug — `--chain-X-tint` light bg da ko'rinmaydi | o'rta | past | D3 da tint qiymatlari `lightness 90%` ga (light bg uchun); WCAG 4.5:1 check |
| 7 | `EcosystemHealthBar` ni o'chirish — boshqa joydan ishlatilsa break bo'ladi | past | past | grep `EcosystemHealthBar` import qilinishini tekshirish — faqat ExecutiveDashboard ishlatadi (`apps/frontend/src/pages/dashboard/executive/ExecutiveDashboardPage.tsx:19`) |
| 8 | 5 detail panel = 5 ta yangi endpoint = backend ish katta | yuqori | o'rta | MVPda 5 ta detail panel **mavjud `/api/dashboard/overview` va `/ecosystem` ichidan** qisman to'ldirish (placeholder). Detail-specific endpoint Sprint C3 dan keyin to'liq |
| 9 | Owner "creative palette" deganda 5 ranggi yetarli emasligini his qilishi mumkin | past | o'rta | Sprint A oxirida live `/dashboard?theme-preview=1` route, owner ko'rib tasdiqlaydi (egaga sample link yuboriladi) |
| 10 | Faza-1 sprint scope creep — "expand panel"ga endpoint qo'shilishi | yuqori | yuqori | Sprint C ni alohida MR-larga bo'lish; B sprint vizual MVP yetarli bo'lib chiqishi mumkin |

**O'lchov (acceptance KPI):**
- Lighthouse Performance ≥ 90; A11y ≥ 95 (`/dashboard` 1440×900 da)
- TTI < 1.5s shadcn theme bilan (lokal)
- Tab order: HeaderStrip → DateRangeFilter → KPI×4 → ChainCard×5 → Actions → Alerts (deterministic)
- Egasining sub'ektiv "vibe" reaktsiyasi: "ha, bu ERP" — Sprint A demo'dan keyin so'raymiz.

---

## §9 Egadan kerakli tasdiqlash savollari

> Bu javoblarsiz Sprint A ham boshlanmaydi.

1. **5 chain rang tasdiq?** Cyan (raw) → Coral (production) → Emerald (supply) → Amber (central) → Violet (store). Eskizdagi cyan/red/emerald/amber/violet bilan deyarli mos — `red` ni `coral 14°` ga siljitdim (destructive bilan to'qnashmaslik uchun). **O'zgartirish kerakmi?**

2. **Above-fold prioritet:** 1440×900 da `KPI 220px + Chain 380px + Actions 220px = ~912px`. Agar `Actions` row 220px o'rniga `160px` ga tushadigan bo'lsa **kontent kamayadi** — tezkor `Mening harakatlarim` 3 ta o'rniga 2 tagacha qoladi. **Qabul qilamizmi yoki Chain ni 340px ga siqamizmi?**

3. **Detail panel pattern: inline expand (tavsiya) vs modal drawer.** Inline expand = dashboard ichida qoladi, ammo 380px qo'shimcha balandlik kerak. Drawer = above-fold buzilmaydi, lekin "modal feel". **Qaysi bermi?**

4. **`EcosystemHealthBar` ni o'chirish va `ChainFlowRow` bilan almashtirish.** Hozirgi `EcosystemHealthBar` ko'p egilgan (5 pill, status dot, kichik) — biz uni "evolve" qilamiz, alohida `Card` parent saqlanadi. **Eski test fayllari (`EcosystemHealthBar.test.tsx`) o'chirilsinmi yoki qayta migration?**

5. **Light mode prioriteti.** Hozir `index.css:18` light mode default. Egasi "dark premium" deganda **dark default**ga o'tamizmi (`<html class="dark">` index.html da), yoki light + dark ikkalasi parallel saqlansinmi (toggle)? Bu Sprint D ga ta'sir qiladi.

---

## Manbalar (file:line)

- TZ talablar: `docs/TZ.md:14`, `docs/TZ.md:85`, `docs/TZ.md:94`, `docs/TZ.md:209`, `docs/TZ.md:272`, `docs/TZ.md:301`
- Data inventari: `docs/dashboard-data-inventory.md:1-273`
- Hozirgi token tizimi: `apps/frontend/src/index.css:18-134`
- Tailwind extend: `apps/frontend/tailwind.config.js:1-88`
- Asosiy dashboard sahifa: `apps/frontend/src/pages/dashboard/executive/ExecutiveDashboardPage.tsx:1-263`
- KPI strip: `apps/frontend/src/pages/dashboard/executive/HeroKpiStrip.tsx:53-277`
- Hozirgi chain bar: `apps/frontend/src/pages/dashboard/executive/EcosystemHealthBar.tsx:104-173`
- HeaderStrip: `apps/frontend/src/pages/dashboard/executive/HeaderStrip.tsx:29-62`
- DateRangeFilter: `apps/frontend/src/components/DateRangeFilter.tsx:63-247`
- Arxitektura qarorlari: `docs/architecture/decisions.md` (Poster POS sinxronizatsiya qoidalari)

---

## Xulosa

Bu plan **kod yozmaydi** — u 5 ta sprintga bo'lingan, har biri vizual demonstrable. Egasining 5 ta savoliga javob kelgach (yuqorida §9), Sprint A boshlanadi: token foundation. Sprint A natijasi — `/dashboard` ochilganda yangi ranglar swatch ko'rinishi va owner "vibe check" qilishi mumkin bo'lgan minimal artefakt.

Mega redesign **incremental** ravishda ishga tushadi — har Sprint mustaqil MR/commit, har biri o'zgarishlar ko'rinadigan demo. Risk §8.10 (scope creep) eng katta tahdid; har Sprint qattiq scope-locked.

---

## §10 Egasining qarorlari (2026-05-25, tasdiqlangan)

1. ✅ **5 chain rang qabul:** cyan / coral / emerald / amber / violet — designer tavsiyasi to'liq qabul qilindi. Coral 14° (red 0° emas) — destructive bilan to'qnashmaslik uchun.
2. ✅ **Above-fold balansi:** **Quick actions 220px qoldiriladi** (Mening harakatlarim + Tezkor ogohlantirishlar — ustuvor); ChainFlow 380px → **340px** ga siqiladi. Yangi summa: 56 + 220 + 340 + 220 = 836px (≤ 900px).
3. ✅ **Tafsil paneli pattern:** **Side drawer (chap/o'ngdan)** — inline expand emas, modal drawer ham emas. Drawer card click → o'ngdan slide-in, sahifaga 480-560px egallaydi, asosiy dashboard arqada qoladi. Implementation: `Sheet` komponent (`apps/frontend/src/components/ui/sheet.tsx` allaqachon mavjud).
4. **`EcosystemHealthBar` test fayli** — owner aniq javob bermadi. Team lead qaror: **eski test fayllarini o'chirish va `ChainFlowRow` uchun yangi test yozish** (rebrand emas — to'liq qayta tuzish). Sprint B5 da yangi `ChainFlowRow.test.tsx`.
5. ✅ **Dark default qaytarilsin:** `<html class="dark">` qaytariladi, light mode toggle Sprint D ga ko'chiriladi. Hozirgi light palette `:root` da `.dark` ostida o'lchashtirilgan — switch toza. Sprint A da `index.html` va `meta color-scheme` ham `dark` ga qaytariladi.

### Sprint C uchun ta'sir
- §5 da "inline expand" tavsiya etilgan edi — endi **side drawer** ga o'zgartiriladi. `ChainDetailPanel` o'rniga `ChainDetailSheet` (Sheet wrapped). Above-fold buzilmaydi, drawer tashqarisi qoraytadi (overlay `bg-black/60`). Drawer tonal: tanlangan chain rang bilan border + glow.

### Sprint A boshlash uchun yo'l ochiq.
