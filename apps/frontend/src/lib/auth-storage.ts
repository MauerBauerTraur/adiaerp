/**
 * JWT token persistence (access + refresh).
 *
 * Sprint 3 added a refresh-token flow on the backend:
 *  - access token TTL 1h
 *  - refresh token TTL 30d, rotated on every refresh
 *
 * Both tokens are stored in `localStorage` so a session survives page
 * reloads; an in-memory copy avoids repeated storage reads on every
 * `apiRequest` call.
 *
 * XSS TRADEOFF (accepted technical debt — code-reviewer Sprint 0):
 * Tokens live in localStorage rather than an httpOnly cookie because
 * spec §4 requires `Authorization: Bearer <JWT>` on every endpoint.
 * ADIA is a single-company internal ERP, so the Bearer-header + storage
 * model is kept; access to the tokens is funnelled through this module,
 * keeping the XSS surface to one auditable point. The 1h access TTL +
 * rotated refresh narrows the blast radius further.
 */
const ACCESS_KEY = 'adia.access_token';
const REFRESH_KEY = 'adia.refresh_token';
/**
 * F4.1 / ADR-0012 — persisted active-location id. The backend is
 * stateless: every request carries `X-Active-Location: <id>` (via
 * `apiRequest`). Storing the choice in localStorage keeps it stable
 * across page reloads; clearing it on logout is mandatory so the next
 * user does not inherit the previous user's scope.
 */
const ACTIVE_LOCATION_KEY = 'adia.active_location';

let memoryAccess: string | null = null;
let memoryRefresh: string | null = null;
let memoryActiveLocation: number | null = null;
/**
 * Tracks whether `memoryActiveLocation` has already been hydrated from
 * storage. Distinguishes the "fresh load, never read" state (need to
 * read storage) from the "explicitly cleared" state (`null`, do not
 * re-read) so `setActiveLocation(null)` is durable.
 */
let activeLocationHydrated = false;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — keep in-memory copy only */
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getAccessToken(): string | null {
  if (memoryAccess !== null) return memoryAccess;
  memoryAccess = readStorage(ACCESS_KEY);
  return memoryAccess;
}

export function getRefreshToken(): string | null {
  if (memoryRefresh !== null) return memoryRefresh;
  memoryRefresh = readStorage(REFRESH_KEY);
  return memoryRefresh;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function setTokens({ accessToken, refreshToken }: TokenPair): void {
  memoryAccess = accessToken;
  memoryRefresh = refreshToken;
  writeStorage(ACCESS_KEY, accessToken);
  writeStorage(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  memoryAccess = null;
  memoryRefresh = null;
  removeStorage(ACCESS_KEY);
  removeStorage(REFRESH_KEY);
  // F4.1 — clearing the session must also drop the active-location
  // selection so the next sign-in starts on the user's primary.
  // `activeLocationHydrated` is reset so the next sign-in re-reads
  // storage if a value reappears there (e.g. via direct manipulation
  // in tests, or a concurrent tab).
  memoryActiveLocation = null;
  activeLocationHydrated = false;
  removeStorage(ACTIVE_LOCATION_KEY);
}

/**
 * F4.1 / ADR-0012 — the active location currently scoping the user's
 * RBAC view. Returns `null` when the user has not picked one yet (the
 * backend then falls back to the user's primary location).
 */
export function getActiveLocation(): number | null {
  if (activeLocationHydrated) return memoryActiveLocation;
  const raw = readStorage(ACTIVE_LOCATION_KEY);
  if (raw === null) {
    memoryActiveLocation = null;
  } else {
    const parsed = Number.parseInt(raw, 10);
    memoryActiveLocation = Number.isFinite(parsed) ? parsed : null;
  }
  activeLocationHydrated = true;
  return memoryActiveLocation;
}

export function setActiveLocation(id: number | null): void {
  memoryActiveLocation = id;
  activeLocationHydrated = true;
  if (id === null) {
    removeStorage(ACTIVE_LOCATION_KEY);
  } else {
    writeStorage(ACTIVE_LOCATION_KEY, String(id));
  }
}
