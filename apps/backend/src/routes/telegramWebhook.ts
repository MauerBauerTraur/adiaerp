/**
 * F3.3 / ADR-0011 — production-mode Telegram webhook endpoint.
 *
 *   POST /api/telegram/webhook
 *
 * Telegram POSTs every update (message, callback_query, ...) here.
 * The route is **public** (no JWT) — authentication comes from a shared
 * secret Telegram echoes in the `X-Telegram-Bot-Api-Secret-Token`
 * header, compared with `timingSafeEqual` to defeat timing side
 * channels. The corresponding env var is `TELEGRAM_WEBHOOK_SECRET`; when
 * it is empty (dev / test) the route refuses ALL requests with 403, so
 * no accidental production traffic ever leaks through a misconfigured
 * environment.
 *
 * Once authenticated, the body is handed to Grammy
 * (`bot.handleUpdate(req.body)`) which routes the update to the
 * registered `callback_query:data` handler. We respond 200 OK as soon
 * as Grammy resolves — Telegram does not retry on 2xx.
 */
import { Router } from 'express';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ensureCallbackHandlerWired, getTelegramBot } from '../integrations/telegram/bot.js';

export const telegramWebhookRouter: Router = Router();

/**
 * Constant-time comparison that handles unequal lengths safely. Returns
 * false instead of throwing when one side is empty — that means the
 * server has no secret configured, which we treat as a refusal.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  // `timingSafeEqual` requires equal-length buffers — pad the shorter
  // side with random bytes so the comparison still runs in constant
  // time AND can never match (different lengths means different
  // secrets, period).
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Drain the comparison against random padding so the time profile
    // is the same for "wrong length" vs "wrong content".
    timingSafeEqual(ab, randomBytes(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

telegramWebhookRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const cfg = loadConfig();
    const expected = cfg.bot.webhookSecret;
    const received = (req.header('X-Telegram-Bot-Api-Secret-Token') ?? '').trim();

    if (expected === '') {
      // Webhook explicitly not configured — refuse to avoid acting on
      // unauthenticated traffic in a dev/test environment that happens
      // to expose this endpoint.
      res.status(403).json({ error: { code: 'WEBHOOK_DISABLED', message: 'Webhook is not configured.' } });
      return;
    }

    if (!safeEqual(expected, received)) {
      res.status(403).json({ error: { code: 'INVALID_WEBHOOK_SECRET', message: 'Invalid webhook secret.' } });
      return;
    }

    if (cfg.bot.token === '') {
      // Server configured a secret but no token — refuse cleanly.
      res.status(503).json({ error: { code: 'BOT_NOT_CONFIGURED', message: 'BOT_TOKEN is empty.' } });
      return;
    }

    // Lazy-wire the callback handler on first hit so the prod path does
    // not require a separate boot-time step. Idempotent.
    ensureCallbackHandlerWired();

    const bot = getTelegramBot() as unknown as {
      handleUpdate(update: unknown): Promise<void>;
    };

    try {
      // The bot handler swallows its own errors (the inline button
      // would otherwise stay stuck "loading"), so a thrown error here
      // is a wiring/parsing failure. Log it and still return 200 — a
      // 5xx would make Telegram retry, which doubles the audit row
      // count under load.
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('[telegram-webhook] handleUpdate failed:', (err as Error).message);
    }

    res.status(200).json({ ok: true });
  }),
);
