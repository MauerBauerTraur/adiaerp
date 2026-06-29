# ADR-0008 — Migration from `@google-cloud/vertexai` to `@google/genai`

> Status: **Accepted** · Date: 2026-05-23 · Author: system-architect
> Relates: ADR-0006 (AI Assistant Tool Layer), spec `docs/specs/phase-2.md` §3.
> Affected code: `apps/backend/src/integrations/vertex/client.ts`,
> `apps/backend/src/services/assistant.ts`, related tests.

## Kontekst

ADR-0006 ga muvofiq Faza-2 da AI assistant Google Cloud Vertex AI Gemini
ustida qurildi. Sprint 2 yakunida (commit `de72f96`, 2026-05-23) rasmiy
TypeScript SDK sifatida **`@google-cloud/vertexai@^1.12.0`** o'rnatildi va
integratsiya qatlami (`integrations/vertex/client.ts`) shu paketga
bog'liq.

2026-05-22 da Google rasmiy e'lon qildi: **`@google-cloud/vertexai`
paketi 2026-06-24 dan deprecated** holatga o'tadi va keyinchalik
xavfsizlik patchlari/yangi model qo'llab-quvvatlash kelmaydi. O'rniga
yangi **unified SDK — `@google/genai`** (repo:
<https://github.com/googleapis/js-genai>) — Vertex AI va Gemini API
(Google AI Studio) ikkalasini bitta interface'da xizmat qiladi.

Demak Faza-2 yakunlanmasdan oldin biz allaqachon eskirgan paketga
tushib qoldik. Faza-3 boshlanguncha (Q3 2026) migratsiya majburiy —
aks holda assistant qatlami yopiq, patchlanmaydigan SDK ustida qoladi.

## Qaror

### 1. Migratsiya muddati

`@google-cloud/vertexai` → `@google/genai` migratsiyasi **Faza-3 birinchi
sprinti ichida** (2026-06-24 dan oldin) yakunlanadi. Taxminiy hajm:
1–2 hafta (bitta backend-engineer), chunki integratsiya qatlami kichik
(`client.ts` + 2 ta `extract*` funksiya + mock'lar).

Faza-2 ni qayta ochib o'zgartirilmaydi — qabul qilingan kod hozircha
ishlaydi; migratsiya mustaqil epic sifatida Faza-3 reja boshiga
qo'yiladi.

### 2. SDK API farqlari (cheat-sheet)

Quyidagilar `@google-cloud/vertexai` → `@google/genai` mapping'i.
Aniq signaturalarni har funksiyani ko'chirishda rasmiy hujjat bilan
**cross-check qiling** (`source-driven-development` skill).

**a) Konstruktor / klient yaratish**

```ts
// Eski (@google-cloud/vertexai)
import { VertexAI } from '@google-cloud/vertexai';
const vertex = new VertexAI({ project, location });

// Yangi (@google/genai)
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ vertexai: true, project, location });
```

**b) Model olish va generatsiya**

```ts
// Eski
const model = vertex.getGenerativeModel({ model: 'gemini-2.5-flash' });
const resp = await model.generateContent({ contents, tools, ... });

// Yangi
const resp = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents,
  config: { tools, systemInstruction, ... },
});
```

Yangi SDK'da "model client" tushunchasi yo'q — har chaqiriqda `model`
parametr beriladi. Bu bizning `client.ts` da kichik refactor
(`getGenerativeModel` cache'ini olib tashlash).

**c) Function/tool calling**

`FunctionDeclaration` JSON shakli **deyarli bir xil** (Google standart
schema). Lekin javobni o'qish farqlanadi:

```ts
// Eski — response.response.candidates[0].content.parts[].functionCall
// Yangi — response.candidates[0].content.parts[].functionCall  (response wrap'i yo'q)
// Yoki: response.functionCalls  (yangi helper, agar bitta turn'da bitta tool bo'lsa)
```

**`services/assistant.ts` dagi `extractToolCalls` va `extractResponse`
funksiyalarini shu yerda refactor qilish kerak** — eng katta risk
shu joyda.

**d) Streaming**

```ts
// Eski
const stream = await model.generateContentStream({...});
for await (const chunk of stream.stream) { ... }

// Yangi
const stream = await ai.models.generateContentStream({ model, contents, config });
for await (const chunk of stream) { ... }
```

Hozir Faza-2 streaming'ni ishlatmaydi (sync `generateContent` bilan
ishlaydi). Lekin Faza-3 da assistant UI'da streaming token'lar
kerak bo'lsa — yangi SDK to'g'ri tanlov.

**e) Auth**

O'zgarmaydi. Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`
env var, service account JSON path) ikkala SDK ham qabul qiladi.
`.env` da hech narsa o'zgartirilmaydi.

### 3. Test strategiyasi

Loyihada Vertex client mock'lari allaqachon barcha integratsiya
testlarida (`test/services.assistant.test.ts`,
`test/routes.assistant.test.ts`) ishlatiladi — real Vertex bilan
faqat `npm run vertex:test` smoke testi ulanadi.

- Mock interface'i (`generateContent` shape, `functionCalls` extractor)
  yangi SDK shakliga moslashtiriladi.
- Smoke test (`vertex:test`) yangi SDK bilan ham ishlatiladi —
  real javob va tool-call yakka turlari verify qilinadi.
- Coverage thresholdsi pasaytirilmaydi.

### 4. Migratsiya rejasi (5 qadam)

| # | Qadam | Fayllar | Kim |
|---|---|---|---|
| (a) | `npm install @google/genai` va `npm uninstall @google-cloud/vertexai` | `package.json`, `package-lock.json` | backend-engineer |
| (b) | `client.ts` ni yangi SDK ustida qayta yozish (konstruktor + `generateContent` wrapper) | `apps/backend/src/integrations/vertex/client.ts` | backend-engineer |
| (c) | `extractToolCalls` va `extractResponse` ni yangi response shape ostida refactor qilish | `apps/backend/src/services/assistant.ts` | backend-engineer |
| (d) | Mock'larni va unit/integration testlarni yangi SDK shape ostida yangilash | `apps/backend/test/services.assistant.test.ts`, `apps/backend/test/routes.assistant.test.ts` | qa-engineer + backend-engineer |
| (e) | `npm run vertex:test` real smoke (function calling + nominal javob) + coverage report | smoke runner | backend-engineer |

Har qadam alohida commit; qadam (b) bilan (c) bitta PR ichida — chunki
ular tip-darajasida bog'liq. `code-reviewer` (a)…(d) ni audit qiladi;
egasi (e) natijalarini ko'rib tasdiqlaydi.

## Consequences

**Ijobiy:**
- Vertex AI integratsiyasi qo'llab-quvvatlanadigan, faol rivojlanayotgan
  SDK ustida qoladi (xavfsizlik patchlari, yangi modellar, yangi
  hududlar).
- Yagona SDK — agar kelajakda Gemini API (AI Studio) ga ham ulansak
  (masalan, lokal dev uchun arzonroq tier) — kod o'zgarmaydi, faqat
  `vertexai: false` bilan boshqa klient yaratiladi.
- Streaming API toza — Faza-3 da assistant UI'da token streaming
  yoqish oson bo'ladi.

**Salbiy / risk:**
- `extractToolCalls`/`extractResponse` response shape farqi tufayli
  yashirin bug'lar bo'lishi mumkin — to'liq test coverage va
  smoke test majburiy.
- Faza-3 boshida 1–2 hafta backend kapasitasi shu migratsiyaga
  ketadi — boshqa Faza-3 epic'lari shu qadar kechikadi.
- Agar 2026-06-24 muddatida bajarilmasa: eskirgan SDK xavfsizlik
  patch'larsiz qoladi; yangi Gemini modellariga ulanish (masalan,
  `gemini-3.0-*` keladigan releaslar) mumkin bo'lmaydi.

**Kechiktirmaslik tavsiyasi:** migratsiya hajmi kichik (≈4–6 fayl),
risk asosan tool-calling response shape'da — uni kechiktirsangiz
xarajat oshmaydi, faqat xavf oshadi. Faza-3 sprint-1 ichida bajarish
tavsiya etiladi.

## Alternatives considered

1. **Eski SDK'da qolish (do nothing).** Rad etildi — 2026-06-24 dan
   keyin SDK qo'llab-quvvatlanmaydi; yangi modellar va xavfsizlik
   patchlari kelmaydi. Texnik qarz mexanik tarzda o'sadi.
2. **Anthropic Claude API ga o'tish.** ADR-0006 da allaqachon rad
   etilgan (Vertex tanlangan); shu yerda qayta ko'rib chiqilmaydi.
3. **Faza-3 oxiriga qoldirish.** Rad etildi — Faza-3 oxirigacha
   ≥3 oy eskirgan SDK ustida ishlash xavfli; 1–2 hafta investitsiya
   sprint-1 da arzimas.
4. **REST API'ga to'g'ridan-to'g'ri ulanish (SDK'siz).** Rad etildi —
   tool calling, auth refresh, retry, streaming bizning bo'ynimizga
   tushadi; SDK bu ishlarni yopib turadi.

## References

- `@google/genai` GitHub: <https://github.com/googleapis/js-genai>
- `@google/genai` npm: <https://www.npmjs.com/package/@google/genai>
- Vertex AI Node.js client deprecation notice (2026-05-22).
- ADR-0006 — AI Assistant Tool Layer.
- Faza-2 spec — `docs/specs/phase-2.md` §3 (assistant orchestration).
