# ADIA ERP — Onboarding (sozlash va ishni boshlash qo'llanmasi)

Salom va xush kelibsiz! 👋

Bu hujjat sizni **ADIA ERP** loyihasiga ulashda yo'naltiradi. Loyihada **Claude Code multi-agent jamoasi** bilan ishlaymiz — bir nechta maxsus AI agentlar (backend, frontend, designer, QA va boshqalar) va ulardan iborat **team lead** sizning vazifalaringizni rejalashtirib, taqsimlab, hisobot beradi.

Quyidagi qadamlarni tartib bilan bajaring. Bir martalik sozlash 20–40 daqiqa oladi.

---

## 0. Loyiha haqida qisqacha

ADIA ERP — non/tort/qandolat ishlab chiqarish va ta'minot zanjiri uchun **o'zini-o'zi to'g'rilaydigan ERP** tizimi. Zanjir: xom-ashyo ombori → ishlab chiqarish → ta'minot bo'limlari → markaziy sklad → do'konlar. Savdo va ombor ma'lumotlari **Poster POS** dan sinxronlanadi. Eng tepada — AI assistant.

**Bitta kompaniya** uchun (multi-tenant emas).

Avval o'qib chiqing (10–15 daqiqa):
1. [`README.md`](../README.md) — umumiy ko'rinish
2. [`CLAUDE.md`](../CLAUDE.md) — loyiha qoidalari, jamoa, workflow, til
3. [`docs/TZ.md`](TZ.md) — texnik topshiriq
4. [`docs/architecture/decisions.md`](architecture/decisions.md) — qabul qilingan asosiy qarorlar

---

## 1. Kerakli vositalar (kompyuteringizda bo'lsin)

| Vosita | Tavsif | Yuklab olish |
|---|---|---|
| **Node.js ≥ 18** | Backend va MCP serverlar uchun | https://nodejs.org · yoki `nvm install --lts` |
| **Git** | Versiya nazorati | `apt install git` / Mac brew / Windows installer |
| **Google Chrome** | NotebookLM auth uchun zarur | https://google.com/chrome |
| **Claude Code** | Asosiy ish muhiti | https://claude.com/code |
| **Code editor** | VS Code, Cursor yoki shunga o'xshash | https://code.visualstudio.com |
| **Google hisob** | NotebookLM uchun | (mavjud bo'lsa, yangi qilish shart emas) |
| **Figma hisob** | UI/UX agent uchun | https://figma.com |

> Linux foydalanuvchilar uchun: NotebookLM birinchi auth grafik muhit talab qiladi. Headless server bo'lsa — `xvfb-run` ishlatasiz.

---

## 2. Loyihani olish

Repo manzilini **team lead** beradi (hozircha private). Olgandan keyin:

```bash
git clone <repo-url> adia-erp
cd adia-erp
```

Yoki ZIP/papka olgan bo'lsangiz:

```bash
cd "ADIA ERP"
```

Verifikatsiya:

```bash
ls .claude/agents/         # 8 ta agent ko'rinishi kerak
ls .claude/skills/ | wc -l # 28
```

---

## 3. `.env` faylini tayyorlash (maxfiy kalitlar)

```bash
cp .env.example .env
```

`.env` ni oching va to'ldiring:

- `POSTER_ACCOUNT=adia` — qoldiring
- `POSTER_APP_ID=4884` — qoldiring
- `POSTER_APP_SECRET=...` — **team lead'dan oling** (`.env` git'ga tushmaydi, sizning faylingiz lokal)
- `POSTER_TOKEN=...` — ikkita variantdan biri:
  - **Tavsiya:** team lead'dan tayyor tokenni so'rang.
  - Yoki o'zingiz yarating (Poster admin'ga kirishingiz bo'lsa): `https://adia.joinposter.com` → **Доступ → Интеграции → "+ Yangi token"** → format: `<akkaunt>:<32-hex>`.
- Boshqa o'zgaruvchilar (`DATABASE_URL`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`) — Faza 1 ish boshlanganda team lead beradi.

⚠️ `.env` git'ga **yuklanmaydi** va hech kimga yuborilmaydi. Maxfiy.

---

## 4. Claude Code'ni ochish

Loyiha papkasida terminal oching va:

```bash
claude
```

Yoki IDE plugin (VS Code/Cursor) orqali ushbu papkani oching.

Sessiya ochilganda quyidagilar avtomatik yuklanadi:
- `CLAUDE.md` (loyiha qoidalari)
- `.claude/agents/` (8 agent)
- `.claude/skills/` (28 skill)
- `.claude/commands/` (7 slash-command)
- Session-start hook (skill eslatmasi)

---

## 5. MCP serverlarni tasdiqlash (bir martalik)

Birinchi sessiyada Claude Code 3 ta MCP serverga ishonish so'raydi. Hammasini **tasdiqlang**:

| MCP | Vazifa |
|---|---|
| `notebooklm` | Bilim bazasi / "xotira" — grounded javoblar |
| `agentation` | Frontend vizual feedback (siz UI'ni annotatsiya qilasiz) |
| `chrome-devtools` | Brauzerda jonli test |

Tekshirish:

```
/mcp
```

`figma` ham ro'yxatda ko'rinadi (global plugin sifatida).

---

## 6. NotebookLM auth (bir martalik)

NotebookLM — jamoaning bilim bazasi. Kirish shunday:

Claude Code'da yozing:

> NotebookLM auth qil — `setup_auth` toolini ishga tushir.

Chrome oynasi ochiladi → **Google hisobingiz bilan kiring** → 10 daqiqa ichida tugating. Profil saqlanadi (`~/.local/share/notebooklm-mcp/`), keyingi safarlar avtomatik.

**Headless Linux'da:** birinchi auth uchun `xvfb-run` ishlating; keyin to'liq headless.

---

## 7. Figma auth (bir martalik)

```
/mcp
```

Ro'yxatdan `figma` ni tanlab autentifikatsiyadan o'ting. UI/UX agent dizayn fayllariga kirish uchun ishlatadi.

---

## 8. Agentation (frontend vizual feedback)

Sizga UI'da nimadir noto'g'ri ko'rinsa, brauzerda elementni **annotatsiya** qilasiz va agent aniq kontekst oladi (CSS selector, fayl yo'li, komponent).

- **MCP server** `.mcp.json` da sozlangan (port 4747). Birinchi ishga tushganda npx avtomatik yuklaydi.
- **Brauzer kengaytmasi / desktop app:** https://www.agentation.com/install — yuklab oling.
- **Frontend kodga ulash** — frontend skeleti (Faza 1) tayyor bo'lganda team lead ko'rsatadi:
  ```jsx
  // dev rejimda
  import { Agentation } from "agentation";
  <Agentation endpoint="http://localhost:4747" />
  ```

---

## 9. Tekshiruv — hammasi joyidami?

Claude Code'da quyidagilarni yozing va natijani tekshiring:

| Buyruq | Kutilgan natija |
|---|---|
| `/agents` | 8 ta agent: `system-architect`, `backend-engineer`, `frontend-engineer`, `ui-ux-designer`, `qa-engineer`, `code-reviewer`, `research-analyst`, `market-analyst` |
| `/mcp` | 4 ta server: `notebooklm`, `agentation`, `chrome-devtools`, `figma` |
| `/help` yoki `/` | 7 command: `/spec` `/plan` `/build` `/test` `/review` `/code-simplify` `/ship` |
| `ls .claude/skills/` | 28 ta papka |

Birortasi yo'q bo'lsa — sessiyani qayta ishga tushiring (`exit` va qaytadan `claude`).

---

## 10. Ish jarayoni — biz qanday ishlaymiz

Claude **team lead** rolida — sizni eshitadi, reja tuzadi, agentlarga taqsimlaydi, hisobot beradi.

```
1. Siz vazifa berasiz
2. Team lead reja yuboradi  ← siz ko'rib chiqasiz
3. Siz tasdiqlaysiz (yoki o'zgartirish so'raysiz)
4. Agentlar parallel ishlaydi
5. code-reviewer natijani tekshiradi
6. Team lead yakuniy hisobot yuboradi
7. Siz tasdiqlaysiz → keyingi qadam
```

⚠️ **Qaytarib bo'lmaydigan amallar** (deploy, ma'lumot o'chirish, `git push`, tashqi xizmatga yuborish) — **tasdiqsiz** bajarilmaydi. Bu qoida.

Domen invariantlari (masalan: ostatka hech qachon manfiy bo'lmaydi; bitta `(product, location)` ga bitta ochiq request) — buzilmaydigan. Agar agent buni buzmoqchi bo'lsa — to'xtatib, team lead'ga signal beradi.

---

## 11. Til qoidalari

- **Claude bilan suhbat** — o'zbek tilida (lotin yozuvi).
- **Kod, izoh, commit xabarlari, identifikatorlar** — ingliz tilida.
- **UI matni** — o'zbek tilida; raqam/sana mahalliy formatda.

Domen atamalari kodda inglizcha ekvivalent oladi (`zayafka → production_order`, `ostatka → stock/qty`, `do'kon → store`, `bo'g'in → location`).

---

## 12. Foydali misol-buyruqlar

- "Faza-1 spec'ni ko'rsat" — `docs/architecture/` ni o'qib beradi.
- "/plan replenishment engine" — vazifani parchalaydi.
- "/spec stock-movement endpoint" — yangi modul spec.
- "/review" — so'nggi o'zgarish review.
- "/test PostgreSQL transaction atomicity" — test strategiya.
- "Poster API'da `dash.getTransactions` qanday ishlaydi?" — research-analyst NotebookLM'dan grounded javob beradi.
- "Bugungi UI feedback'larni ko'r" — agentation annotatsiyalarini oladi (`agentation_get_all_pending`).
- "/agents" / "/mcp" — sozlamani tekshirish.

---

## 13. Birinchi vazifa

Onboarding tugagach team lead'ga ayting:

> Tayyorman. Joriy holat va birinchi vazifani ko'rsating.

Hozirgi joriy holat: **Faza 0 (jamoa infratuzilmasi) tugagan; Faza-1 (MVP) spec ishlanmoqda.** Batafsil: [`CLAUDE.md`](../CLAUDE.md) §11 va [`docs/architecture/decisions.md`](architecture/decisions.md).

---

## 14. Foydali papkalar va fayllar

| Joy | Nima bor |
|---|---|
| [`README.md`](../README.md) | Loyiha umumiy ko'rinishi |
| [`CLAUDE.md`](../CLAUDE.md) | Loyiha qoidalari, jamoa, workflow, til, domen invariantlari |
| [`docs/TZ.md`](TZ.md) | Texnik topshiriq |
| [`docs/SETUP.md`](SETUP.md) | Texnik sozlash qadamlari (qisqa) |
| [`docs/architecture/decisions.md`](architecture/decisions.md) | Qabul qilingan qarorlar (jurnal) |
| [`docs/adia-poster-api.md`](adia-poster-api.md) | Poster POS integratsiya qo'llanmasi |
| [`docs/references/`](references/) | A11y, security, performance, testing checklist |
| `.claude/agents/` | 8 agentning ta'rifi |
| `.claude/skills/` | 28 ta skill (har birida `SKILL.md`) |
| `.claude/commands/` | 7 slash-command |
| `.env` | Maxfiy kalitlar (sizning fayl, git'ga tushmaydi) |

---

## 15. Yordam va savol

- Birinchi bo'lib Claude'ning o'zidan so'rang — u team lead, javob beradi yoki to'g'ri agentga yo'naltiradi.
- Texnik muammoga duch kelsangiz: SETUP.md, README.md, CLAUDE.md.
- Hal qilolmasangiz — loyiha egasi yoki team lead'ga (ya'ni menga, Claude'ga) ayting.

Omad va xush kelibsiz! 🚀

— ADIA ERP team lead
