# @adia/frontend — ADIA ERP frontend

ADIA ERP web mijozi — React + Vite + TypeScript. Bu paket monorepo
(`apps/*` npm workspace) a'zosi.

> Holat: **Faza-1, Sprint 0** — interfeys skeleti. Biznes ko'rinishlar
> (stock, replenishment, dashboard va h.k.) keyingi sprintlarda qo'shiladi.

## Texnik stek

| Qatlam | Texnologiya |
|---|---|
| Asos | React 18 + Vite 6 + TypeScript (strict) |
| UI | shadcn/ui + Tailwind CSS (dark premium mavzu) |
| Routing | react-router-dom v6 |
| Grafiklar | Recharts (Sprint 3 da ishlatiladi) |
| Test | Vitest + @testing-library/react |
| UI feedback | Agentation (faqat dev) |

## Talablar

- Node.js >= 20
- npm (workspaces)

## O'rnatish

Bog'liqliklar monorepo ildizidan o'rnatiladi (workspace hoist):

```bash
# repo ildizida
npm install
```

## Muhit o'zgaruvchilari

`.env` faylini `.env.example` dan nusxalang:

```bash
cp .env.example .env
```

| O'zgaruvchi | Tavsif | Standart |
|---|---|---|
| `VITE_API_BASE_URL` | Backend (`apps/backend`) bazaviy URL | `http://localhost:3000` |

`.env` git'ga yuklanmaydi.

## Skriptlar

Hammasi `apps/frontend` ichidan ishga tushiriladi (yoki ildizdan
`npm run <script> -w @adia/frontend`):

| Komanda | Vazifa |
|---|---|
| `npm run dev` | Dev server — http://localhost:5173 |
| `npm run build` | Ishlab chiqarish build (`tsc -b && vite build` → `dist/`) |
| `npm run preview` | Build natijasini lokal ko'rish |
| `npm run lint` | ESLint tekshiruvi |
| `npm test` | Vitest (bir martalik) |
| `npm run test:watch` | Vitest kuzatuv rejimida |

## Ishga tushirish

```bash
cd apps/frontend
npm run dev
```

Brauzerda http://localhost:5173 ochiladi. Autentifikatsiyalanmagan
foydalanuvchi `/login` ga yo'naltiriladi.

> Sprint 0 da Login backendga ulanmagan — istalgan ma'lumot bilan
> "Kirish" bosilsa lokal stub sessiya yaratiladi va `/dashboard` ga
> o'tkazadi. Haqiqiy `POST /api/auth/login` Sprint 1+ da ulanadi.

## Dark mavzu

Ilova faqat dark premium mavzuda ishlaydi (Faza-1). `<html>` elementiga
`dark` klassi qattiq belgilangan; dizayn tokenlari (rang, radius)
`src/index.css` dagi CSS o'zgaruvchilarida. Skrinshot olish uchun:
`npm run dev` → http://localhost:5173 → Login sahifa qorong'i palitrada
ko'rinadi.

## Agentation (vizual UI feedback)

`agentation` dev-bog'liqlik sifatida o'rnatilgan. Overlay faqat dev
rejimida render bo'ladi (`import.meta.env.DEV`), test rejimida
(`MODE === 'test'`) o'chiriladi. Endpoint: `http://localhost:4747`.
Kod: `src/components/DevAgentation.tsx`.

## Papka strukturasi

```
apps/frontend/
├── index.html
├── vite.config.ts          Vite + Vitest konfiguratsiyasi
├── tailwind.config.js      Tailwind + dark mavzu tokenlari
├── tsconfig.json           TypeScript strict
├── eslint.config.js
└── src/
    ├── main.tsx            Ilova kirish nuqtasi
    ├── App.tsx             Provayderlar + router montaj
    ├── index.css           Tailwind + dizayn tizimi (CSS o'zgaruvchilari)
    ├── components/
    │   ├── ui/             shadcn primitivlar (button, card, dialog, ...)
    │   ├── layout/         AppLayout, AppSidebar
    │   └── DevAgentation.tsx
    ├── hooks/              Auth context (AuthProvider, useAuth)
    ├── lib/                api-client, auth-storage, env, navigation, types
    ├── pages/              LoginPage, PlaceholderPage, NotFoundPage
    ├── routes/             AppRouter, ProtectedRoute
    └── test/               Vitest setup
```

## Rolga asoslangan navigatsiya

Sidebar menyusi RBAC matritsasiga (`docs/specs/phase-1-mvp.md §6`)
ko'ra filtrlanadi — har rol faqat o'z bo'g'inini ko'radi. Rollar va
menyu elementlari `src/lib/navigation.ts` da. Sprint 0 da marshrutlar
placeholder; haqiqiy ekranlar Sprint 1+ da.
