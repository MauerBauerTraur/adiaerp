/**
 * F3.3 / ADR-0011 — Telegram `callback_query:data` handler.
 *
 * The Grammy bot is wired in `bot.ts` to call `handleCallbackQuery(ctx)`
 * for every inline-button press. `ctx` is a deliberately small adapter
 * around Grammy's `CallbackQueryContext` so this module is fully unit-
 * testable without spinning up a real Bot.
 *
 * The flow (ADR-0011 §4):
 *
 *   1. Idempotency — try to insert `telegram_callback_actions(update_id)`
 *      first; the UNIQUE constraint stops a Telegram retry from running
 *      the same action twice. If the insert fails with 23505 we record a
 *      `duplicate` and answer the callback.
 *   2. Spoofing — look up `users WHERE telegram_id = ctx.from.id AND
 *      is_active`. Missing user → `rejected_unauthorized`.
 *   3. Parse + RBAC + dispatch — `dispatchCallback` runs the domain
 *      service (or returns 'rbac' / 'invalid' / 'failed').
 *   4. Update the audit row with the final status + result/error, write
 *      the matching `audit_log` row, and answer the callback.
 *   5. On a successful mutation that asks for it, remove the buttons via
 *      `editMessageReplyMarkup` (best-effort — `await` failure is logged
 *      but never re-raised).
 *
 * The whole flow swallows exceptions at the outer boundary: a Grammy
 * handler that throws would log a stack trace and leave the inline
 * button stuck in the "loading" state for the user — neither helpful
 * nor recoverable. We always end with `answerCallbackQuery`.
 */
import { query } from '../../db/index.js';
import { writeAudit, poolRunner } from '../../lib/audit.js';
import {
  dispatchCallback,
  lookupTelegramUser,
  parseCallbackData,
  type CallbackPrincipal,
  type DispatchOutcome,
} from './dispatch.js';

/**
 * The minimal adapter the bot.ts wire-up provides — kept narrow so the
 * unit test passes a plain object. Every async method returns the value
 * the Telegram API would return; the handler never inspects it.
 */
export type CallbackContext = {
  readonly updateId: number;
  readonly callbackQueryId: string;
  /** Telegram numeric user id of the presser. */
  readonly fromTelegramId: number;
  /** Raw callback_data string. */
  readonly data: string;
  readonly chatId: number | null;
  readonly messageId: number | null;
  answerCallbackQuery(text: string, opts?: { showAlert?: boolean }): Promise<unknown>;
  sendMessage(text: string, opts?: { reply_markup?: unknown; parse_mode?: string }): Promise<unknown>;
  /** Strip the inline keyboard from the source message (best-effort). */
  editReplyMarkup(): Promise<unknown>;
};

type AuditStatus =
  | 'processed'
  | 'rejected_unauthorized'
  | 'rejected_rbac'
  | 'failed'
  | 'duplicate';

/** PostgreSQL SQLSTATE for unique_violation. */
const SQLSTATE_UNIQUE_VIOLATION = '23505';

export async function handleCallbackQuery(ctx: CallbackContext): Promise<void> {
  // -------- 1. Idempotency: try to insert the audit row first ----------
  // We start with status='processed' as the optimistic placeholder and
  // patch it later. A UNIQUE collision on `update_id` means Telegram is
  // retrying — we already handled this update, so just answer and bail.
  let actionRowId: number | null = null;
  try {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO telegram_callback_actions
         (update_id, callback_query_id, from_telegram_id, callback_data, status)
       VALUES ($1, $2, $3, $4, 'processed')
       RETURNING id`,
      [
        ctx.updateId,
        ctx.callbackQueryId,
        String(ctx.fromTelegramId),
        ctx.data,
      ],
    );
    actionRowId = rows[0]?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Re-process attempt — the previous run owns the audit row.
      await safeAnswer(ctx, 'Allaqachon qayta ishlangan', { showAlert: false });
      return;
    }
    // Any other DB error: we cannot guarantee idempotency, so abort
    // safely (the bot will appear unresponsive — which is correct: the
    // server is broken, doing the action would be unsafe).
    console.error('[telegram-callback] audit insert failed:', (err as Error).message);
    await safeAnswer(ctx, 'Server xatosi', { showAlert: true });
    return;
  }

  // -------- 2. Spoofing — lookup user by telegram_id --------------------
  let principal: CallbackPrincipal | null;
  try {
    principal = await lookupTelegramUser(ctx.fromTelegramId);
  } catch (err) {
    await finalizeAudit(actionRowId, {
      status: 'failed',
      errorDetail: `user lookup failed: ${(err as Error).message}`.slice(0, 500),
    });
    await safeAnswer(ctx, 'Server xatosi', { showAlert: true });
    return;
  }
  if (principal === null) {
    await finalizeAudit(actionRowId, { status: 'rejected_unauthorized' });
    await writeAudit(poolRunner, {
      actorUserId: null,
      action: 'telegram_callback.rejected_unauthorized',
      entity: 'telegram_callback_actions',
      entityId: actionRowId,
      payload: {
        from_telegram_id: String(ctx.fromTelegramId),
        callback_data: ctx.data,
      },
    });
    await safeAnswer(ctx, 'Foydalanuvchi topilmadi', { showAlert: true });
    return;
  }

  // Backfill the resolved user id on the audit row.
  await query(
    `UPDATE telegram_callback_actions SET user_id = $2 WHERE id = $1`,
    [actionRowId, principal.userId],
  );

  // -------- 3. Parse + dispatch -----------------------------------------
  const parsed = parseCallbackData(ctx.data);
  if (parsed === null) {
    await finalizeAudit(actionRowId, {
      status: 'failed',
      errorDetail: 'callback_data parse failed',
    });
    await safeAnswer(ctx, "Noto'g'ri tugma", { showAlert: true });
    return;
  }

  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchCallback(parsed, principal);
  } catch (err) {
    outcome = {
      kind: 'failed',
      message: 'Server xatosi',
      error: (err as Error).message,
    };
  }

  // -------- 4. Persist final status + audit_log -------------------------
  const auditStatus: AuditStatus = ({
    ok: 'processed',
    rbac: 'rejected_rbac',
    invalid: 'failed',
    failed: 'failed',
  } as const)[outcome.kind];

  const result =
    outcome.kind === 'ok' && outcome.result !== undefined ? outcome.result : null;
  const errorDetail =
    outcome.kind === 'failed' ? outcome.error.slice(0, 500) :
    outcome.kind === 'invalid' ? outcome.message.slice(0, 500) :
    null;

  await finalizeAudit(actionRowId, {
    status: auditStatus,
    result,
    errorDetail,
  });
  await writeAudit(poolRunner, {
    actorUserId: principal.userId,
    action: `telegram_callback.${auditStatus}`,
    entity: 'telegram_callback_actions',
    entityId: actionRowId,
    payload: {
      verb: parsed.verb,
      entity: parsed.entity,
      target_id: parsed.id,
      outcome: outcome.kind,
    },
  });

  // -------- 5. Answer + optionally strip the buttons --------------------
  const showAlert = outcome.kind !== 'ok';
  await safeAnswer(ctx, outcome.message, { showAlert });

  if (outcome.kind === 'ok' && outcome.removeButtons === true) {
    // editMessageReplyMarkup may fail if Telegram refuses (message too
    // old, no rights, etc.). The audit row already reflects the verdict;
    // a UI-side keyboard that lingers is a minor cosmetic issue, not a
    // correctness bug.
    try {
      await ctx.editReplyMarkup();
    } catch (err) {
      console.error(
        '[telegram-callback] editReplyMarkup failed:',
        (err as Error).message,
      );
    }
  }

  // 'view' produces a follow-up detail message; 'ok' outcomes with
  // `followUp` send an additional message with inline keyboard.
  if (outcome.kind === 'ok' && outcome.followUp !== undefined) {
    try {
      await ctx.sendMessage(outcome.followUp.text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: outcome.followUp.buttons },
      });
    } catch (err) {
      console.error('[telegram-callback] followUp sendMessage failed:', (err as Error).message);
    }
  }

  if (outcome.kind === 'ok' && parsed.verb === 'view') {
    try {
      await ctx.sendMessage(outcome.message);
    } catch (err) {
      console.error('[telegram-callback] view sendMessage failed:', (err as Error).message);
    }
  }
}

/** UPDATE the placeholder audit row with the final verdict. */
async function finalizeAudit(
  actionRowId: number | null,
  opts: {
    readonly status: AuditStatus;
    readonly result?: unknown;
    readonly errorDetail?: string | null;
  },
): Promise<void> {
  if (actionRowId === null) return;
  await query(
    `UPDATE telegram_callback_actions
        SET status = $2::telegram_callback_status,
            result = $3,
            error_detail = $4
      WHERE id = $1`,
    [
      actionRowId,
      opts.status,
      opts.result === undefined || opts.result === null
        ? null
        : (JSON.stringify(opts.result) as unknown as string),
      opts.errorDetail ?? null,
    ],
  );
}

/**
 * `answerCallbackQuery` is mandatory — Telegram leaves the button in a
 * "loading" state for ~30s otherwise. We swallow any error: a failed
 * answer (e.g. network glitch) is unrecoverable at this layer.
 */
async function safeAnswer(
  ctx: CallbackContext,
  text: string,
  opts?: { showAlert?: boolean },
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text, opts);
  } catch (err) {
    console.error('[telegram-callback] answerCallbackQuery failed:', (err as Error).message);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === SQLSTATE_UNIQUE_VIOLATION
  );
}
