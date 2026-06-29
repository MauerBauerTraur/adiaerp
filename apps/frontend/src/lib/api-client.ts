import { env } from './env';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
  getActiveLocation,
} from './auth-storage';
import type { ApiErrorBody } from './types';

/**
 * Error thrown for any non-2xx API response. Carries the parsed
 * `{ error: { code, message } }` envelope (phase-1-mvp.md §4.10) when present.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers; merged over the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Endpoint that mints tokens — must never trigger the refresh-retry loop. */
const REFRESH_PATH = '/api/auth/refresh';

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.message === 'string';
}

/**
 * Typed `fetch` wrapper for the ADIA ERP backend.
 *
 * Attaches the JWT `Authorization: Bearer` header, sends/receives JSON,
 * and parses the standard error envelope into an `ApiError`.
 *
 * On a 401 response it transparently:
 *   1. calls `POST /api/auth/refresh` with the stored refresh token,
 *   2. saves the rotated `{access_token, refresh_token}` pair,
 *   3. retries the original request once with the new access token.
 *
 * If the refresh fails (or no refresh token is stored, or the failing
 * call IS the refresh endpoint), tokens are cleared and the browser is
 * sent to /login.
 *
 * Concurrent 401s share a single refresh: the first one in flight
 * stores a Promise on `refreshInFlight`; every other caller awaits it
 * instead of starting its own refresh. This prevents a thundering herd
 * of refresh requests from invalidating each other (refresh-token
 * rotation makes the older token unusable after a successful refresh).
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return executeRequest<T>(path, options, /* allowRefresh */ true);
}

async function executeRequest<T>(
  path: string,
  options: RequestOptions,
  allowRefresh: boolean,
): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers,
  };

  const token = getAccessToken();
  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }
  // F4.1 / ADR-0012 — every authed request advertises the active
  // location so the backend can scope the RBAC view to the user's
  // currently selected bo'g'in. The header is omitted when no choice
  // has been made (the server then falls back to the user's primary).
  // Explicit per-call overrides in `headers` always win.
  const activeLocation = getActiveLocation();
  if (activeLocation !== null && finalHeaders['X-Active-Location'] === undefined) {
    finalHeaders['X-Active-Location'] = String(activeLocation);
  }

  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Tarmoq xatosi. Qayta urinib ko‘ring.');
  }

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const code = isApiErrorBody(payload) ? payload.error.code : 'UNKNOWN_ERROR';

    // 401 → try to refresh and replay the request. Eligible only when:
    //   - this is the first attempt (`allowRefresh`), and
    //   - the failing call isn't the refresh endpoint itself, and
    //   - we actually have a refresh token to spend.
    if (
      response.status === 401 &&
      allowRefresh &&
      path !== REFRESH_PATH &&
      getRefreshToken() !== null
    ) {
      const refreshed = await ensureRefresh();
      if (refreshed) {
        // Retry once with the new access token (set inside ensureRefresh).
        return executeRequest<T>(path, options, /* allowRefresh */ false);
      }
      // Refresh failed — fall through to the standard 401 handler.
    }

    if (response.status === 401) {
      handleUnauthenticated();
    }

    if (isApiErrorBody(payload)) {
      throw new ApiError(response.status, code, payload.error.message);
    }
    throw new ApiError(response.status, code, `So‘rov muvaffaqiyatsiz (${response.status}).`);
  }

  return payload as T;
}

/** Module-level single-flight latch — see `ensureRefresh`. */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Drive `POST /api/auth/refresh` at most once concurrently. Returns
 * `true` if a fresh access token is now stored, `false` if the refresh
 * was rejected (in which case tokens were cleared).
 *
 * Every concurrent caller awaits the same Promise so a burst of 401s
 * triggers exactly one refresh — important because refresh-token
 * rotation invalidates the old refresh on success, and two parallel
 * refresh calls would race each other into a logout.
 */
function ensureRefresh(): Promise<boolean> {
  if (refreshInFlight !== null) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken === null) return false;

    try {
      const response = await fetch(`${env.apiBaseUrl}${REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) return false;

      const text = await response.text();
      const payload: unknown =
        text.length > 0 ? safeJsonParse(text) : null;
      if (!isRefreshResponse(payload)) return false;

      setTokens({
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
      });
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

interface RefreshResponseBody {
  access_token: string;
  refresh_token: string;
}

function isRefreshResponse(value: unknown): value is RefreshResponseBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === 'string' && typeof v.refresh_token === 'string'
  );
}

/**
 * Reacts to a 401 that we could not (or chose not to) refresh: drop
 * both tokens and redirect to /login. A hard `window.location` redirect
 * (rather than the router) is used deliberately — the fetch layer must
 * stay decoupled from React/router, and a full reload guarantees all
 * in-memory app state is discarded. Guarded so it is a no-op outside a
 * browser (tests / SSR).
 */
function handleUnauthenticated(): void {
  clearTokens();
  if (typeof window === 'undefined') return;
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
