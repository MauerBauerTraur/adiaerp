/**
 * Unit tests for the Yandex IAM token helper (F4.2 / ADR-0013).
 *
 * Pure unit tests — no DB, no network. The fetcher is injected via
 * `setFetcherForTests()` so we can drive the exchange deterministically.
 *
 * Covers:
 *   - happy-path exchange returns the parsed IAM token + expiry;
 *   - the cache reuses the token until the refresh window opens;
 *   - `invalidateIamToken()` forces a re-exchange;
 *   - HTTP failures surface as `AppError.internal` with NO token in the
 *     thrown message (secrets hygiene).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exchangeOAuthForIam,
  getIamToken,
  invalidateIamToken,
  resetIamCacheForTests,
  setFetcherForTests,
} from '../src/integrations/yandex/auth.js';
import { resetConfigCache } from '../src/config/index.js';

const OAUTH = 'y0_test_oauth_token_value';

function mockResponder(payload: unknown, status = 200): typeof fetch {
  return ((_url: unknown, _init?: RequestInit) =>
    Promise.resolve(
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;
}

function setEnv(): void {
  process.env.YANDEX_OAUTH_TOKEN = OAUTH;
  process.env.YANDEX_FOLDER_ID = 'b1gtest12345';
  process.env.YANDEX_BUCKET = 'adia-erp-voice-test';
}

function unsetEnv(): void {
  delete process.env.YANDEX_OAUTH_TOKEN;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.YANDEX_BUCKET;
}

describe('yandex/auth — exchangeOAuthForIam', () => {
  beforeEach(() => {
    setEnv();
    resetConfigCache();
    resetIamCacheForTests();
  });
  afterEach(() => {
    setFetcherForTests(undefined);
    unsetEnv();
    resetConfigCache();
    resetIamCacheForTests();
  });

  it('returns the parsed iamToken + expiresAt from a 200 response', async () => {
    const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    setFetcherForTests(mockResponder({ iamToken: 't.IAM.aaa', expiresAt: expires }));
    const { iamToken, expiresAt } = await exchangeOAuthForIam(OAUTH);
    expect(iamToken).toBe('t.IAM.aaa');
    expect(expiresAt.toISOString()).toBe(expires);
  });

  it('throws AppError on non-2xx without echoing the OAuth token', async () => {
    setFetcherForTests(mockResponder('Unauthorized', 401));
    await expect(exchangeOAuthForIam(OAUTH)).rejects.toThrow(/IAM exchange failed/i);
    try {
      await exchangeOAuthForIam(OAUTH);
    } catch (err) {
      expect((err as Error).message).not.toContain(OAUTH);
    }
  });

  it('throws when the response is missing iamToken', async () => {
    setFetcherForTests(mockResponder({ expiresAt: new Date().toISOString() }));
    await expect(exchangeOAuthForIam(OAUTH)).rejects.toThrow(/missing iamToken/i);
  });

  it('throws when expiresAt is not a valid date', async () => {
    setFetcherForTests(mockResponder({ iamToken: 't.x', expiresAt: 'not-a-date' }));
    await expect(exchangeOAuthForIam(OAUTH)).rejects.toThrow(/expiresAt/i);
  });
});

describe('yandex/auth — getIamToken (cache + refresh)', () => {
  beforeEach(() => {
    setEnv();
    resetConfigCache();
    resetIamCacheForTests();
  });
  afterEach(() => {
    setFetcherForTests(undefined);
    unsetEnv();
    resetConfigCache();
    resetIamCacheForTests();
  });

  it('reuses a cached token while >30min remain', async () => {
    let calls = 0;
    const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    setFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ iamToken: `t.iam.${calls}`, expiresAt: expires }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);
    const first = await getIamToken();
    const second = await getIamToken();
    const third = await getIamToken();
    expect(first).toBe('t.iam.1');
    expect(second).toBe('t.iam.1');
    expect(third).toBe('t.iam.1');
    expect(calls).toBe(1);
  });

  it('refreshes when the cached token is within the 30min window', async () => {
    let calls = 0;
    // First exchange: token already only 10 minutes from expiry.
    setFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      calls += 1;
      const exp =
        calls === 1
          ? new Date(Date.now() + 10 * 60 * 1000).toISOString()
          : new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      return Promise.resolve(
        new Response(JSON.stringify({ iamToken: `t.iam.${calls}`, expiresAt: exp }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);
    expect(await getIamToken()).toBe('t.iam.1');
    // The cached token expires in <30 min, so the next call refreshes.
    expect(await getIamToken()).toBe('t.iam.2');
    expect(calls).toBe(2);
  });

  it('invalidateIamToken() forces a fresh exchange on next call', async () => {
    let calls = 0;
    const expires = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    setFetcherForTests(((_url: unknown, _init?: RequestInit) => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ iamToken: `t.iam.${calls}`, expiresAt: expires }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch);
    expect(await getIamToken()).toBe('t.iam.1');
    invalidateIamToken();
    expect(await getIamToken()).toBe('t.iam.2');
    expect(calls).toBe(2);
  });
});
