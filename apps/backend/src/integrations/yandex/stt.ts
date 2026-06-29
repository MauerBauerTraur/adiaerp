/**
 * Yandex SpeechKit STT v1 — synchronous "short" recognition client.
 *
 * Faza-4 Sprint F4.2 / ADR-0013. We deliberately use the v1 short-audio
 * endpoint (≤30s, ≤1 MiB, no async polling) for the voice-command pipeline:
 * Telegram voice notes are short by definition and the synchronous API gives
 * us a single HTTP round-trip instead of an upload-to-S3 + polling job.
 *
 * https://yandex.cloud/en/docs/speechkit/stt/api/request-api
 *
 * Endpoint:
 *   POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize
 *     ?topic=general&lang=<bcp47>&folderId=<id>&format=oggopus
 *   Authorization: Bearer <iam>
 *   body: raw audio bytes (OGG/Opus from Telegram, no transcoding needed)
 *
 * Response:
 *   { "result": "<transcript>" }
 *
 * Retry policy:
 *   - 401 → invalidate the cached IAM token, mint a fresh one, retry ONCE;
 *   - 429 → fixed 500ms backoff, retry ONCE;
 *   - 5xx → 1s backoff, retry ONCE (exponential would never see >1 retry here);
 *   - everything else surfaces as a `YandexSttError` with HTTP status attached.
 *
 * Secrets hygiene:
 *   - the IAM bearer is set on the `Authorization` header only — never logged;
 *   - error messages include the HTTP status and a truncated response snippet,
 *     never headers or the audio bytes.
 */
import { getIamToken, invalidateIamToken } from './auth.js';
import { loadConfig } from '../../config/index.js';
import { AppError } from '../../errors/index.js';

const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

/** Hard timeout per recognize attempt (Yandex says ≤30s audio). */
const STT_TIMEOUT_MS = 20_000;

/** BCP-47 language tags Yandex supports for our use case. */
export type SttLang = 'uz-UZ' | 'ru-RU' | 'en-US' | 'auto';

/**
 * Audio container/codec hint. For Telegram voice notes use `oggopus` (the
 * native Telegram format); for in-browser MediaRecorder use `lpcm`.
 */
export type SttAudioFormat = 'oggopus' | 'lpcm' | 'mp3';

export type SttResult = {
  /** The transcript text. Empty string when Yandex returned no speech. */
  readonly text: string;
  /** Round-trip latency in ms — surfaced for the assistant audit trail. */
  readonly elapsedMs: number;
};

export class YandexSttError extends Error {
  public override readonly name = 'YandexSttError';
  public readonly status: number | undefined;
  constructor(message: string, opts: { status?: number } = {}) {
    super(`[yandex:stt] ${message}`);
    if (opts.status !== undefined) {
      this.status = opts.status;
    }
  }
}

type RecognizeOpts = {
  /** Language hint. Defaults to `uz-UZ`. */
  readonly lang?: SttLang;
  /** Audio container hint. Defaults to `oggopus` (Telegram). */
  readonly format?: SttAudioFormat;
  /** Override the `topic` (model). Default `general`. */
  readonly topic?: string;
};

type FetcherLike = typeof fetch;

let fetcher: FetcherLike = ((...args: Parameters<FetcherLike>) =>
  globalThis.fetch(...args)) as FetcherLike;

function buildUrl(opts: RecognizeOpts, folderId: string): string {
  const lang = opts.lang ?? 'uz-UZ';
  const format = opts.format ?? 'oggopus';
  const topic = opts.topic ?? 'general';
  const url = new URL(STT_URL);
  url.searchParams.set('topic', topic);
  if (lang !== 'auto') {
    url.searchParams.set('lang', lang);
  }
  url.searchParams.set('folderId', folderId);
  url.searchParams.set('format', format);
  return url.toString();
}

/**
 * Send one HTTP attempt. Caller wraps in retry logic.
 *
 * Returns a discriminated result so the caller can decide whether to refresh
 * the IAM token (401) vs. back off (429/5xx) vs. surface the error.
 */
type AttemptOk = { kind: 'ok'; text: string };
type AttemptRetry = { kind: 'retry'; reason: 'auth' | 'rate' | 'server'; status: number };
type AttemptFail = { kind: 'fail'; error: YandexSttError };
type Attempt = AttemptOk | AttemptRetry | AttemptFail;

async function attempt(
  url: string,
  bearer: string,
  audio: Uint8Array,
): Promise<Attempt> {
  const ctrl = new AbortController();
  const timer = globalThis.setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
  try {
    // Node's fetch accepts a Uint8Array at runtime but lib.dom's strict
    // typing under `exactOptionalPropertyTypes` rejects it. We build the
    // init record loosely and cast once at the call site — the cast is
    // tightly scoped so no other call site is affected.
    const init = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        // `application/octet-stream` is what the v1 short-audio endpoint
        // expects when sending raw audio bytes (per Yandex docs).
        'content-type': 'application/octet-stream',
      },
      body: audio,
      signal: ctrl.signal,
    } as unknown as RequestInit;
    const res = await fetcher(url, init);
    if (res.ok) {
      const body = (await res.json()) as { result?: string };
      return { kind: 'ok', text: typeof body.result === 'string' ? body.result : '' };
    }
    if (res.status === 401) return { kind: 'retry', reason: 'auth', status: 401 };
    if (res.status === 429) return { kind: 'retry', reason: 'rate', status: 429 };
    if (res.status >= 500 && res.status < 600) {
      return { kind: 'retry', reason: 'server', status: res.status };
    }
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 300);
    } catch {
      // ignore — status is enough
    }
    return {
      kind: 'fail',
      error: new YandexSttError(
        `HTTP ${res.status} ${res.statusText}${snippet !== '' ? ` — ${snippet}` : ''}`,
        { status: res.status },
      ),
    };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      return {
        kind: 'fail',
        error: new YandexSttError(`request timed out after ${STT_TIMEOUT_MS}ms`),
      };
    }
    return {
      kind: 'fail',
      error: new YandexSttError((err as Error).message),
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Recognize a short audio clip (≤30 s, ≤1 MiB). Returns `{ text, elapsedMs }`.
 *
 * Throws `YandexSttError` on hard failure; throws `AppError.internal` only
 * when the Yandex integration is not configured (caller bug — gate on
 * `cfg.yandex.enabled` first).
 */
export async function recognizeShort(
  audio: Uint8Array | Buffer,
  opts: RecognizeOpts = {},
): Promise<SttResult> {
  const cfg = loadConfig();
  if (cfg.yandex.folderId === '') {
    throw AppError.internal(
      'Yandex STT: YANDEX_FOLDER_ID is not configured. Run the bootstrap ' +
        'script or set it in .env.',
    );
  }
  if (audio.byteLength === 0) {
    throw new YandexSttError('audio payload is empty');
  }
  // Hard cap at 1 MiB — Yandex rejects with 413 above this; surface a
  // clearer error before we even leave the process.
  if (audio.byteLength > 1024 * 1024) {
    throw new YandexSttError(
      `audio payload too large (${audio.byteLength} bytes) — the v1 short ` +
        'recognize endpoint accepts up to 1 MiB. Use the long-audio v3 ' +
        'flow (upload to Object Storage + async recognize) for longer ' +
        'clips.',
    );
  }
  const url = buildUrl(opts, cfg.yandex.folderId);
  const audioBytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);

  const t0 = Date.now();
  let bearer = await getIamToken();
  const firstAttempt = await attempt(url, bearer, audioBytes);
  if (firstAttempt.kind === 'ok') {
    return { text: firstAttempt.text, elapsedMs: Date.now() - t0 };
  }
  if (firstAttempt.kind === 'fail') {
    throw firstAttempt.error;
  }
  // Retry path — exactly ONE retry, with per-reason backoff.
  if (firstAttempt.reason === 'auth') {
    invalidateIamToken();
    bearer = await getIamToken();
  } else if (firstAttempt.reason === 'rate') {
    await sleep(500);
  } else {
    // server
    await sleep(1000);
  }
  const second = await attempt(url, bearer, audioBytes);
  if (second.kind === 'ok') {
    return { text: second.text, elapsedMs: Date.now() - t0 };
  }
  if (second.kind === 'fail') {
    throw second.error;
  }
  // Still asking us to retry — give up.
  throw new YandexSttError(
    `retried once after ${firstAttempt.reason} (${firstAttempt.status}), ` +
      `still ${second.reason} (${second.status})`,
    { status: second.status },
  );
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** TEST-ONLY — inject a fake fetcher. */
export function setSttFetcherForTests(f: FetcherLike | undefined): void {
  fetcher = f ?? ((...args: Parameters<FetcherLike>) => globalThis.fetch(...args)) as FetcherLike;
}
