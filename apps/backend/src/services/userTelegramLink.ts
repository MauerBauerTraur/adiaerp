/**
 * EPIC 3.2 — Telegram self-link service.
 *
 * "Foydalanuvchi + Hodim" birlashtirilgan: ADIA'da alohida `employees`
 * jadval yo'q — hodim = foydalanuvchi (`users`). Bu modul faqat bitta
 * yangi ish-jarayonni qo'shadi: foydalanuvchi o'z Telegram akkauntini
 * BOT orqali, bir martalik token bilan o'zi bog'laydi.
 *
 * Oqim:
 *   1. `issueLinkToken(userId, actorUserId)` — admin (yoki userning o'zi)
 *      bir martalik, muddatli token oladi. Server faqat token HASH'ini
 *      saqlaydi (refresh-token intizomi bilan bir xil); raw token bir
 *      marta qaytadi.
 *   2. Hodim Telegram bot'da `/start <token>` yuboradi.
 *   3. `redeemLinkToken(rawToken, telegramUserId)` — token tekshiriladi
 *      (mavjud, muddati o'tmagan, ishlatilmagan), so'ng o'sha userning
 *      `users.telegram_id` ustuni bog'lanadi. Bularning hammasi BITTA
 *      tranzaksiyada (token consume + telegram_id set + audit).
 *
 * Telegram dispatch'ga FAQAT shu link verb qo'shiladi — ishlab chiqarish/
 * kassa telegram kodiga tegilmaydi.
 */
import { query, withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { generateRefreshToken, hashRefreshToken } from '../auth/jwt.js';

/** A token lives this long before it expires (minutes). */
const LINK_TOKEN_TTL_MINUTES = 15;

/** The raw token returned ONCE to the caller, plus its expiry. */
export type IssuedLinkToken = {
  /** Raw single-use token — return to the client, then forget. */
  readonly token: string;
  readonly expiresAt: Date;
};

/** Outcome of a redemption attempt. */
export type RedeemOutcome =
  | { readonly kind: 'linked'; readonly userId: number; readonly userName: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'already_used' }
  | {
      // The Telegram id is already bound to a DIFFERENT user — we refuse so a
      // single Telegram account cannot impersonate two ADIA users.
      readonly kind: 'telegram_taken';
    };

/**
 * Issue a single-use Telegram link token for `userId`. Any previously
 * issued-but-unconsumed token for the same user is consumed (invalidated)
 * first so only the most recent token is live — pressing "link" twice does
 * not leave two valid tokens floating around.
 *
 * Throws 404 if the user does not exist.
 */
export async function issueLinkToken(
  userId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<IssuedLinkToken> {
  const run = async (client: TxClient): Promise<IssuedLinkToken> => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );
    if (rows[0] === undefined) {
      throw AppError.notFound('User not found or inactive.');
    }

    // Invalidate any earlier live token for this user — newest wins.
    await client.query(
      `UPDATE user_telegram_link_tokens
          SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
    );

    const raw = generateRefreshToken();
    const tokenHash = hashRefreshToken(raw);
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MINUTES * 60_000);

    await client.query(
      `INSERT INTO user_telegram_link_tokens
         (user_id, token_hash, expires_at, created_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, tokenHash, expiresAt, actorUserId],
    );

    await writeAudit(client, {
      actorUserId,
      action: 'user.telegram_link.token_issued',
      entity: 'users',
      entityId: userId,
      payload: { expires_at: expiresAt.toISOString() },
    });

    return { token: raw, expiresAt };
  };
  return tx !== undefined ? run(tx) : withTransaction(run);
}

/**
 * Redeem a raw link token sent via the bot `/start <token>` command and bind
 * the caller's Telegram numeric id to the token's user. The whole flow runs
 * in ONE transaction: token consume + `users.telegram_id` set + audit — all
 * or nothing (invariants 1 & 5).
 *
 * Returns a discriminated outcome so the bot can answer with a clear,
 * non-leaking message. A `FOR UPDATE` lock on the token row serialises two
 * concurrent `/start` presses on the same token (only one links).
 */
export async function redeemLinkToken(
  rawToken: string,
  telegramUserId: number | string,
  tx?: TxClient,
): Promise<RedeemOutcome> {
  const tokenHash = hashRefreshToken(rawToken);
  const tgId = String(telegramUserId);

  const run = async (client: TxClient): Promise<RedeemOutcome> => {
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, user_id, expires_at, consumed_at
         FROM user_telegram_link_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) {
      return { kind: 'invalid' };
    }
    if (row.consumed_at !== null) {
      return { kind: 'already_used' };
    }
    if (row.expires_at.getTime() <= Date.now()) {
      return { kind: 'expired' };
    }

    const userId = Number(row.user_id);

    // If this Telegram id is already bound to a DIFFERENT user, refuse — the
    // partial UNIQUE index `uq_users_telegram` would also reject the update,
    // but a clean check gives a precise outcome instead of a raw 23505.
    const { rows: clash } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE telegram_id = $1 AND id <> $2`,
      [tgId, userId],
    );
    if (clash[0] !== undefined) {
      return { kind: 'telegram_taken' };
    }

    // Bind the Telegram id and consume the token together.
    const { rows: userRows } = await client.query<{ name: string }>(
      `UPDATE users SET telegram_id = $1, updated_at = now()
        WHERE id = $2 AND is_active = TRUE
        RETURNING name`,
      [tgId, userId],
    );
    if (userRows[0] === undefined) {
      // The user was deactivated/deleted after the token was issued.
      return { kind: 'invalid' };
    }
    await client.query(
      `UPDATE user_telegram_link_tokens
          SET consumed_at = now(), consumed_by_telegram_id = $2
        WHERE id = $1`,
      [Number(row.id), tgId],
    );

    await writeAudit(client, {
      actorUserId: userId,
      action: 'user.telegram_link.redeemed',
      entity: 'users',
      entityId: userId,
      payload: { telegram_id: tgId },
    });

    return { kind: 'linked', userId, userName: userRows[0].name };
  };
  return tx !== undefined ? run(tx) : withTransaction(run);
}

/**
 * Lightweight status read for the admin UI: does the user have a linked
 * Telegram id, and is there a live (unconsumed, unexpired) token waiting?
 */
export async function getLinkStatus(
  userId: number,
  tx?: TxClient,
): Promise<{
  readonly telegramLinked: boolean;
  readonly telegramId: string | null;
  readonly hasPendingToken: boolean;
}> {
  const runner = tx ?? { query };
  const { rows: userRows } = await runner.query<{ telegram_id: string | null }>(
    // `telegram_id` is BIGINT; cast to text so the value is always a string
    // (small ids would otherwise arrive as JS numbers from pg).
    `SELECT telegram_id::text AS telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  if (userRows[0] === undefined) {
    throw AppError.notFound('User not found.');
  }
  const { rows: tokenRows } = await runner.query<{ pending: string }>(
    `SELECT count(*) AS pending
       FROM user_telegram_link_tokens
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [userId],
  );
  const telegramId = userRows[0].telegram_id;
  return {
    telegramLinked: telegramId !== null,
    telegramId,
    hasPendingToken: Number(tokenRows[0]?.pending ?? '0') > 0,
  };
}
