# ADIA ERP

Non/qandolat ishlab chiqarish va ta'minot zanjiri uchun **o'zini-o'zi to'g'rilaydigan ERP tizimi**. Bitta kompaniya uchun (multi-tenant emas).

## Loyiha haqida

Xom-ashyodan do'kongacha bo'lgan butun zanjir bitta tizimda boshqariladi. Har mahsulotga `min`/`max` (par level) belgilanadi; ostatka `min`'dan tushganda tizim avtomatik to'ldirish (replenishment) tsiklini ishga tushiradi: markaziy sklad → xom-ashyo tekshiruvi → ishlab chiqarish buyrug'i → tayyor mahsulotni do'konga yetkazish. Eng tepada — savol-javob va buyruq beradigan AI assistant.

To'liq texnik topshiriq: [`docs/TZ.md`](docs/TZ.md).

## Holat

🟡 **Faza 0 — jamoa infratuzilmasi sozlandi.** Ilova kodi hali yozilmagan; MVP rejalashtirilmoqda.

## Jamoa (AI agentlar)

Loyiha Claude Code multi-agent jamoasi bilan olib boriladi. Team lead — orkestrator; 8 ta mutaxassis subagent `.claude/agents/` papkasida. Batafsil: [`CLAUDE.md`](CLAUDE.md).

| Agent | Vazifa |
|---|---|
| `system-architect` | Arxitektura, DB sxema, state-machine |
| `backend-engineer` | Express API, PostgreSQL, replenishment engine |
| `frontend-engineer` | React + Vite + TypeScript UI |
| `ui-ux-designer` | UI/UX dizayn, dizayn-tizim |
| `qa-engineer` | Test strategiyasi va sifat |
| `code-reviewer` | Kod review, keraksiz kod hisoboti |
| `research-analyst` | Domen tadqiqi, NotebookLM bilim bazasi |
| `market-analyst` | Bozor va raqobat tahlili |

## Texnologiyalar

React + Vite + TypeScript · shadcn/ui + Tailwind · Node.js + Express · PostgreSQL · JWT/RBAC · node-cron/BullMQ · Grammy (Telegram) · Claude AI · Hetzner/PM2/Nginx.

## Struktura

```
.claude/   — agentlar, skill'lar, command'lar, sozlamalar
docs/      — TZ.md, SETUP.md, references/, architecture/
apps/      — (Faza 1) api/ (backend) + web/ (frontend)
```

## Ish jarayoni

Vazifa → team lead reja tuzadi → egasi tasdiqlaydi → agentlar bajaradi → `code-reviewer` tekshiradi → hisobot. Batafsil: [`CLAUDE.md`](CLAUDE.md) §4.

## Sozlash

NotebookLM, Agentation va Figma uchun bir martalik hisob/auth kerak. Qadamlar: [`docs/SETUP.md`](docs/SETUP.md).
