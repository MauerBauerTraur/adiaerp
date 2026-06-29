/**
 * Tests for the transparent JWT-refresh flow in `apiRequest`.
 *
 * Backend contract (Sprint 3, `docs/specs/phase-1-mvp.md §4.1`):
 *  - 1h access token, 30d rotated refresh token.
 *  - `POST /api/auth/refresh {refresh_token}`
 *      → `{ access_token, refresh_token, user }`.
 *
 * Client contract (what these tests pin down):
 *  1. 401 → refresh → retry the original request → return the retried 200.
 *  2. Refresh fails (401) → tokens are cleared, the rejection bubbles.
 *  3. A burst of 401s shares ONE refresh (single-flight); the rotated
 *     token is then used by every retry. Without this lock, parallel
 *     refresh calls would race each other into logout.
 *  4. The refresh endpoint itself does not recurse on a 401.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiRequest, ApiError } from './api-client';
import {
  setTokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setActiveLocation,
} from './auth-storage';

const BASE = 'http://localhost:3001';

interface CallLog {
  url: string;
  method: string;
  authHeader: string | null;
  body: string | null;
  /** F4.1 — `X-Active-Location` header attached by `apiRequest`. */
  activeLocationHeader: string | null;
}

/**
 * Install a controllable `fetch` mock that records every call and lets
 * each test queue per-URL responses in order.
 */
function installFetch() {
  const calls: CallLog[] = [];
  const queues = new Map<string, Array<() => Response | Promise<Response>>>();

  function enqueue(
    urlSuffix: string,
    factory: () => Response | Promise<Response>,
  ) {
    const url = `${BASE}${urlSuffix}`;
    const queue = queues.get(url) ?? [];
    queue.push(factory);
    queues.set(url, queue);
  }

  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = init?.headers ?? {};
      const auth =
        (headers as Record<string, string>).Authorization ?? null;
      const activeLoc =
        (headers as Record<string, string>)['X-Active-Location'] ?? null;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authHeader: auth,
        body: typeof init?.body === 'string' ? init.body : null,
        activeLocationHeader: activeLoc,
      });
      const queue = queues.get(url);
      if (queue === undefined || queue.length === 0) {
        throw new Error(`Unexpected fetch to ${url}`);
      }
      const factory = queue.shift();
      return factory!();
    });

  return { calls, enqueue, fetchSpy };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest — JWT refresh', () => {
  beforeEach(() => {
    clearTokens();
    // Pretend we're already logged in with an expired access token.
    setTokens({ accessToken: 'OLD_ACCESS', refreshToken: 'OLD_REFRESH' });
  });

  afterEach(() => {
    clearTokens();
    vi.restoreAllMocks();
  });

  it('refreshes on a 401 and replays the original request once', async () => {
    const { calls, enqueue } = installFetch();

    // 1) Original request → 401.
    enqueue('/api/auth/me', () =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    // 2) /api/auth/refresh → fresh pair.
    enqueue('/api/auth/refresh', () =>
      jsonResponse(200, {
        access_token: 'NEW_ACCESS',
        refresh_token: 'NEW_REFRESH',
        user: { id: 1 },
      }),
    );
    // 3) Replayed /api/auth/me → 200.
    enqueue('/api/auth/me', () =>
      jsonResponse(200, { user: { id: 1, name: 'PM' } }),
    );

    const result = await apiRequest<{ user: { id: number; name: string } }>(
      '/api/auth/me',
    );
    expect(result.user.name).toBe('PM');

    // Exactly three fetches, in order.
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/auth/me`,
      `${BASE}/api/auth/refresh`,
      `${BASE}/api/auth/me`,
    ]);
    // The retry must carry the NEW access token, not the stale one.
    expect(calls[0]?.authHeader).toBe('Bearer OLD_ACCESS');
    expect(calls[2]?.authHeader).toBe('Bearer NEW_ACCESS');
    // The refresh body carries the OLD refresh token.
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      refresh_token: 'OLD_REFRESH',
    });
    // Tokens were rotated and saved.
    expect(getAccessToken()).toBe('NEW_ACCESS');
    expect(getRefreshToken()).toBe('NEW_REFRESH');
  });

  it('clears tokens and rejects when the refresh itself fails', async () => {
    const { enqueue } = installFetch();

    enqueue('/api/auth/me', () =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    enqueue('/api/auth/refresh', () =>
      jsonResponse(401, { error: { code: 'INVALID_REFRESH', message: 'no' } }),
    );

    await expect(apiRequest('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
    // Refresh failed → tokens dropped → no further retries.
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('refresh endpoint does not recurse on its own 401', async () => {
    const { calls, enqueue } = installFetch();
    enqueue('/api/auth/refresh', () =>
      jsonResponse(401, { error: { code: 'INVALID_REFRESH', message: 'no' } }),
    );

    await expect(
      apiRequest('/api/auth/refresh', {
        method: 'POST',
        body: { refresh_token: 'whatever' },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // Just one fetch — no retry loop.
    expect(calls.length).toBe(1);
  });

  // F4.1 / ADR-0012 — `apiRequest` advertises the active-location on
  // every authed request so the backend can scope the RBAC view.
  it('attaches X-Active-Location when one is persisted', async () => {
    const { calls, enqueue } = installFetch();
    setActiveLocation(42);
    enqueue('/api/stock', () => jsonResponse(200, []));
    await apiRequest('/api/stock');
    expect(calls[0]?.activeLocationHeader).toBe('42');
    setActiveLocation(null);
  });

  it('omits X-Active-Location when none is set', async () => {
    const { calls, enqueue } = installFetch();
    setActiveLocation(null);
    enqueue('/api/stock', () => jsonResponse(200, []));
    await apiRequest('/api/stock');
    expect(calls[0]?.activeLocationHeader).toBeNull();
  });

  it('shares ONE refresh across concurrent 401 responses', async () => {
    const { calls, enqueue } = installFetch();

    // Two original requests, each landing on 401.
    enqueue('/api/stock', () =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    enqueue('/api/products', () =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    // EXACTLY ONE /api/auth/refresh slot — if a second refresh is
    // attempted the fetch mock throws "Unexpected fetch".
    enqueue('/api/auth/refresh', () =>
      jsonResponse(200, {
        access_token: 'NEW_ACCESS',
        refresh_token: 'NEW_REFRESH',
        user: { id: 1 },
      }),
    );
    enqueue('/api/stock', () => jsonResponse(200, []));
    enqueue('/api/products', () => jsonResponse(200, []));

    const [stock, products] = await Promise.all([
      apiRequest('/api/stock'),
      apiRequest('/api/products'),
    ]);
    expect(stock).toEqual([]);
    expect(products).toEqual([]);

    // Refresh fired exactly once.
    const refreshCalls = calls.filter(
      (c) => c.url === `${BASE}/api/auth/refresh`,
    );
    expect(refreshCalls.length).toBe(1);

    // Both retries carried the new token.
    const retries = calls.filter((_, i) => i >= 3); // first 3 = [stock401, products401, refresh]
    expect(retries.every((c) => c.authHeader === 'Bearer NEW_ACCESS')).toBe(
      true,
    );
  });
});
