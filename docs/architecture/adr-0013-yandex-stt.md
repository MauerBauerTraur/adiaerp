# ADR-0013 — Yandex SpeechKit STT integratsiyasi

> Holat: **Qabul qilindi** (2026-05-24, egasi tasdig'i)
> Faza: 4
> Bog'liqlik: ADR-0014 (Voice→AI→Action), `docs/specs/phase-4.md` §2.2.

---

## 1. Kontekst

Faza-4 da egasi Telegram'ga ovozli xabar yuborilganda STT yordamida
matnga aylantirib, AI'ga uzatish talab qildi (ADR-0014 voice→AI
pipeline asosi).

STT provayderlari:

| Provayder | Til | Aniqlik | Narx | Eslatma |
|---|---|---|---|---|
| **Yandex SpeechKit** | uz-UZ, ru-RU, en-US, ... | Yuqori (RU/UZ uchun eng yaxshi) | ~$0.10/daqiqa | OAuth → IAM token oqimi; RU bozorida eng kuchli |
| **Google Cloud Speech-to-Text** | uz-UZ qisman | O'rta (UZ uchun) | ~$0.024/daqiqa standard, $0.048 enhanced | UZ qo'llab-quvvatlash beta |
| **OpenAI Whisper API** | uz-UZ noaniq | O'rta | ~$0.006/daqiqa | UZ rasmiy emas; aniqlik past |
| **Whisper self-host** | uz-UZ noaniq | O'rta | $0 (server resurs) | Server CPU/GPU kerak; deploy murakkab |

Bizning kontekst:
- Foydalanuvchilar **o'zbekcha** (lotin yozuvi tovushda farqsiz) va
  qisman **ruscha** gapiradi.
- Voice xabar odatda < 60s (mahsulot/miqdor/lokatsiya).
- Yandex.Cloud bizning region (Markaziy Osiyo) ga eng yaqin —
  latency past.
- Egasi `YANDEX_OAUTH_TOKEN` ni `.env` ga qo'shdi (2026-05-24).

---

## 2. Qaror

**Yandex SpeechKit STT v3** REST API.

### 2.1. Asoslar
- **UZ aniqligi** — Yandex SpeechKit `uz-UZ` ni rasmiy qo'llab-quvvatlaydi
  va RU/UZ aralash gaplarda eng to'g'ri natija beradi (egasi POC da
  tasdiqladi).
- **Latency** — Yandex.Cloud `ru-central1` Toshkent'ga ~50ms.
- **Narx** — voice xabarlar kam (kuniga ~20 × 30s ≈ 10 daqiqa →
  $1/oy). Sezilarli emas.
- **OAuth token** allaqachon mavjud — qo'shimcha bog'lanish yo'q.

### 2.2. Arxitektura

```
Telegram voice
   │
   ▼
bot.api.getFile(file_id) → OGG/Opus URL → fetch buffer
   │
   ▼
integrations/yandex/iam.ts
   ▪ getIamToken() — cache 12h
   ▪ OAuth → POST iam.api.cloud.yandex.net/iam/v1/tokens
   │
   ▼
integrations/yandex/stt.ts
   ▪ recognizeShort(audioBuf, {language:'uz-UZ', format:'oggopus'})
   ▪ POST stt.api.cloud.yandex.net/speech/v1/stt:recognize
   ▪ Header Authorization: Bearer <iamToken>
   ▪ < 30s sinxron; > 30s "recognizeFileAsync" + S3 bucket
   │
   ▼
{ transcript, confidence }  →  Vertex parseIntent (ADR-0014)
```

### 2.3. IAM token boshqaruvi

```ts
let cache: { token: string; expiresAt: number } | undefined;

export async function getIamToken(): Promise<string> {
  // 1 daqiqa marja — token muddati tugashidan oldin re-fetch
  if (cache && cache.expiresAt > Date.now() + 60_000) {
    return cache.token;
  }
  const resp = await fetch(
    'https://iam.api.cloud.yandex.net/iam/v1/tokens',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        yandexPassportOauthToken: cfg.yandex.oauthToken,
      }),
    },
  );
  if (!resp.ok) throw new Error(`IAM exchange failed: ${resp.status}`);
  const { iamToken, expiresAt } = await resp.json();
  cache = { token: iamToken, expiresAt: new Date(expiresAt).getTime() };
  return iamToken;
}
```

- TTL: Yandex IAM tokenining muddati ~12 soat. Cache ham 12h.
- Lazy refresh: 401 javob → cache invalidate va bir marta retry.
- Multi-process: Faza-4 single PM2 process. Future Redis (ADR
  qo'shilmagan).

### 2.4. Service account va bucket (manual provisioning)

DevOps yo'riqnomasi (`docs/ops/yandex-stt-setup.md` yaratiladi —
qa-engineer/team lead vazifasi):

1. Yandex.Cloud konsolida:
   - Cloud → Folder `adia-erp`.
   - Service Account `adia-erp-stt-sa`.
   - Rol `ai.speechkit-stt.user` + `storage.editor`.
2. Service account uchun **static access keys** (S3-compatible):
   `YANDEX_S3_ACCESS_KEY_ID`, `YANDEX_S3_SECRET_ACCESS_KEY`.
3. Object Storage bucket `adia-erp-voice`:
   - **Private** (no public read).
   - Lifecycle: 7 kun keyin avtomatik o'chirish (voice fayllar audit
     uchun emas).
4. `.env` ga qo'shish:
   ```env
   YANDEX_OAUTH_TOKEN=...
   YANDEX_FOLDER_ID=b1g...
   YANDEX_STT_BUCKET=adia-erp-voice
   YANDEX_S3_ACCESS_KEY_ID=YCAJ...
   YANDEX_S3_SECRET_ACCESS_KEY=...
   YANDEX_STT_LANGUAGE=uz-UZ
   ```

> Eslatma: OAuth token bilan SA yaratish boshqacha oqim. OAuth token
> sizning Yandex Passport hisobingiz uchun, SA esa folder ichida
> alohida identity. Bucket SA orqali boshqariladi, STT recognize esa
> Passport user IAM token bilan ham, SA IAM token bilan ham ishlaydi
> — biz Passport user IAM tokenni ishlatamiz (sodda).

### 2.5. Audio format

- **Telegram voice** har doim OGG/Opus (mime `audio/ogg`,
  codec `opus`).
- Yandex STT v1 `recognize` `oggopus` formatni native qo'llab-quvvatlaydi.
- **Konvertatsiya kerak emas** — `bot.api.getFile` URL'idan keluvchi
  buffer to'g'ridan-to'g'ri body sifatida yuboriladi.
- Query params:
  - `folderId=<YANDEX_FOLDER_ID>` (majburiy)
  - `lang=uz-UZ`
  - `format=oggopus`
  - `profanityFilter=true`
  - `sampleRateHertz` faqat `lpcm` da kerak; oggopus uchun **yuborilmaydi**.

### 2.6. Short vs long API

| Faktor | Short (`/speech/v1/stt:recognize`) | Long (`/speech/v1/stt:recognizeFileAsync`) |
|---|---|---|
| Max davomiyligi | 30 sekund (1MB body) | 4 soat |
| Channels | mono | mono/stereo |
| Sinxron | ha | yo'q (polling kerak) |
| Bucket | shart emas (raw body) | shart (S3 URI) |

Telegram voice amaliyotda < 60s. Strategiyamiz:
- `duration <= 30s` → **short API** (default).
- `duration > 30s` → upload to bucket → **long API** + polling.
- Voice 30s'dan past — POC paytda 99% ehtimollik.

### 2.7. Xatolarni boshqarish

| Yandex status | Bizning xato | Behavior |
|---|---|---|
| 200 + `result` empty | `INTENT_NOT_PARSED` | Bot "Ovozni tushuna olmadim" javob |
| 401 (IAM token) | `STT_AUTH_FAILED` (502) | Cache invalidate + 1 retry; davom etsa PM ga alert |
| 429 (rate limit) | `STT_RATE_LIMITED` (503) | Bot "Keyinroq sinab ko'ring" |
| 5xx | `STT_SERVICE_UNAVAILABLE` (503) | Bot xato; voice fayl saqlanadi keyin qayta sinash uchun |
| Network timeout (30s) | Same as 503 | Same |

---

## 3. Xavfsizlik

### 3.1. Secret hygiene

- `YANDEX_OAUTH_TOKEN`, IAM token, SA access keys **hech qachon**:
  - Log fayliga;
  - Audit log payloadiga;
  - HTTP response body'ga;
  - Frontendga uzatilmasin.
- `integrations/yandex/*.ts` ichida `console.log` taqiqlanadi;
  `apps/backend/src/lib/logger.ts` ga **sanitizer** qo'shamiz: agar
  payload da `Authorization`, `iamToken`, `oauthToken`, `secretAccessKey`
  kalitlari bo'lsa — `[REDACTED]`.

### 3.2. Audit

- `voice_messages` qatorida `transcript` saqlanadi (audit).
- Token va credentials saqlanmaydi.
- Smoke test: `grep -r "Bearer t1\." logs/` bo'sh natija qaytarishi
  shart.

### 3.3. Voice fayl saqlash

- Short API: raw buffer body sifatida yuboriladi, **diskka yozilmaydi**.
- Long API: bucket'ga upload qilinadi (private); lifecycle 7 kun
  keyin avtomatik o'chiradi.
- Telegram dan kelgan tmp fayl `finally { fs.unlink }` bilan
  o'chiriladi.

---

## 4. Cost va monitoring

- **Voice trafik baholash**:
  - 20 voice/kun × 30s o'rtacha = 10 daqiqa/kun.
  - 30 kun = 300 daqiqa.
  - $0.10/daqiqa × 300 = **$30/oy** (yuqori cheklov).
  - Real ehtimollik: $5-15/oy.
- **Monitoring**: alohida dashboard widget yo'q (Faza-4). Yandex
  billing API integratsiyasi — Faza-5.
- **Rate limit**: SpeechKit standart limit 10 RPS/folder — bizning
  voice flow uchun > 100× yetarli.

---

## 5. Acceptance / verifikatsiya

- AC4.2.1: IAM token cache ishlaydi (real bilan smoke; ikkinchi
  chaqiruv network emas).
- AC4.2.3: `recognizeShort` real Yandex'ga POST → transcript
  qaytadi (smoke, CI'da skip).
- AC4.2.4: 401 → bir marta refresh + retry.
- AC4.2.5: Loglarda credentials yo'q (grep test).

---

## 6. Ochiq savol

- **Recognition aniqligi monitoring** — Faza-5 da `voice_messages`
  jadvalida `stt_confidence` agregat dashboard widget.
- **Multi-process IAM cache** — agar PM2 cluster mode'ga o'tsak,
  Redis kerak.
- **Voice transcript PII filter** — Faza-5 (transcript audit log
  ga yozilganda shaxsiy ma'lumot avtomatik maskaga olinishi).

---

## 7. References

- Yandex STT v3 REST API:
  https://yandex.cloud/en/docs/speechkit/stt/api/transcribation-api-v3
- Yandex IAM token:
  https://yandex.cloud/en/docs/iam/operations/iam-token/create
- Yandex Object Storage S3 compat:
  https://yandex.cloud/en/docs/storage/
- `docs/specs/phase-4.md` §2.2.
- ADR-0014 (Voice → AI → Action).
