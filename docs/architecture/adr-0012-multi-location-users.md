# ADR-0012 — Foydalanuvchilar va lokatsiyalar orasidagi ko'p-ko'p (M:N) bog'lanish

> Holat: **Qabul qilindi** (2026-05-24, egasi tasdig'i)
> Faza: 4
> Bog'liqlik: TZ §6.10, §11; CLAUDE.md §6; ADR-0003 (RBAC scope);
> migratsiya `0012_user_locations.sql`.

---

## 1. Kontekst

Faza-1 da `users.location_id BIGINT REFERENCES locations(id)` — bitta
hodim bitta lokatsiyaga biriktiriladi (1:1). Bu MVP uchun yetarli edi:
har do'kon o'z sotuvchisi, omborning omborchisi, va h.k.

Faza-4 da egasi (2026-05-24) yangi operatsion talab kiritdi:

> *"Bitta omborchi 3 ta do'konga xizmat qilishi kerak. Bitta supply
> hodimi 2 ta zona orasida ishlaydi. Hodim login qilganda qaysi
> do'kon nomidan ishlayotganini tanlay olishi kerak."*

Bu 1:1 model bilan hal qilinmaydi. Variantlar:

| Variant | Tafsilot | Muammo |
|---|---|---|
| **A.** `users.location_ids INT[]` (array kolonkasi) | Yagona qator, no JOIN | Index/constraint murakkab; PostgreSQL native FK arraylarni qo'llab-quvvatlamaydi; "primary" tushunchasini ajratish qiyin |
| **B.** Yangi `user_locations` jadvali (M:N) | Klassik junction table | Mavjud `users.location_id` ga tegishli barcha JOIN va RBAC kod buziladi |
| **C.** `users.location_id` saqlanadi (= primary) + qo'shimcha M:N | Hybrid: 1:1 + 1:N kengaytma | Ikki manba haqiqat — sinxron saqlanishi kerak |

**Aktiv lokatsiya** (session-scoped) modellash variantlari:

| Variant | Tafsilot | Muammo |
|---|---|---|
| **i.** JWT `active_loc` claim | Stateless | Har switch da token re-issue; refresh oqimi murakkablashadi |
| **ii.** Server-side session (DB qator yoki Redis) | Aktiv kontekst DB da | Stateful → scale qilish qiyin |
| **iii.** HTTP header `X-Active-Location` | Stateless, client tanlaydi | Backend har request da validate qilishi shart |

---

## 2. Qaror

**Variant C** (hybrid) + **Variant iii** (header).

### 2.1. Data model

- `users.location_id BIGINT NOT NULL` — Faza-1 dan saqlanadi va
  **primary lokatsiya** ni anglatadi. Mavjud kod hech qanday
  o'zgartirishsiz ishlaydi.
- Yangi `user_locations(user_id, location_id, is_primary, ...)` —
  M:N junction.
- `is_primary` partial unique index bilan har user uchun **faqat
  bitta primary** kafolatlanadi.
- Application invariant: `users.location_id` har doim
  `user_locations` ichida `is_primary=true` qator bilan teng (services
  qatlamida saqlanadi).

### 2.2. Migration / back-fill

```sql
INSERT INTO user_locations (user_id, location_id, is_primary)
SELECT id, location_id, TRUE FROM users WHERE location_id IS NOT NULL
ON CONFLICT (user_id, location_id) DO NOTHING;
```

PM null `location_id` bilan (chunki chain-wide) — `user_locations` ga
qator yaratilmaydi (`locationIds = []`, `assertLocationAccess` pm
passga `isSuperAdmin` orqali).

### 2.3. Aktiv lokatsiya

- **Frontend** tanlaydi (header dropdown), tanlovni `localStorage`
  ga saqlaydi va har request da `X-Active-Location: <id>` header
  yuboradi.
- **Backend** `auth` middleware:
  - `principal.locationIds = SELECT location_id FROM user_locations
    WHERE user_id = $1`.
  - `header.X-Active-Location` validate: `locationIds` ichida bo'lishi
    shart, aks holda 403 `ACTIVE_LOCATION_NOT_ALLOWED`.
  - Header yo'q bo'lsa → `activeLocationId = users.location_id` (primary).
- **Audit log** har request da `active_location_id` ni yozadi
  (`0014_audit_log_active_location.sql`).
- PATCH `/api/auth/active-location` faqat audit yozadi va frontendning
  "yangi aktiv lokatsiya" ni tasdiqlaydi (server-state yo'q).

### 2.4. Principal kengaytmasi

```ts
export type AuthPrincipal = {
  readonly userId: number;
  readonly role: string;
  // Faza-1 — primary lokatsiya (back-compat). NULL = chain-wide (pm).
  readonly locationId: number | null;
  // Faza-4 yangi maydonlari:
  readonly locationIds: number[];        // barcha assigned (pm = [])
  readonly activeLocationId: number | null; // header > primary
};
```

`assertLocationAccess(principal, target)`:
```ts
if (isSuperAdmin(principal)) return;
if (principal.locationIds.includes(target)) return;
throw AppError.forbidden(...);
```

Eski `principal.locationId` saqlanadi — Faza-1..Faza-3 da yozilgan
kod o'zgartirilmaydi. Yangi kod `locationIds` ni ishlatadi (multi-loc
operatsiyalarda).

---

## 3. Asoslar

- **Back-compat:** mavjud 30+ endpoint va services qatlami
  `principal.locationId` ni ishlatadi. Hybrid model bilan ularning
  hech biri **buzilmaydi** — primary lokatsiya hali ham yagona "default"
  scope.
- **Statelesslik:** Header asosida tanlov server uchun "stateless"
  qoladi; har request o'zicha o'qiladi va validate qilinadi. JWT'ga
  qo'shilmagani uchun refresh oqimi soddaroq.
- **Audit:** har request da kontekstli `active_location_id`
  audit'ga yoziladi → forensic uchun "kim qaysi do'kon nomidan
  ishlagani" aniq.
- **Bitta primary:** partial unique index ma'lumot bazasi darajasida
  buzilmaslikni kafolatlaydi — application qatlamidagi xato ham qatorni
  rad etadi.

---

## 4. Muqobillarning rad etilishi

- **Variant A (array)**: PostgreSQL `int[]` foreign key ga ega emas;
  `unnest` JOIN'lar sekin va index murakkab. "primary" alohida kolonka
  bo'lishi kerak edi. Rad etildi.
- **Variant i (JWT claim)**: switch da token re-issue
  qimmat; refresh logic murakkab; XSS bilan claim spoofing himoyasi
  qo'shimcha. Header oddiyroq.
- **Variant ii (server session)**: stateful, scale uchun Redis kerak
  (Faza-4 uchun ortiqcha).

---

## 5. Oqibatlar

### 5.1. Ijobiy
- Operatsion talab to'liq qondiriladi (1 omborchi 3 do'kon).
- Mavjud kod 95%+ tegmagan holatda qoladi.
- Audit log ko'p qatlamli (kim, qaysi rol, qaysi kontekstda).
- Test qulay: `principal.locationIds` mock'i oddiy massiv.

### 5.2. Salbiy va himoyalar
- **Sinxron ikki manba** (`users.location_id` va `user_locations.is_primary`)
  — application kod bilan saqlash kerak. Himoya: bitta service
  `setPrimaryLocation` (transactional `UPDATE users SET location_id`
  + `UPDATE user_locations`).
- **Frontend har joyda header yuborishi kerak** — global `fetch`
  wrapper'ga qo'shamiz (`api-client.ts`).
- **Eski API foydalanuvchisi (Faza-1..3)** header yubormaydi — backend
  default sifatida primary ni ishlatadi (back-compat).

### 5.3. Migratsiya yo'naltirilishi
- DDL idempotent (`ON CONFLICT DO NOTHING`).
- Rollback: `DROP TABLE user_locations` + audit kolonkasini ham olib
  tashlash; mavjud `users.location_id` saqlanadi.

---

## 6. Acceptance / verifikatsiya

- Migration staging da ishga tushiriladi; `SELECT count(*) FROM
  user_locations WHERE is_primary = true` = mavjud `users WHERE
  location_id IS NOT NULL` soni.
- Auth middleware uchun unit test: header valid → ok; invalid → 403.
- `assertLocationAccess` uchun: multi-loc principal target shu loc bo'lsa
  ok; emas bo'lsa forbidden.
- Audit log da `active_location_id` to'g'ri yoziladi (smoke test).

---

## 7. References

- `docs/specs/phase-4.md` §2.1, §5.1, §5.3.
- TZ.md §11.
- ADR-0003 (RBAC scope) — Faza-1 asos.
