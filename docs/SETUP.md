# ADIA ERP — Sozlash qadamlari

Jamoa infratuzilmasi (Faza 0) sozlangan. Quyidagi **bir martalik** amallarni loyiha egasi bajaradi.

## 1. MCP serverlarni tasdiqlash

Loyihada `.mcp.json` bor: `notebooklm`, `agentation`, `chrome-devtools`. Claude Code'ni shu papkada qayta ishga tushirganda ularga ishonish so'raladi — tasdiqlang. Holatni `/mcp` buyrug'i bilan ko'rish mumkin.

## 2. NotebookLM — bilim bazasi / xotira

- MCP server: `notebooklm-mcp` (npm). Talab: Node.js >= 18 va Chrome.
- Birinchi marta `setup_auth` tool Chrome oynasini ochadi — Google hisobingiz bilan kiring (10 daqiqa ichida ulguring).
- Linux'da grafik muhit kerak; serverda birinchi kirish uchun: `xvfb-run`. Keyingi safarlar to'liq headless ishlaydi.
- Kirgandan keyin profil saqlanadi (`~/.local/share/notebooklm-mcp/chrome_profile/`) — qayta kirish shart emas.
- So'ngra `research-analyst` agenti TZ va domen hujjatlarini notebook'larga yuklaydi.

## 3. Figma — dizayn

- Figma plugin allaqachon yoqilgan. `/mcp` orqali `figma` ni tanlab, autentifikatsiyadan o'ting (`ui-ux-designer` uchun kerak).

## 4. Agentation — frontend vizual feedback

- MCP server `.mcp.json` da sozlangan (port 4747).
- Frontend skeleti (Faza 1) tayyor bo'lgandan keyin React ilovaga ulanadi:
  - `npm install agentation -D`
  - App root'ida, faqat dev rejimda: `<Agentation endpoint="http://localhost:4747" />`
- Muqobil — rasmiy skill: `npx skills add benjitaylor/agentation`.
- Foydalanish: brauzerda UI elementini annotatsiya qilasiz → tuzilgan kontekst (selector, fayl yo'li) agentga boradi.

## 5. Poster POS integratsiyasi

- ADIA ERP savdo va ombor ma'lumotlarini **Poster POS** dan oladi (akkaunt: `adia`). API qo'llanma: `docs/adia-poster-api.md`.
- `.env` faylida `POSTER_ACCOUNT`, `POSTER_APP_ID`, `POSTER_APP_SECRET` sozlangan (git'ga yuklanmaydi). Namuna: `.env.example`.
- **Sizdan kerak:** Poster admin panelida integratsiya tokenini yarating — Доступ → Интеграции → "+ Yangi token" — va uni `.env` dagi `POSTER_TOKEN` ga qo'ying. Format: `<akkaunt>:<32-hex>`.

## 6. Git

- Repo `git init` qilingan, `.gitignore` sozlangan, baseline commit qilingan.
- `.env` git'ga yuklanmaydi (maxfiy kalitlar himoyalangan).

## Tekshirish

- `/agents` — 8 ta agent ko'rinishi kerak.
- `/mcp` — `notebooklm`, `agentation`, `chrome-devtools` (+ `figma`).
- `.claude/skills/` — 28 ta skill.
- `/help` yoki `/` — `/spec /plan /build /test /review /code-simplify /ship` command'lari.
