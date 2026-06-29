/**
 * M9 — Telegram outbox worker (spec §2.9.1).
 *
 * Every 30 seconds, scan `notifications` for rows that have not yet been
 * delivered (`telegram_sent = FALSE`) and have not exhausted their retry
 * budget (`telegram_send_attempts < MAX_ATTEMPTS`). For each row:
 *
 *   1. Look up the recipient's `users.telegram_id`. If missing, mark the row
 *      as a permanent failure (`error_detail = 'no telegram_id'`) and leave
 *      `telegram_sent = FALSE` — we are not going to retry without an id.
 *   2. Call Grammy `bot.api.sendMessage(telegram_id, text)`. On success, set
 *      `telegram_sent = TRUE`, `telegram_sent_at = now()`.
 *   3. On failure, increment `telegram_send_attempts`, store the truncated
 *      `error_detail`, and let the next cycle try again (until MAX_ATTEMPTS).
 *
 * Overlap guard mirrors `replenishmentScan` — a slow Telegram round-trip
 * must not let the next 30-second tick fire a parallel cycle and send the
 * same message twice. The guard is module-scope (single Node process /
 * single PM2 instance per CLAUDE.md §5 deployment).
 *
 * I3 (Sprint 3 audit) — DEPLOY CONSTRAINT: Faza-1 deploy assumes PM2 fork
 * mode with a SINGLE API instance plus the cron worker in-process. The
 * `cronGuard.running` flag is process-local — running two Node instances
 * (cluster mode or a second VM) would double-send messages.
 * BEFORE switching to PM2 cluster mode, this worker MUST adopt the
 * `SELECT ... FOR UPDATE SKIP LOCKED` pattern on `notifications` so each
 * row is owned by exactly one worker. See ADR-0005 (deploy constraints).
 *
 * The worker NEVER throws: a Grammy failure stays inside `attemptSend`, a
 * SQL failure for a single row is logged and the loop continues, and a
 * fatal cycle error is logged then swallowed (same pattern as the other
 * workers).
 */
import cron from 'node-cron';
import { query } from '../db/index.js';
import { getTelegramBot, type SendableBot } from '../integrations/telegram/bot.js';

/** Cron expression — every 30 seconds. */
export const TELEGRAM_OUTBOX_SCHEDULE = '*/30 * * * * *';

/** Maximum send retries before a row is skipped permanently. */
export const MAX_SEND_ATTEMPTS = 5;

/** Max rows handled per cycle — keeps a single tick bounded. */
export const BATCH_LIMIT = 50;

/** Truncate `error_detail` to keep audit/log payloads compact. */
const ERROR_DETAIL_MAX_LEN = 500;

let task: cron.ScheduledTask | undefined;

/** Re-entrancy guard — exported for tests. */
export const cronGuard: { running: boolean } = { running: false };

/**
 * Start the outbox cron. Idempotent — a second call returns the existing task
 * instead of double-scheduling. Returns the scheduled task for tests.
 */
export function startTelegramOutboxWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(TELEGRAM_OUTBOX_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

/** Stop the outbox cron (used by tests and the graceful-shutdown handler). */
export function stopTelegramOutboxWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/**
 * Run one outbox cycle. Exported so the integration test (or a future admin
 * endpoint) can drive a cycle synchronously without waiting for the cron.
 *
 * @param botOverride lets tests inject a mocked Grammy surface; production
 *                    code never passes anything.
 */
export async function runOneCycle(botOverride?: SendableBot): Promise<void> {
  if (cronGuard.running) {
    console.log('[telegram-outbox] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const bot = botOverride ?? safelyGetBot();
    if (bot === undefined) {
      // No token configured -> the outbox stays a no-op. The worker is only
      // started when the token is non-empty, but we still defend here so a
      // misconfigured restart never crashes.
      return;
    }

    const { rows } = await query<{
      id: number;
      recipient_user_id: number | null;
      body: string;
      title: string;
      telegram_send_attempts: number;
      inline_callback: unknown;
    }>(
      `SELECT n.id, n.recipient_user_id, n.body, n.title,
              n.telegram_send_attempts, n.inline_callback
         FROM notifications n
        WHERE n.telegram_sent = FALSE
          AND n.telegram_send_attempts < $1
          AND n.type NOT IN ('negative_stock_detected', 'wrong_keyed_check')
        ORDER BY n.id
        LIMIT $2`,
      [MAX_SEND_ATTEMPTS, BATCH_LIMIT],
    );

    let delivered = 0;
    let failed = 0;
    let missing = 0;
    for (const row of rows) {
      try {
        const outcome = await deliverOne(bot, row);
        if (outcome === 'sent') delivered += 1;
        else if (outcome === 'no-recipient') missing += 1;
        else failed += 1;
      } catch (err) {
        // A single row's bookkeeping SQL failed — log and keep the loop alive.
        console.error(
          `[telegram-outbox] notification ${row.id} bookkeeping failed:`,
          (err as Error).message,
        );
      }
    }

    if (rows.length > 0) {
      console.log(
        `[telegram-outbox] processed=${rows.length} delivered=${delivered} ` +
          `failed=${failed} no_telegram_id=${missing}`,
      );
    }
  } catch (err) {
    console.error('[telegram-outbox] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}

/**
 * Wrapper around `getTelegramBot()` that returns `undefined` instead of
 * throwing when the token is empty. The worker treats that as a soft skip.
 */
function safelyGetBot(): SendableBot | undefined {
  try {
    return getTelegramBot();
  } catch {
    return undefined;
  }
}

type OutboxRow = {
  id: number;
  recipient_user_id: number | null;
  body: string;
  title: string;
  telegram_send_attempts: number;
  /**
   * F3.3 / ADR-0011 — the JSONB `notifications.inline_callback` column.
   * `pg` returns JSONB as already-parsed JS values (object | array | null),
   * but we type it as `unknown` so the worker stays defensive against a
   * malformed row leaking through (e.g. a hand-edited row in the DB).
   */
  inline_callback: unknown;
};

type Outcome = 'sent' | 'failed' | 'no-recipient';

/**
 * Deliver one notification row. Returns the outcome; the caller uses it for
 * the summary log. SQL errors propagate so the per-row catch can log them.
 */
async function deliverOne(bot: SendableBot, row: OutboxRow): Promise<Outcome> {
  if (row.recipient_user_id === null) {
    // No recipient means we will NEVER be able to deliver this row — cap the
    // attempts counter so the SELECT loop in `runOneCycle` filters this row
    // out on subsequent ticks. Without the cap the row would be re-selected
    // every 30s forever (resource leak — see Sprint 3 audit P1).
    await query(
      `UPDATE notifications
          SET error_detail = $2,
              telegram_send_attempts = $3
        WHERE id = $1`,
      [row.id, 'no recipient_user_id', MAX_SEND_ATTEMPTS],
    );
    return 'no-recipient';
  }

  const { rows: userRows } = await query<{ telegram_id: string | null }>(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [row.recipient_user_id],
  );
  const tgIdRaw = userRows[0]?.telegram_id;
  if (tgIdRaw === null || tgIdRaw === undefined) {
    // Same rationale as above — no telegram_id, no retry is meaningful. Cap
    // `telegram_send_attempts` directly so the next SELECT cycle excludes
    // the row (the WHERE clause is `telegram_send_attempts < MAX_SEND_ATTEMPTS`).
    // If the user is later given a telegram_id the row will still be
    // permanently capped — that is acceptable: the audit log holds the
    // original notification and an admin can re-issue if needed.
    await query(
      `UPDATE notifications
          SET error_detail = $2,
              telegram_send_attempts = $3
        WHERE id = $1`,
      [row.id, 'no telegram_id', MAX_SEND_ATTEMPTS],
    );
    return 'no-recipient';
  }

  // `users.telegram_id` is BIGINT and pg returns it as a string. Telegram
  // chat ids are 64-bit integers; pass the string-form through to Grammy
  // (it accepts string | number) to avoid precision loss for large ids.
  const chatId = typeof tgIdRaw === 'string' ? tgIdRaw : String(tgIdRaw);
  const text = formatMessage(row);
  // F3.3 — attach the inline keyboard when the row has one. A malformed
  // payload (`unknown` shape, missing buttons) silently degrades to "no
  // keyboard"; we never want one bad row to abort the cycle.
  const replyMarkup = buildReplyMarkup(row.inline_callback);
  const sendOpts: Record<string, unknown> = {};
  if (replyMarkup !== undefined) {
    sendOpts.reply_markup = replyMarkup;
  }

  try {
    await bot.api.sendMessage(chatId, text, sendOpts);
    await query(
      `UPDATE notifications
          SET telegram_sent = TRUE,
              telegram_sent_at = now(),
              error_detail = NULL
        WHERE id = $1`,
      [row.id],
    );
    return 'sent';
  } catch (err) {
    const detail = ((err as Error).message ?? 'unknown').slice(0, ERROR_DETAIL_MAX_LEN);
    await query(
      `UPDATE notifications
          SET telegram_send_attempts = telegram_send_attempts + 1,
              error_detail = $2
        WHERE id = $1`,
      [row.id, detail],
    );
    return 'failed';
  }
}

/**
 * Assemble the plain-text message body. Title goes on line one, body on
 * the rest. We deliberately avoid Markdown/HTML — Grammy will not retry a
 * `parse_mode` failure for us and the spec §9.5 demands plain text.
 */
function formatMessage(row: OutboxRow): string {
  const title = row.title.trim();
  const body = row.body.trim();
  if (title === '') return body;
  if (body === '') return title;
  return `${title}\n${body}`;
}

/**
 * Translate the stored `notifications.inline_callback` payload into a
 * Grammy `reply_markup.inline_keyboard` 2-D array.
 *
 * Returns `undefined` when the row has no buttons OR when the JSONB shape
 * is unrecognised (defensive — a single malformed row must NOT stop
 * delivery of the rest of the batch).
 *
 * Each button text is truncated at 64 chars (Telegram's hard limit) and
 * any `data` longer than 64 bytes is dropped, since Telegram would
 * otherwise refuse the message and fail the send.
 */
function buildReplyMarkup(raw: unknown): { inline_keyboard: unknown[][] } | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object') return undefined;
  const buttons = (raw as { buttons?: unknown }).buttons;
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (const row of buttons) {
    if (!Array.isArray(row)) continue;
    const line: { text: string; callback_data: string }[] = [];
    for (const btn of row) {
      if (btn === null || typeof btn !== 'object') continue;
      const text = (btn as { text?: unknown }).text;
      const data = (btn as { data?: unknown }).data;
      if (typeof text !== 'string' || typeof data !== 'string') continue;
      if (text.length === 0 || data.length === 0) continue;
      // Telegram limits: text <= 64 chars (truncate), callback_data <= 64 bytes.
      if (Buffer.byteLength(data, 'utf8') > 64) continue;
      line.push({ text: text.slice(0, 64), callback_data: data });
    }
    if (line.length > 0) keyboard.push(line);
  }
  if (keyboard.length === 0) return undefined;
  return { inline_keyboard: keyboard };
}
