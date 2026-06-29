/**
 * Grammy bot — outbound + inbound (F3.3 / ADR-0011).
 *
 * Faza-1 used Telegram as a one-way notification channel: the
 * `telegramOutbox` worker reads `notifications` rows where
 * `telegram_sent = FALSE` and pushes each one through `bot.api.sendMessage`.
 *
 * Faza-3 turns the bot two-way: managers tap inline buttons under those
 * notifications, the bot receives a `callback_query`, validates the
 * presser against `users.telegram_id`, enforces RBAC, runs the matching
 * domain service, and answers the callback.
 *
 * Deploy modes (ADR-0011 §1):
 *   - Development: long polling (`bot.start()`) — no public URL needed.
 *   - Production:  webhook (`POST /api/telegram/webhook`) — Express
 *     hands each Telegram update to `bot.handleUpdate(req.body)`.
 *
 * Test mode is a no-op — the integration tests never construct a real
 * Grammy `Bot` (empty BOT_TOKEN → `getTelegramBot()` throws, the outbox
 * worker bails, callback handlers are never wired).
 *
 * The factory is lazy: the first call constructs a Grammy `Bot`, every
 * later call returns the cached instance. `resetBotCache()` exists for
 * tests that mock `Bot` and need a fresh build.
 */
import { Bot, type BotConfig } from 'grammy';
import { loadConfig } from '../../config/index.js';
import { handleCallbackQuery, type CallbackContext } from './callbackHandler.js';
import { handleStartCommand, type StartContext } from './startCommand.js';
import { wireVoiceHandler } from './voiceHandler.js';
import { handleCashShiftMessage, type CashShiftCtxLike } from './cashShiftHandler.js';
import { handleZayavkalarCommand, type ZayavkalarContext } from './commands/zayavkalarCommand.js';
import { handleJonatishCommand, type JonatishContext } from './commands/jonatishCommand.js';

/**
 * Minimal surface the outbox worker needs from a Grammy bot. Kept narrow
 * so tests can pass a `vi.fn()` stub instead of a real Grammy client.
 *
 * `sendMessage(other)` carries `reply_markup` for F3.3 inline keyboards.
 */
export type SendableBot = {
  api: {
    sendMessage(
      chatId: number | string,
      text: string,
      other?: Record<string, unknown>,
    ): Promise<unknown>;
  };
};

/**
 * Inbound surface used by the webhook route. `handleUpdate` is Grammy's
 * native entry point — `apps/backend/src/routes/telegramWebhook.ts`
 * forwards parsed JSON updates to it.
 */
export type InboundBot = SendableBot & {
  handleUpdate(update: unknown): Promise<void>;
  start(opts?: { drop_pending_updates?: boolean }): Promise<void>;
  stop(): Promise<void>;
};

let cached: SendableBot | undefined;
let inboundWired = false;

/**
 * Return a Grammy bot built from `cfg.bot.token`. Throws if the token is
 * empty — callers MUST gate on `cfg.bot.token !== ''` (the outbox worker
 * does this and is simply not started when the token is missing).
 *
 * `options` is forwarded to Grammy verbatim so tests can pass a stub
 * BotConfig (e.g. `client.canUseWebhookReply` indirection).
 */
export function getTelegramBot(options?: BotConfig<never>): SendableBot {
  if (cached !== undefined) return cached;
  const cfg = loadConfig();
  if (cfg.bot.token === '') {
    throw new Error(
      'getTelegramBot(): BOT_TOKEN is empty. Gate the call on cfg.bot.token first.',
    );
  }
  cached = new Bot(cfg.bot.token, options) as unknown as SendableBot;
  return cached;
}

/**
 * Wire the `callback_query:data` handler onto the cached bot. Idempotent
 * — calling twice is harmless because Grammy `bot.on` is additive but we
 * gate the registration on a module-level flag.
 *
 * Test mode (no BOT_TOKEN) is a no-op.
 */
export function ensureCallbackHandlerWired(): void {
  if (inboundWired) return;
  const cfg = loadConfig();
  if (cfg.bot.token === '') return;
  const bot = getTelegramBot() as unknown as Bot;
  bot.on('callback_query:data', async (ctx) => {
    // Defensive — Grammy guarantees `callbackQuery` exists for this
    // event, but the dispatcher needs `update_id`, `from.id`, `data`,
    // and `id` so we re-extract them through an opaque CallbackContext
    // (the handler is unit-tested with a plain object).
    const update = ctx.update;
    const cq = ctx.callbackQuery;
    if (cq === undefined) return;
    const ctxAdapter: CallbackContext = {
      updateId: update.update_id,
      callbackQueryId: cq.id,
      fromTelegramId: cq.from.id,
      data: cq.data ?? '',
      chatId: cq.message?.chat?.id ?? null,
      messageId: cq.message?.message_id ?? null,
      answerCallbackQuery: (text, opts) =>
        ctx.answerCallbackQuery({ text, show_alert: opts?.showAlert ?? false }),
      sendMessage: (text, opts) => {
        const chatId = cq.message?.chat?.id;
        if (chatId === undefined) return Promise.resolve();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ctx.api.sendMessage(chatId, text, opts as any).then(() => undefined);
      },
      editReplyMarkup: () => {
        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;
        if (chatId === undefined || messageId === undefined) return Promise.resolve();
        return ctx.api
          .editMessageReplyMarkup(chatId, messageId, {
            reply_markup: { inline_keyboard: [] },
          })
          .then(() => undefined)
          .catch(() => undefined); // best-effort; failure is non-fatal
      },
    };
    await handleCallbackQuery(ctxAdapter);
  });
  // EPIC 3.2 — `/start <token>` Telegram self-link command. The only
  // link verb added to the Telegram layer; production/cash flows untouched.
  bot.command('start', async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;
    // Grammy strips the `/start` prefix into `ctx.match` (the deep-link
    // payload). An empty payload is a plain greeting, not a link attempt.
    const token = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const startCtx: StartContext = {
      fromTelegramId: fromId,
      token,
      reply: (text) => ctx.reply(text).then(() => undefined),
    };
    await handleStartCommand(startCtx);
  });
  // F4.3 / ADR-0014 — message:voice handler. `wireVoiceHandler` ham idempotent
  // (Grammy bot.on additive, lekin `inboundWired` flag dublikatlarni
  // bo'g'adi).
  wireVoiceHandler(bot);
  // /zayavkalar — bugungi ishlab chiqarish zayavkalari ro'yxati
  bot.command('zayavkalar', async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;
    const cmdCtx: ZayavkalarContext = {
      fromTelegramId: fromId,
      text: ctx.message?.text ?? '/zayavkalar',
      reply: (text, opts) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.reply(text, { parse_mode: 'Markdown', ...(opts as any) }).then(() => undefined),
    };
    try {
      await handleZayavkalarCommand(cmdCtx);
    } catch (err) {
      console.error('[telegram-zayavkalar] uncaught:', (err as Error).message);
    }
  });

  // /jonatish — bugungi sklad jo'natish ro'yxati
  bot.command('jonatish', async (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return;
    const cmdCtx: JonatishContext = {
      fromTelegramId: fromId,
      text: ctx.message?.text ?? '/jonatish',
      reply: (text, opts) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.reply(text, { parse_mode: 'Markdown', ...(opts as any) }).then(() => undefined),
    };
    try {
      await handleJonatishCommand(cmdCtx);
    } catch (err) {
      console.error('[telegram-jonatish] uncaught:', (err as Error).message);
    }
  });

  // EPIC 8.5 — kassir smena topshirig'i (message:text). FAQAT smena
  // topshirig'iga o'xshagan matnga javob beradi (`looksLikeCashShift`); boshqa
  // matnni e'tiborsiz qoldiradi. `/start` command'i alohida handler'da —
  // Grammy command'ni message:text dan oldin ushlaydi, to'qnashuv yo'q.
  bot.on('message:text', async (ctx) => {
    try {
      await handleCashShiftMessage(ctx as unknown as CashShiftCtxLike);
    } catch (err) {
      console.error('[telegram-cashshift] uncaught:', (err as Error).message);
    }
  });
  inboundWired = true;
}

/**
 * Start long polling (development). Resolves once Grammy has confirmed
 * `getMe` and is consuming updates. The caller MUST `await stopBot()`
 * before exiting to drain in-flight handlers.
 *
 * In test mode (empty token) this is a no-op.
 */
export async function startBotLongPolling(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.bot.token === '') return;
  ensureCallbackHandlerWired();
  const bot = getTelegramBot() as unknown as InboundBot;
  // `drop_pending_updates: true` keeps a fresh dev restart from re-
  // processing every press queued up while the server was down — those
  // are likely stale anyway. Production webhooks deliver exactly-once
  // semantics (modulo retries), so this flag is dev-specific.
  // Fire-and-forget: Grammy's `bot.start()` runs until `bot.stop()`
  // is called, so the caller must NOT await this directly.
  void bot.start({ drop_pending_updates: true });
}

/**
 * Stop the bot. Cancels polling (dev) and lets Grammy drain its
 * in-flight handlers. Webhook mode has no long-running task to stop.
 */
export async function stopBot(): Promise<void> {
  if (cached === undefined) return;
  const bot = cached as unknown as InboundBot;
  if (typeof bot.stop === 'function') {
    try {
      await bot.stop();
    } catch {
      // Grammy throws when `stop` is called before `start`; ignore.
    }
  }
}

/**
 * TEST-ONLY — wipe the cached bot so a new `getTelegramBot()` call returns
 * a fresh instance (used by mocked-Grammy unit tests). Production code never
 * calls this.
 */
export function resetBotCache(): void {
  cached = undefined;
  inboundWired = false;
}

/**
 * TEST-ONLY — inject a custom bot instance. Lets the outbox-worker unit test
 * pass a `vi.fn()`-backed `sendMessage` without spinning up a real Grammy
 * client (which would refuse to construct without a valid token).
 */
export function setTelegramBotForTesting(bot: SendableBot | undefined): void {
  cached = bot;
  inboundWired = false;
}
