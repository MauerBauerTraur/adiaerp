# @adia/backend — ADIA ERP backend

ADIA ERP backend API. Node.js + Express + TypeScript (strict),
PostgreSQL with a raw-SQL query layer (no ORM), JWT + RBAC.

> Sprint 0 status: infrastructure skeleton only. Business endpoints (M1-M9)
> arrive in the next sprint.

## Talablar (requirements)

- Node.js >= 20
- PostgreSQL 16 (lokal dev)

## Muhit (environment)

Maxfiy kalitlar repo ildizidagi `.env` faylida (git'ga yuklanmaydi).
Namuna: repo ildizidagi `.env.example`. Backend uchun kerakli kalitlar:

| Kalit | Tavsif |
|---|---|
| `DATABASE_URL` | PostgreSQL ulanish satri (masalan `postgres://localhost:5432/adia_erp_dev`) |
| `JWT_SECRET` | JWT imzolash kaliti |
| `PORT` | API porti (default `3001`) |
| `JWT_EXPIRES_IN_SECONDS` | token muddati (default `43200` = 12s) |
| `POSTER_*` | Poster POS API kalitlari |
| `TELEGRAM_BOT_TOKEN` | Grammy bot tokeni |

Yetishmagan majburiy kalitda ilova aniq xato bilan ishga tushmaydi
(`src/config/index.ts`).

## Ishga tushirish (setup)

Barcha komandalar monorepo ildizidan ishga tushiriladi.

```bash
# 1. Bog'liqliklarni o'rnatish
npm install

# 2. Lokal dev DB yaratish (adia_erp_dev)
npm run db:create --workspace @adia/backend
```

> **DB yaratish huquqi.** `db:create` ishlashi uchun PostgreSQL roli
> `CREATEDB` huquqiga ega bo'lishi kerak. Agar "permission denied to create
> database" xatosi chiqsa, superuser bir marta quyidagini bajaradi:
>
> ```bash
> sudo -u postgres createdb -O <rol> adia_erp_dev
> # yoki rolga huquq berish:
> sudo -u postgres psql -c "ALTER ROLE <rol> CREATEDB;"
> ```

```bash
# 3. Migratsiyalarni qo'llash
npm run migrate --workspace @adia/backend

# 4. Dev serverni ishga tushirish (tsx watch)
npm run dev --workspace @adia/backend

# Smoke test
npm run test --workspace @adia/backend
```

Tekshirish: `curl http://localhost:3001/health`

## Skriptlar (scripts)

| Skript | Vazifa |
|---|---|
| `npm run dev` | tsx watch rejimida dev server |
| `npm run build` | TypeScript -> `dist/` |
| `npm run start` | `dist/server.js` ni ishga tushirish |
| `npm run migrate` | kutilayotgan SQL migratsiyalarni qo'llash |
| `npm run db:create` | lokal dev DB (`adia_erp_dev`) yaratish |
| `npm run test` | vitest smoke testlar |
| `npm run lint` | ESLint |

## Struktura

```
apps/backend/
  migrations/        — ketma-ket SQL migratsiyalar (NNNN_*.sql)
  scripts/           — dev tooling (create-db)
  src/
    config/          — tiplangan, validatsiyalangan env loader
    db/              — pg Pool, query()/withTransaction() helperlari, migration runner
    auth/            — JWT imzo/tekshirish, RBAC rollar
    middleware/      — authenticate, authorize, error handler
    errors/          — AppError + xato kodlari enum
    routes/          — Express routerlar (hozircha: health)
    app.ts           — Express ilova yig'ilishi
    server.ts        — process entrypoint
  test/              — vitest testlar
```

## Migratsiya tizimi

`migrations/` papkasidagi `NNNN_description.sql` fayllar leksik tartibda
qo'llanadi. `schema_migrations` jadvali qaysi fayl qo'llanganini yozadi —
qayta ishga tushirish qo'llangan migratsiyalar uchun no-op.

Birinchi migratsiya `0001_init.sql` — Faza-1 to'liq sxemasi
(`docs/architecture/db-schema-phase-1.sql` nusxasi).
