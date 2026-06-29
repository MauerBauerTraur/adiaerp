/**
 * EPIC 3.2 — Telegram `/start <token>` self-link command handler.
 *
 * The Grammy bot (`bot.ts`) wires `bot.command('start', ...)` to call
 * `handleStartCommand(ctx)`. `ctx` is a deliberately small adapter around
 * Grammy's command context so this module is fully unit-testable without a
 * real Bot — mirrors the `callbackHandler.ts` design.
 *
 * Flow:
 *   - No payload → friendly greeting (the user opened the bot directly).
 *   - `/start <token>` → redeem the single-use link token. On success the
 *     user's `users.telegram_id` is bound to the presser's Telegram id.
 *
 * This is the ONLY Telegram verb added for EPIC 3 — production/cash flows
 * are untouched.
 */
import { redeemLinkToken } from '../../services/userTelegramLink.js';

/** Minimal adapter the bot wire-up provides. */
export type StartContext = {
  /** Telegram numeric id of the sender. */
  readonly fromTelegramId: number;
  /** The deep-link payload after `/start ` (empty string when absent). */
  readonly token: string;
  /** Send a plain-text reply to the chat (best-effort). */
  reply(text: string): Promise<void>;
};

const GREETING =
  "Assalomu alaykum! Bu ADIA ERP boti.\n\n" +
  "Akkauntingizni ulash uchun ilovadagi \"Telegramni ulash\" tugmasini bosing " +
  "va chiqqan havola orqali qayta keling.";

export async function handleStartCommand(ctx: StartContext): Promise<void> {
  if (ctx.token === '') {
    await safeReply(ctx, GREETING);
    return;
  }

  let message: string;
  try {
    const outcome = await redeemLinkToken(ctx.token, ctx.fromTelegramId);
    switch (outcome.kind) {
      case 'linked':
        message =
          `✅ Akkauntingiz ulandi: ${outcome.userName}.\n` +
          "Endi bildirishnomalar shu yerga keladi.";
        break;
      case 'expired':
        message = "⏳ Havola muddati tugagan. Iltimos, ilovadan yangi havola oling.";
        break;
      case 'already_used':
        message = "ℹ️ Bu havola allaqachon ishlatilgan. Yangi havola oling.";
        break;
      case 'telegram_taken':
        message =
          "⚠️ Bu Telegram akkaunt boshqa foydalanuvchiga bog'langan. " +
          "Avval uni uzib, keyin qayta urinib ko'ring.";
        break;
      case 'invalid':
      default:
        message = "❌ Havola noto'g'ri. Iltimos, ilovadan yangi havola oling.";
        break;
    }
  } catch (err) {
    // Never let a DB error leave the user with a stuck command — answer with
    // a generic message and log the detail server-side.
    console.error('[telegram-start] redeem failed:', (err as Error).message);
    message = "Server xatosi. Birozdan so'ng qayta urinib ko'ring.";
  }
  await safeReply(ctx, message);
}

/** Swallow reply failures — a network glitch here is unrecoverable. */
async function safeReply(ctx: StartContext, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err) {
    console.error('[telegram-start] reply failed:', (err as Error).message);
  }
}
