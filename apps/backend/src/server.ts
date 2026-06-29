/**
 * Process entrypoint — boots the HTTP server.
 *
 * Validates config first (fail fast on missing env), then listens. Handles
 * SIGINT/SIGTERM for a graceful shutdown that drains the DB pool.
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closePool } from './db/index.js';
import {
  startReplenishmentScanWorker,
  stopReplenishmentScanWorker,
} from './workers/replenishmentScan.js';
import {
  startPosterStockSyncWorker,
  stopPosterStockSyncWorker,
} from './workers/posterStockSync.js';
import {
  startPosterSalesWorker,
  stopPosterSalesWorker,
} from './workers/posterSalesSync.js';
import {
  startTelegramOutboxWorker,
  stopTelegramOutboxWorker,
} from './workers/telegramOutbox.js';
import {
  startSalesAggregateWorker,
  stopSalesAggregateWorker,
} from './workers/salesAggregateCron.js';
import {
  startMinmaxRecalcWorker,
  stopMinmaxRecalcWorker,
} from './workers/minmaxRecalcCron.js';
import {
  startRefreshTokenCleanupWorker,
  stopRefreshTokenCleanupWorker,
} from './workers/refreshTokenCleanupCron.js';
import {
  startActionExpireWorker,
  stopActionExpireWorker,
} from './workers/actionExpireCron.js';
import {
  startProductionDialogExpireWorker,
  stopProductionDialogExpireWorker,
} from './workers/productionDialogExpireCron.js';
import {
  startForecastRefreshWorker,
  stopForecastRefreshWorker,
} from './workers/forecastRefreshCron.js';
import {
  startVoiceCleanupWorker,
  stopVoiceCleanupWorker,
} from './workers/voiceCleanupCron.js';
import {
  startPosterRecipeSyncWorker,
  stopPosterRecipeSyncWorker,
  runRecipeSyncCycle,
} from './workers/posterRecipeSync.js';
import {
  ensureCallbackHandlerWired,
  startBotLongPolling,
  stopBot,
} from './integrations/telegram/bot.js';

function main(): void {
  const cfg = loadConfig(); // throws clearly on missing/invalid env
  const app = createApp();

  const server = app.listen(cfg.port, () => {
    console.log(`[server] ADIA ERP API listening on port ${cfg.port} (${cfg.nodeEnv})`);
  });

  // Start the replenishment scan worker once the HTTP server is up. The
  // worker runs every 5 minutes and is a no-op if the DB is empty.
  startReplenishmentScanWorker();
  console.log('[server] replenishment scan worker started (*/5 * * * *)');

  // Phase-2 F2.1 — nightly sales aggregate + dynamic min/max recalc.
  // The recalc reads the aggregate written one hour earlier (03:00 → 04:00).
  startSalesAggregateWorker();
  console.log('[server] sales aggregate worker started (0 3 * * *)');
  startMinmaxRecalcWorker();
  console.log('[server] minmax recalc worker started (0 4 * * *)');

  // Sprint-3 (ADR-0005) — daily cleanup of expired refresh tokens at 02:00.
  startRefreshTokenCleanupWorker();
  console.log('[server] refresh-token cleanup worker started (0 2 * * *)');

  // Faza-3 F3.2 (ADR-0009) — sweep pending AI write actions whose 5-minute
  // TTL has elapsed. One UPDATE per minute, atomic and idempotent.
  startActionExpireWorker();
  console.log('[server] assistant action expire worker started (* * * * *)');

  // EPIC 5 (ADR-0016) — sweep production dialogs whose 6-hour TTL has elapsed;
  // stamp EXPIRED + escalate to PM. One UPDATE per minute, atomic + idempotent.
  startProductionDialogExpireWorker();
  console.log('[server] production dialog expire worker started (* * * * *)');

  // F4.3 (ADR-0014) — har kuni 03:30 da eski voice tmp fayllarni tozalash.
  startVoiceCleanupWorker();
  console.log('[server] voice tmp cleanup worker started (30 3 * * *)');

  // Faza-3 F3.4 / ADR-0010 — Prophet forecaster sidecar refresh. Self-disables
  // when FORECASTER_URL / FORECASTER_SHARED_SECRET are not configured.
  const forecastTask = startForecastRefreshWorker();
  if (forecastTask !== undefined) {
    console.log('[server] forecast refresh worker started (30 4 * * *)');
  }

  // Poster integration workers only run when a token is configured — saves
  // log spam and avoids hammering Poster on a fresh install.
  if (cfg.poster.token !== '') {
    startPosterStockSyncWorker();
    console.log('[server] poster stock sync worker started (*/15 * * * *)');
    startPosterSalesWorker();
    console.log('[server] poster sales sync workers started (webhook 1m, fallback 30m)');
    startPosterRecipeSyncWorker();
    console.log('[server] poster recipe sync worker started (0 * * * *)');
    // Run immediately on startup so fresh Poster recipes load without waiting an hour.
    void runRecipeSyncCycle();
  } else {
    console.log('[server] poster workers skipped — POSTER_TOKEN is empty');
  }

  // Telegram outbox worker — only started when BOT_TOKEN is configured. The
  // outbox stays dormant in dev/test (the notifications still queue up; they
  // simply do not leave the database).
  if (cfg.bot.token !== '') {
    startTelegramOutboxWorker();
    console.log('[server] telegram outbox worker started (*/30 seconds)');
    // F3.3 / ADR-0011 — wire the inline-button handler. In dev/non-prod,
    // also start long polling so a developer can press buttons without a
    // public webhook URL. In production we expect Telegram to POST to
    // `/api/telegram/webhook`; the same handler runs there.
    ensureCallbackHandlerWired();
    if (cfg.nodeEnv !== 'production') {
      void startBotLongPolling();
      console.log('[server] telegram bot long-polling started (dev mode)');
    } else {
      console.log('[server] telegram bot in webhook mode — POST /api/telegram/webhook');
    }
  } else {
    console.log('[server] telegram outbox worker skipped — BOT_TOKEN is empty');
  }

  const shutdown = (signal: string): void => {
    console.log(`[server] ${signal} received — shutting down.`);
    stopReplenishmentScanWorker();
    stopPosterStockSyncWorker();
    stopPosterSalesWorker();
    stopPosterRecipeSyncWorker();
    stopTelegramOutboxWorker();
    stopSalesAggregateWorker();
    stopMinmaxRecalcWorker();
    stopRefreshTokenCleanupWorker();
    stopActionExpireWorker();
    stopProductionDialogExpireWorker();
    stopForecastRefreshWorker();
    stopVoiceCleanupWorker();
    // F3.3 — stop long-polling (if running); webhook mode has no task.
    void stopBot();
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  console.error('[server] failed to start:');
  console.error(err);
  process.exit(1);
}
