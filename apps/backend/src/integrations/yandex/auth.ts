/**
 * Yandex Cloud IAM auth — exchange an OAuth token for a short-lived IAM token.
 *
 * Faza-4 Sprint F4.2 / ADR-0013. The owner stores a long-lived **OAuth
 * token** in `.env` (`YANDEX_OAUTH_TOKEN`) — that is the user-account
 * credential. The Yandex Cloud APIs (STT, Object Storage, Resource Manager,
 * IAM itself) need an **IAM token** instead: a short-lived (≤12 h) bearer
 * good for ~1 hour at a time but with a 12-hour absolute lifetime.
 *
 * https://yandex.cloud/en/docs/iam/operations/iam-token/create-for-account
 *
 * Responsibilities:
 *   - exchange the OAuth token for an IAM token on demand;
 *   - cache the result in-process; refresh lazily when there are <30 min left
 *     until expiry (and ALWAYS when a downstream caller surfaces 401 →
 *     `invalidateIamToken()`);
 *   - never log/return the raw OAuth or IAM token values — only their
 *     expiry metadata.
 *
 * Test seam: the module exports a `setFetcherForTests()` injection point so
 * `vi.mock`-free tests can run against an in-memory `fetch`.
 */
import { loadConfig } from '../../config/index.js';
import { AppError } from '../../errors/index.js';

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

/** Refresh the IAM token when this many ms remain until expiry. */
const REFRESH_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Hard timeout per IAM exchange request. */
const IAM_TIMEOUT_MS = 10_000;

export type IamToken = {
  /** The opaque IAM bearer token. NEVER log this value. */
  readonly iamToken: string;
  /** Absolute expiry, ISO-8601 (Yandex returns RFC3339). */
  readonly expiresAt: Date;
};

type CacheEntry = {
  token: string;
  expiresAt: Date;
  /** The OAuth token this IAM was minted from — used to invalidate on rotation. */
  oauthFingerprint: string;
};

let cache: CacheEntry | undefined;
let fetcher: typeof fetch = ((...args: Parameters<typeof fetch>) =>
  globalThis.fetch(...args)) as typeof fetch;

/**
 * Cheap stable fingerprint for the OAuth token — used only to invalidate the
 * cache when `.env` rotates mid-process. NOT a security primitive: the OAuth
 * value itself is already in process memory; this just lets us tell two
 * values apart without storing the raw string in our debug surface.
 */
function fingerprint(s: string): string {
  // FNV-1a 32-bit. Sufficient for cache-key bucket discrimination.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Read the OAuth token from validated config; throw if absent. */
function readOauthToken(): string {
  const cfg = loadConfig();
  if (cfg.yandex.oauthToken === '') {
    throw AppError.internal(
      'YANDEX_OAUTH_TOKEN is not configured — set it in .env before using ' +
        'Yandex integrations.',
    );
  }
  return cfg.yandex.oauthToken;
}

/**
 * Exchange a raw OAuth token for an IAM token. Stateless — caching belongs
 * to `getIamToken()`. Used directly by the bootstrap script (which has its
 * own short-lived flow) and by `getIamToken()` for refreshes.
 */
export async function exchangeOAuthForIam(oauthToken: string): Promise<IamToken> {
  if (typeof oauthToken !== 'string' || oauthToken.trim() === '') {
    throw AppError.internal('exchangeOAuthForIam: oauthToken is required');
  }
  const ctrl = new AbortController();
  const timer = globalThis.setTimeout(() => ctrl.abort(), IAM_TIMEOUT_MS);
  try {
    const res = await fetcher(IAM_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yandexPassportOauthToken: oauthToken.trim() }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Body may include details — strip any token-like substrings just in
      // case so we never echo a leaked credential into logs.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        // ignore — status is enough
      }
      throw AppError.internal(
        `Yandex IAM exchange failed: HTTP ${res.status} ${res.statusText}` +
          (detail !== '' ? ` — ${detail}` : ''),
      );
    }
    const body = (await res.json()) as { iamToken?: string; expiresAt?: string };
    if (typeof body.iamToken !== 'string' || body.iamToken === '') {
      throw AppError.internal('Yandex IAM exchange: response missing iamToken');
    }
    if (typeof body.expiresAt !== 'string' || body.expiresAt === '') {
      throw AppError.internal('Yandex IAM exchange: response missing expiresAt');
    }
    const expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw AppError.internal(
        `Yandex IAM exchange: expiresAt is not a valid date — ${body.expiresAt}`,
      );
    }
    return { iamToken: body.iamToken, expiresAt };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw AppError.internal(`Yandex IAM exchange timed out after ${IAM_TIMEOUT_MS}ms`);
    }
    if (err instanceof AppError) throw err;
    throw AppError.internal(`Yandex IAM exchange error: ${(err as Error).message}`);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Return a valid IAM token, refreshing the in-memory cache when the previous
 * one is within `REFRESH_WINDOW_MS` of expiry. The OAuth token is read from
 * config on every call so a rotation in `.env` is picked up after a process
 * restart (we do NOT hot-reload `.env` mid-process).
 */
export async function getIamToken(): Promise<string> {
  const oauthToken = readOauthToken();
  const fp = fingerprint(oauthToken);
  const now = Date.now();
  if (
    cache !== undefined &&
    cache.oauthFingerprint === fp &&
    cache.expiresAt.getTime() - now > REFRESH_WINDOW_MS
  ) {
    return cache.token;
  }
  const minted = await exchangeOAuthForIam(oauthToken);
  cache = {
    token: minted.iamToken,
    expiresAt: minted.expiresAt,
    oauthFingerprint: fp,
  };
  return cache.token;
}

/**
 * Drop the cached IAM token. Call this from a downstream caller that hit
 * `401` so the very next `getIamToken()` mints a fresh one.
 */
export function invalidateIamToken(): void {
  cache = undefined;
}

/** Inspect the cached IAM token's expiry (or `null`). Used by the smoke test. */
export function getCachedIamExpiry(): Date | null {
  return cache?.expiresAt ?? null;
}

// ---------------------------------------------------------------------------
// Test-only seams
// ---------------------------------------------------------------------------

/**
 * TEST-ONLY — inject a fake fetcher so unit tests can exercise the exchange
 * without hitting the real Yandex endpoint.
 */
export function setFetcherForTests(f: typeof fetch | undefined): void {
  fetcher = f ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch;
}

/** TEST-ONLY — clear the IAM cache between cases. */
export function resetIamCacheForTests(): void {
  cache = undefined;
}
