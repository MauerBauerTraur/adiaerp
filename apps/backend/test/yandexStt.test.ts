/**
 * Unit tests for the Yandex STT v1 short-recognize client (F4.2 / ADR-0013).
 *
 * Pure unit tests — no network, no DB. The IAM fetcher AND the STT fetcher
 * are both injected so we can exercise the 401-refresh and 429/5xx retry
 * paths deterministically.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recognizeShort,
  setSttFetcherForTests,
  YandexSttError,
} from '../src/integrations/yandex/stt.js';
import {
  resetIamCacheForTests,
  setFetcherForTests as setIamFetcher,
} from '../src/integrations/yandex/auth.js';
import { resetConfigCache } from '../src/config/index.js';

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]); // fake OggS header

function setEnv(): void {
  process.env.YANDEX_OAUTH_TOKEN = 'y0_test_oauth';
  process.env.YANDEX_FOLDER_ID = 'b1gtest12345';
  process.env.YANDEX_BUCKET = 'adia-erp-voice-test';
}

function unsetEnv(): void {
  delete process.env.YANDEX_OAUTH_TOKEN;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.YANDEX_BUCKET;
}

/** Always-200 IAM fetcher returning a fresh 12h token on every call. */
function freshIam(): typeof fetch {
  return ((_url: unknown) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          iamToken: `t.iam.${Math.random().toString(36).slice(2, 8)}`,
          expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )) as unknown as typeof fetch;
}

describe('yandex/stt — recognizeShort', () => {
  beforeEach(() => {
    setEnv();
    resetConfigCache();
    resetIamCacheForTests();
    setIamFetcher(freshIam());
  });
  afterEach(() => {
    setIamFetcher(undefined);
    setSttFetcherForTests(undefined);
    resetConfigCache();
    resetIamCacheForTests();
    unsetEnv();
  });

  it('returns the result text on a 200 envelope', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody: unknown;
    setSttFetcherForTests(((url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      capturedBody = init?.body;
      return Promise.resolve(
        new Response(JSON.stringify({ result: 'salom ostatka qancha' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);

    const r = await recognizeShort(AUDIO, { lang: 'uz-UZ', format: 'oggopus' });
    expect(r.text).toBe('salom ostatka qancha');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    // URL must carry the folder id, language and oggopus format.
    expect(capturedUrl).toContain('folderId=b1gtest12345');
    expect(capturedUrl).toContain('lang=uz-UZ');
    expect(capturedUrl).toContain('format=oggopus');
    // Bearer header must be set; we don't assert the specific value to keep
    // the test resilient to the random IAM token.
    expect(capturedAuth).toMatch(/^Bearer t\.iam\./);
    // Body is the raw bytes we passed in.
    expect(capturedBody).toBeInstanceOf(Uint8Array);
  });

  it('returns an empty string when Yandex finds no speech', async () => {
    setSttFetcherForTests(((_url: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch);
    const r = await recognizeShort(AUDIO);
    expect(r.text).toBe('');
  });

  it('refreshes IAM and retries once on 401', async () => {
    let call = 0;
    setSttFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: 'qayta urinish' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);

    const r = await recognizeShort(AUDIO);
    expect(r.text).toBe('qayta urinish');
    expect(call).toBe(2);
  });

  it('retries once on 429 with a backoff', async () => {
    let call = 0;
    setSttFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response('Too Many Requests', { status: 429 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);

    const r = await recognizeShort(AUDIO);
    expect(r.text).toBe('ok');
    expect(call).toBe(2);
  });

  it('retries once on 5xx then surfaces if still failing', async () => {
    let call = 0;
    setSttFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      call += 1;
      return Promise.resolve(new Response('boom', { status: 503 }));
    }) as unknown as typeof fetch);

    await expect(recognizeShort(AUDIO)).rejects.toBeInstanceOf(YandexSttError);
    expect(call).toBe(2);
  });

  it('rejects empty audio with a YandexSttError', async () => {
    await expect(recognizeShort(new Uint8Array(0))).rejects.toBeInstanceOf(YandexSttError);
  });

  it('rejects oversized audio (> 1 MiB) before sending the request', async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    let called = false;
    setSttFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      called = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch);

    await expect(recognizeShort(big)).rejects.toThrow(/too large/i);
    expect(called).toBe(false);
  });

  it('surfaces a clear error when YANDEX_FOLDER_ID is missing', async () => {
    delete process.env.YANDEX_FOLDER_ID;
    resetConfigCache();
    await expect(recognizeShort(AUDIO)).rejects.toThrow(/YANDEX_FOLDER_ID/);
  });
});
