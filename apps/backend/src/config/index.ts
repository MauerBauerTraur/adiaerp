/**
 * Typed, validated configuration loader.
 *
 * Reads environment variables (from `apps/backend/.env`, loaded via dotenv)
 * and exposes a single frozen, typed `config` object. A missing required key
 * fails fast at startup with an explicit, actionable error — secrets are never
 * hard-coded (CLAUDE.md section 9).
 */
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(process.cwd(), '.env') });

export type AppConfig = {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * Allowed CORS origins for the web client (single-tenant ERP, not a public
   * API — but local dev and tests need both `localhost` and `127.0.0.1`).
   * Parsed from a comma-separated `WEB_ORIGIN` env var; defaults to the Vite
   * dev server. Bug-MAJ-02 (F4.11): single-string origin broke whichever host
   * the env did not list.
   */
  readonly webOrigins: readonly string[];
  readonly jwt: {
    readonly secret: string;
    /**
     * Legacy single-token TTL. Kept for backward compatibility with any
     * caller still reading it; new code uses `accessTtlSeconds` and the
     * refresh-token flow instead.
     *
     * @deprecated Sprint-3 (ADR-0005). Use `accessTtlSeconds` for access
     *             token expiry and `refreshTtlDays` for refresh expiry.
     */
    readonly expiresInSeconds: number;
    /** Access-token TTL — short (1h default). */
    readonly accessTtlSeconds: number;
    /** Refresh-token TTL — long (30d default). */
    readonly refreshTtlDays: number;
  };
  readonly poster: {
    readonly account: string;
    readonly appId: string;
    readonly appSecret: string;
    readonly token: string;
    /**
     * Shared secret embedded in the webhook URL Poster posts to. Used by the
     * `/api/integrations/poster/webhook[/:secret]` handler with a
     * constant-time compare. Empty -> the webhook endpoint refuses all calls.
     */
    readonly webhookSecret: string;
  };
  /**
   * Telegram bot identity used by the M9 outbox worker. Optional — when
   * `token` is empty the outbox worker is not started (development /
   * integration-test mode). `username` is informational (e.g. for help
   * messages and links) and never required.
   *
   * I2 (Sprint 3 audit) — the legacy `telegram.botToken` field was removed;
   * `bot.token` (env `BOT_TOKEN`) is the single source of truth.
   */
  readonly bot: {
    readonly token: string;
    readonly username: string;
    /**
     * F3.3 / ADR-0011 — shared secret Telegram sends in the
     * `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST.
     * Used by `routes/telegramWebhook.ts` with `timingSafeEqual`. Empty
     * in dev (long polling); REQUIRED in production webhook mode (the
     * route refuses every request when empty).
     */
    readonly webhookSecret: string;
  };
  /**
   * Phase-2 F2.2 — Vertex AI Gemini configuration for the AI assistant
   * (ADR-0006). `enabled` is true only when both a GCP project id is set
   * AND `GOOGLE_APPLICATION_CREDENTIALS` points at a readable service
   * account key. When disabled, the assistant endpoint short-circuits with
   * a clean 503 — useful for dev/test without GCP credentials.
   */
  readonly vertex: {
    readonly enabled: boolean;
    readonly projectId: string;
    readonly region: string;
    readonly model: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxToolCallsPerTurn: number;
  };
  /**
   * Faza-3 Sprint 4 / ADR-0010 — Prophet forecaster sidecar.
   * `enabled` is true only when BOTH the URL and the shared secret are
   * configured. When disabled, the nightly cron is a no-op and the
   * `/api/forecasts` route returns 503; the AI `get_forecast` tool reads
   * the cache table either way (last successful run survives until the
   * next overwrite).
   */
  /**
   * Faza-4 Sprint F4.2 / ADR-0013 — Yandex Cloud (Speech Kit STT v3 + Object
   * Storage for voice clips). `enabled` is true only when ALL of
   * `YANDEX_OAUTH_TOKEN`, `YANDEX_FOLDER_ID`, `YANDEX_BUCKET` are set. The
   * service-account access keys are required for S3 PUT uploads; without
   * them only the (small) sync recognize path works.
   */
  readonly yandex: {
    readonly enabled: boolean;
    readonly oauthToken: string;
    readonly folderId: string;
    readonly bucket: string;
    readonly saAccessKey: string;
    readonly saSecretKey: string;
  };
  readonly forecaster: {
    readonly enabled: boolean;
    readonly url: string;
    readonly sharedSecret: string;
    readonly horizonDays: number;
    readonly batchSize: number;
    readonly requestTimeoutMs: number;
  };
};

class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

/** Read a required env var; throw a clear error if absent or empty. */
function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable "${key}". ` +
        `Set it in the repo-root .env file (see .env.example).`,
    );
  }
  return value.trim();
}

/** Read an optional env var, falling back to a default. */
function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function parsePositiveInt(key: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Environment variable "${key}" must be a positive integer, got "${raw}".`);
  }
  return n;
}

function parseNodeEnv(raw: string): AppConfig['nodeEnv'] {
  if (raw === 'development' || raw === 'test' || raw === 'production') {
    return raw;
  }
  throw new ConfigError(
    `NODE_ENV must be one of "development" | "test" | "production", got "${raw}".`,
  );
}

let cached: AppConfig | undefined;

/**
 * Build and validate the config once. Subsequent calls return the cache.
 * In `test` mode, DATABASE_URL falls back to a local dev database so the
 * smoke test can run without extra setup.
 */
export function loadConfig(): AppConfig {
  if (cached !== undefined) {
    return cached;
  }

  const nodeEnv = parseNodeEnv(optional('NODE_ENV', 'development'));

  // DATABASE_URL is required outside of tests; tests get a sane local default.
  const databaseUrl =
    nodeEnv === 'test'
      ? optional('DATABASE_URL', 'postgres://localhost:5432/adia_erp_dev')
      : required('DATABASE_URL');

  // JWT secret is required outside of tests; tests get a fixed dummy secret.
  const jwtSecret =
    nodeEnv === 'test' ? optional('JWT_SECRET', 'test-only-insecure-secret') : required('JWT_SECRET');

  cached = Object.freeze({
    nodeEnv,
    port: parsePositiveInt('PORT', optional('PORT', '3001')),
    databaseUrl,
    webOrigins: (() => {
      // Comma-separated list. Empty entries are dropped so trailing commas /
      // stray whitespace in `.env` do not become an "allow everything" hole.
      const raw = optional('WEB_ORIGIN', 'http://localhost:5173');
      const list = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return Object.freeze(list.length > 0 ? list : ['http://localhost:5173']);
    })(),
    jwt: (() => {
      // Sprint-3 (ADR-0005): the single 12-hour JWT was split into a
      // 1-hour access token + 30-day refresh token. The legacy
      // `JWT_EXPIRES_IN_SECONDS` is honoured for the *access* token when
      // `JWT_ACCESS_TTL_SECONDS` is not set, so old .env files keep
      // working — but the new defaults (3600s / 30d) are picked up
      // automatically by anyone who has not set either variable.
      const legacyAccess = parsePositiveInt(
        'JWT_EXPIRES_IN_SECONDS',
        optional('JWT_EXPIRES_IN_SECONDS', '3600'),
      );
      const accessTtlSeconds = parsePositiveInt(
        'JWT_ACCESS_TTL_SECONDS',
        optional('JWT_ACCESS_TTL_SECONDS', String(legacyAccess)),
      );
      const refreshTtlDays = parsePositiveInt(
        'JWT_REFRESH_TTL_DAYS',
        optional('JWT_REFRESH_TTL_DAYS', '30'),
      );
      return Object.freeze({
        secret: jwtSecret,
        expiresInSeconds: accessTtlSeconds, // backward-compat alias
        accessTtlSeconds,
        refreshTtlDays,
      });
    })(),
    poster: Object.freeze({
      account: optional('POSTER_ACCOUNT', ''),
      appId: optional('POSTER_APP_ID', ''),
      appSecret: optional('POSTER_APP_SECRET', ''),
      token: optional('POSTER_TOKEN', ''),
      webhookSecret: optional('POSTER_WEBHOOK_SECRET', ''),
    }),
    bot: Object.freeze({
      // M9 — Grammy bot token / username (see `.env` BOT_TOKEN / BOT_USERNAME).
      // F3.3 — webhook secret (TELEGRAM_WEBHOOK_SECRET) used by the prod
      // webhook endpoint. Optional so dev / test work with empty values.
      token: optional('BOT_TOKEN', ''),
      username: optional('BOT_USERNAME', ''),
      webhookSecret: optional('TELEGRAM_WEBHOOK_SECRET', ''),
    }),
    yandex: Object.freeze({
      // F4.2 / ADR-0013 — voice pipeline.
      // OAuth token is the only secret stored long-term; IAM tokens are
      // minted on demand by integrations/yandex/auth.ts and never persisted.
      // The `enabled` gate ALSO short-circuits in NODE_ENV=test so unit
      // tests never reach out to the real Yandex API by accident.
      enabled:
        optional('YANDEX_OAUTH_TOKEN', '') !== '' &&
        optional('YANDEX_FOLDER_ID', '') !== '' &&
        optional('YANDEX_BUCKET', '') !== '' &&
        nodeEnv !== 'test',
      oauthToken: optional('YANDEX_OAUTH_TOKEN', ''),
      folderId: optional('YANDEX_FOLDER_ID', ''),
      bucket: optional('YANDEX_BUCKET', ''),
      saAccessKey: optional('YANDEX_SA_ACCESS_KEY', ''),
      saSecretKey: optional('YANDEX_SA_SECRET_KEY', ''),
    }),
    forecaster: Object.freeze({
      // F3.4 / ADR-0010 — Prophet sidecar. Both URL and shared secret must
      // be set, otherwise the feature is disabled and the cron / route /
      // tool all short-circuit (last cached row stays usable).
      enabled:
        optional('FORECASTER_URL', '') !== '' &&
        optional('FORECASTER_SHARED_SECRET', '') !== '',
      url: optional('FORECASTER_URL', 'http://localhost:8000'),
      sharedSecret: optional('FORECASTER_SHARED_SECRET', ''),
      horizonDays: parsePositiveInt(
        'FORECASTER_HORIZON_DAYS',
        optional('FORECASTER_HORIZON_DAYS', '14'),
      ),
      batchSize: parsePositiveInt(
        'FORECASTER_BATCH_SIZE',
        optional('FORECASTER_BATCH_SIZE', '50'),
      ),
      requestTimeoutMs: parsePositiveInt(
        'FORECASTER_REQUEST_TIMEOUT_MS',
        optional('FORECASTER_REQUEST_TIMEOUT_MS', '120000'),
      ),
    }),
    vertex: Object.freeze({
      // F2.2 — AI assistant. Enabled only when project + service account
      // credentials are present. Tests run with `enabled=false` so they do
      // not need GCP access and the Vertex client is fully mocked.
      enabled:
        optional('VERTEX_PROJECT_ID', '') !== '' &&
        optional('GOOGLE_APPLICATION_CREDENTIALS', '') !== '' &&
        nodeEnv !== 'test',
      projectId: optional('VERTEX_PROJECT_ID', ''),
      region: optional('VERTEX_REGION', 'europe-west1'),
      model: optional('VERTEX_MODEL', 'gemini-2.5-flash'),
      maxInputTokens: parsePositiveInt(
        'VERTEX_MAX_INPUT_TOKENS',
        optional('VERTEX_MAX_INPUT_TOKENS', '8000'),
      ),
      maxOutputTokens: parsePositiveInt(
        'VERTEX_MAX_OUTPUT_TOKENS',
        optional('VERTEX_MAX_OUTPUT_TOKENS', '2000'),
      ),
      maxToolCallsPerTurn: parsePositiveInt(
        'VERTEX_MAX_TOOL_CALLS',
        optional('VERTEX_MAX_TOOL_CALLS', '5'),
      ),
    }),
  });

  return cached;
}

/**
 * Clear the cached config. TEST-ONLY.
 *
 * `loadConfig()` memoizes its result at module scope so the whole app sees
 * one frozen config object. Tests that need to exercise `loadConfig()` under
 * different environment variables must call this between cases to force a
 * fresh build. Production code never calls this.
 */
export function resetConfigCache(): void {
  cached = undefined;
}

export { ConfigError };
