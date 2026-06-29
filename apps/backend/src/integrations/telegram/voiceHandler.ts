/**
 * F4.3 (ADR-0014) — Telegram `message:voice` handler.
 *
 * Oqim (high level):
 *   1. Foydalanuvchini telegram_id orqali tasdiqlaymiz (`is_active`).
 *      Notanish → bot "Sizning Telegram hisobingiz tizimda topilmadi" deydi
 *      va PM ga `notifications` qator yoziladi (spam/hujum signali).
 *   2. `voice_messages` qator yaratiladi (`status='received'`).
 *   3. Telegram'dan voice OGG/Opus faylni `/tmp/adia-voice-<id>-<ts>.oga`
 *      ga yuklab olamiz. `finally` blokida fayl o'chiriladi (invariant 15).
 *   4. Yandex STT — `recognizeShort`. Empty / xato → `status='failed'`.
 *   5. Vertex `parseStockMovementIntent` — intent[] qaytaradi.
 *      0 intent → `status='failed'` + "Amal aniqlanmadi".
 *   6. Har intent uchun product + location resolve, agar uniqal — pending
 *      `assistant_actions` (`tool_name='transfer_stock'|'adjust_stock'`).
 *      Ambiguous → clarification action; topilmadi → bot xabar beradi.
 *   7. Bot bitta xabarda transkripsiya + N action summary + inline tugmalar.
 *
 * Invariantlar:
 *   - 1 voice → N pending action (ADR-0014 §7, F3.2 ning "1 pending per
 *     session" istisnosi).
 *   - Voice fayl `finally { fs.unlink }` orqali doimo o'chiriladi.
 *   - STT/IAM token loglarga sızdırılmaydi (auth.ts log sanitizer).
 *   - Mahsulot ID/Lokatsiya ID DB qatlamida `resolveProduct`/`resolveLocation`
 *     orqali aniqlanadi — model uydirib bera olmaydi.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { Bot, Context } from 'grammy';

import { query, withTransaction, type SqlParam, type TxClient } from '../../db/index.js';
import { writeAudit, poolRunner } from '../../lib/audit.js';
import { AppError } from '../../errors/index.js';
import { loadConfig } from '../../config/index.js';
import type { AuthPrincipal } from '../../auth/jwt.js';
import type { Role } from '../../auth/roles.js';
import { recognizeShort, YandexSttError } from '../yandex/stt.js';
import {
  parseStockMovementIntent,
  type ParsedIntent,
} from '../vertex/parseIntent.js';
import { getWriteTool } from '../vertex/tools/write.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VoiceStatus =
  | 'received'
  | 'transcribed'
  | 'parsed'
  | 'actions_pending'
  | 'executed'
  | 'failed'
  | 'clarification_needed';

type VoiceRow = {
  readonly id: number;
  readonly user_id: number;
};

type StagedAction = {
  readonly actionId: number;
  readonly summary: string;
  readonly toolName: string;
  /**
   * EPIC 8.6 — true when this staged action puts a FINISHED product INTO a
   * store (adjust_in / transfer-in). The bot then also offers a
   * "📄 Nakladnoy" button (`nakl:act:<id>`) so the store can spin a `voice`
   * material nakladnoy from the same demand.
   */
  readonly offerNakladnoy: boolean;
};

/**
 * Bizning testlar ham, real Grammy `Context` ham qabul qiladigan minimal
 * surface. `bot.api.getFile` / file_path orqali download — alohida
 * `downloadFn` yordamida abstrakt qilingan (test'da fake URL beriladi).
 */
export type VoiceCtxLike = {
  readonly from?: { id?: number };
  readonly message?: {
    readonly message_id: number;
    readonly voice?: {
      readonly file_id: string;
      readonly duration?: number;
      readonly file_size?: number;
    };
  };
  reply(text: string, opts?: Record<string, unknown>): Promise<unknown>;
};

export type VoiceHandlerDeps = {
  /** Telegram fayl yuklab olish — production'da `bot.api.getFile` + fetch. */
  readonly downloadVoice: (fileId: string) => Promise<Buffer>;
  /** STT — production'da `recognizeShort`. */
  readonly recognize: (audio: Buffer) => Promise<{ text: string; elapsedMs: number }>;
  /** Vertex intent parser. */
  readonly parseIntent: typeof parseStockMovementIntent;
  /** /tmp katalogi — testda override. */
  readonly tmpDir: string;
};

// ---------------------------------------------------------------------------
// Default deps — production
// ---------------------------------------------------------------------------

const TELEGRAM_FILE_URL =
  'https://api.telegram.org/file/bot';

/**
 * Telegram'dan voice file_id orqali Buffer ga yuklab olish.
 * Grammy `bot.api.getFile` `file_path` qaytaradi; biz uni HTTPS GET orqali
 * o'qib olamiz. Bot token `.env.BOT_TOKEN` dan.
 */
export function makeDefaultDownloadVoice(bot: Pick<Bot, 'api'>) {
  return async function downloadVoice(fileId: string): Promise<Buffer> {
    const cfg = loadConfig();
    if (cfg.bot.token === '') {
      throw AppError.internal('BOT_TOKEN not configured — cannot download voice.');
    }
    const file = await bot.api.getFile(fileId);
    if (typeof file.file_path !== 'string' || file.file_path === '') {
      throw AppError.internal('Telegram getFile returned no file_path.');
    }
    const url = `${TELEGRAM_FILE_URL}${cfg.bot.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw AppError.internal(
        `Telegram file download failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  };
}

export const DEFAULT_VOICE_DEPS: Omit<VoiceHandlerDeps, 'downloadVoice'> = {
  recognize: (audio) => recognizeShort(audio, { lang: 'uz-UZ', format: 'oggopus' }),
  parseIntent: parseStockMovementIntent,
  tmpDir: os.tmpdir(),
};

// ---------------------------------------------------------------------------
// Principal lookup (Telegram → AuthPrincipal)
// ---------------------------------------------------------------------------

/**
 * `users.telegram_id` orqali AuthPrincipal yig'amiz. F4.1 (M:N) user_locations
 * dan ham locationIds chiqaramiz. Topilmasa null.
 */
export async function loadVoicePrincipal(
  telegramId: number | string,
): Promise<AuthPrincipal | null> {
  const { rows } = await query<{
    id: number;
    role: Role;
    location_id: number | null;
  }>(
    `SELECT id, role, location_id
       FROM users
      WHERE telegram_id = $1 AND is_active = TRUE`,
    [String(telegramId)],
  );
  const u = rows[0];
  if (u === undefined) return null;
  // user_locations dan M:N to'plam (mavjud bo'lmasa fallback primary).
  const { rows: locs } = await query<{ location_id: number }>(
    `SELECT location_id FROM user_locations WHERE user_id = $1`,
    [u.id],
  );
  const locationIds =
    locs.length > 0
      ? locs.map((r) => Number(r.location_id))
      : u.location_id === null
        ? []
        : [Number(u.location_id)];
  return {
    userId: Number(u.id),
    role: u.role,
    locationId: u.location_id === null ? null : Number(u.location_id),
    locationIds,
    // Voice flow — header header yo'q; default primary lokatsiya.
    activeLocationId: u.location_id === null ? null : Number(u.location_id),
  };
}

// ---------------------------------------------------------------------------
// Voice message row helpers
// ---------------------------------------------------------------------------

async function insertVoiceRow(input: {
  userId: number;
  telegramMessageId: number;
  fileId: string;
  durationSec: number | null;
  bytes: number | null;
}): Promise<VoiceRow> {
  const { rows } = await query<{ id: string; user_id: string }>(
    `INSERT INTO voice_messages
       (user_id, telegram_message_id, telegram_file_id, audio_duration_sec, audio_bytes, status)
     VALUES ($1, $2, $3, $4, $5, 'received')
     RETURNING id, user_id`,
    [
      input.userId,
      input.telegramMessageId,
      input.fileId,
      input.durationSec,
      input.bytes,
    ],
  );
  const r = rows[0];
  if (r === undefined) {
    throw AppError.internal('voice_messages insert returned no row.');
  }
  return { id: Number(r.id), user_id: Number(r.user_id) };
}

async function updateVoiceStatus(
  voiceId: number,
  patch: {
    status?: VoiceStatus;
    transcript?: string;
    intentParseResult?: unknown;
    errorDetail?: string | null;
    markProcessed?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  let i = 1;
  if (patch.status !== undefined) {
    sets.push(`status = $${i++}::voice_message_status`);
    params.push(patch.status);
  }
  if (patch.transcript !== undefined) {
    sets.push(`transcript = $${i++}`);
    params.push(patch.transcript);
  }
  if (patch.intentParseResult !== undefined) {
    sets.push(`intent_parse_result = $${i++}`);
    params.push(JSON.stringify(patch.intentParseResult));
  }
  if (patch.errorDetail !== undefined) {
    sets.push(`error_detail = $${i++}`);
    params.push(patch.errorDetail);
  }
  if (patch.markProcessed === true) {
    sets.push(`processed_at = now()`);
  }
  if (sets.length === 0) return;
  params.push(voiceId);
  await query(
    `UPDATE voice_messages SET ${sets.join(', ')} WHERE id = $${i}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Product / Location resolution
// ---------------------------------------------------------------------------

type ProductMatch =
  | { kind: 'unique'; id: number; name: string; unit: string; type: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: number; name: string; unit: string }> }
  | { kind: 'not_found' };

/**
 * Mahsulot nomini ID ga aylantirish:
 *   1. LOWER(name) aniq mos → unique.
 *   2. ILIKE prefix `<name>%` (max 4 nomzod). 1 ta → unique; ko'p → ambiguous.
 *   3. ILIKE substring `%<name>%` (fallback). 1 ta → unique; ko'p → ambiguous.
 *   4. Aks holda → not_found.
 *
 * `pg_trgm` similarity kelajakda qo'shilsa, 3-bosqich o'rniga ishlatilishi mumkin.
 */
export async function resolveProduct(name: string): Promise<ProductMatch> {
  const trimmed = name.trim();
  if (trimmed === '') return { kind: 'not_found' };
  // Like-escape (foydalanuvchi gapida % bo'lishi kam, lekin xavfsizroq).
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/[%_]/g, (m) => `\\${m}`);

  // 1. exact (case-insensitive).
  const { rows: exact } = await query<{ id: string; name: string; unit: string; type: string }>(
    `SELECT id, name, unit::text AS unit, type::text AS type FROM products
      WHERE is_active = TRUE AND LOWER(name) = LOWER($1)
      LIMIT 1`,
    [trimmed],
  );
  if (exact[0] !== undefined) {
    const r = exact[0];
    return { kind: 'unique', id: Number(r.id), name: r.name, unit: r.unit, type: r.type };
  }
  // 2. prefix.
  const { rows: prefix } = await query<{ id: string; name: string; unit: string; type: string }>(
    `SELECT id, name, unit::text AS unit, type::text AS type FROM products
      WHERE is_active = TRUE AND name ILIKE $1
      ORDER BY name
      LIMIT 4`,
    [`${escaped}%`],
  );
  if (prefix.length === 1) {
    const r = prefix[0]!;
    return { kind: 'unique', id: Number(r.id), name: r.name, unit: r.unit, type: r.type };
  }
  if (prefix.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: prefix.slice(0, 3).map((r) => ({
        id: Number(r.id),
        name: r.name,
        unit: r.unit,
      })),
    };
  }
  // 3. substring.
  const { rows: sub } = await query<{ id: string; name: string; unit: string; type: string }>(
    `SELECT id, name, unit::text AS unit, type::text AS type FROM products
      WHERE is_active = TRUE AND name ILIKE $1
      ORDER BY name
      LIMIT 4`,
    [`%${escaped}%`],
  );
  if (sub.length === 1) {
    const r = sub[0]!;
    return { kind: 'unique', id: Number(r.id), name: r.name, unit: r.unit, type: r.type };
  }
  if (sub.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: sub.slice(0, 3).map((r) => ({
        id: Number(r.id),
        name: r.name,
        unit: r.unit,
      })),
    };
  }
  return { kind: 'not_found' };
}

/**
 * Lokatsiya hint matnini ID ga aylantirish (oddiy ILIKE asosida).
 * Topilmasa null.
 */
export async function resolveLocationHint(
  hint: string | null,
): Promise<{ id: number; name: string } | null> {
  if (hint === null) return null;
  const trimmed = hint.trim();
  if (trimmed === '') return null;
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/[%_]/g, (m) => `\\${m}`);
  // 1. exact.
  const { rows: exact } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations
      WHERE is_active = TRUE AND LOWER(name) = LOWER($1)
      LIMIT 1`,
    [trimmed],
  );
  if (exact[0] !== undefined) {
    return { id: Number(exact[0].id), name: exact[0].name };
  }
  const { rows: like } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations
      WHERE is_active = TRUE AND name ILIKE $1
      ORDER BY name
      LIMIT 1`,
    [`%${escaped}%`],
  );
  if (like[0] !== undefined) {
    return { id: Number(like[0].id), name: like[0].name };
  }
  return null;
}

/** EPIC 8.6 — lokatsiya `store` turidami? (nakladnoy taklifi uchun). */
export async function isStoreLocation(locationId: number): Promise<boolean> {
  const { rows } = await query<{ type: string }>(
    `SELECT type::text AS type FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]?.type === 'store';
}

// ---------------------------------------------------------------------------
// Intent → pending assistant_actions
// ---------------------------------------------------------------------------

const PENDING_ACTION_TTL_MINUTES = 5;

/**
 * Bitta intent dan `assistant_actions` (pending) yaratish.
 * Ambiguous yoki not_found bo'lsa, bot xabari uchun structured natija qaytaradi.
 */
type IntentOutcome =
  | { kind: 'staged'; staged: StagedAction; line: string }
  | { kind: 'clarify'; productName: string; candidates: Array<{ id: number; name: string; unit: string }>; line: string }
  | { kind: 'skipped'; line: string };

async function stageIntentAsAction(
  intent: ParsedIntent,
  principal: AuthPrincipal,
  voiceId: number,
  sessionId: number,
): Promise<IntentOutcome> {
  // 1) qty 0 yoki unit unknown bo'lsa → clarify line (action yaratmaymiz).
  if (intent.qty <= 0 || intent.unit === 'unknown') {
    return {
      kind: 'skipped',
      line: `• "${intent.product_name}" — miqdor yoki birlik aniq emas, qayta ayting`,
    };
  }
  // 2) mahsulotni hal qil.
  const match = await resolveProduct(intent.product_name);
  if (match.kind === 'not_found') {
    return {
      kind: 'skipped',
      line: `• "${intent.product_name}" — bunday mahsulot topilmadi`,
    };
  }
  if (match.kind === 'ambiguous') {
    return {
      kind: 'clarify',
      productName: intent.product_name,
      candidates: match.candidates,
      line: `• "${intent.product_name}" — qaysi mahsulot? (tanlang)`,
    };
  }

  // 3) location hint (default activeLocationId).
  const toHint = await resolveLocationHint(intent.to_location_hint);
  const fromHint = await resolveLocationHint(intent.from_location_hint);

  // 4) tool + args ni qur.
  let toolName: string;
  let toolArgs: Record<string, unknown>;
  // EPIC 8.6 — qaysi lokatsiyaga stock kiradi (adjust_in / transfer-in).
  // adjust_out uchun null — chiqim nakladnoy yaratmaydi.
  let destLocId: number | null = null;

  if (intent.action === 'transfer') {
    // transfer_stock — from va to ikkalasi shart.
    const fromLocId =
      fromHint?.id ?? principal.activeLocationId ?? principal.locationId;
    const toLocId = toHint?.id ?? null;
    if (fromLocId === null || toLocId === null || fromLocId === toLocId) {
      return {
        kind: 'skipped',
        line: `• Transfer uchun manba va maqsad lokatsiyalari aniq emas`,
      };
    }
    toolName = 'transfer_stock';
    toolArgs = {
      product_id: match.id,
      from_location_id: fromLocId,
      to_location_id: toLocId,
      qty: intent.qty,
      note: `voice:${voiceId}`,
    };
    destLocId = toLocId;
  } else {
    // adjust_in (+) / adjust_out (−) → adjust_stock(delta)
    const locId =
      (intent.action === 'adjust_in' ? toHint?.id : fromHint?.id) ??
      principal.activeLocationId ??
      principal.locationId;
    if (locId === null) {
      return {
        kind: 'skipped',
        line: `• Lokatsiya aniq emas (foydalanuvchining primary lokatsiyasi ham yo'q)`,
      };
    }
    toolName = 'adjust_stock';
    toolArgs = {
      product_id: match.id,
      location_id: locId,
      delta: intent.action === 'adjust_in' ? intent.qty : -intent.qty,
      note: `voice:${voiceId}`,
    };
    destLocId = intent.action === 'adjust_in' ? locId : null;
  }

  // EPIC 8.6 — do'kon FINISHED mahsulot oldida nakladnoy tugmasini taklif
  // qilamiz: product `finished` + stock do'konga kiradi.
  const offerNakladnoy =
    match.type === 'finished' &&
    destLocId !== null &&
    (await isStoreLocation(destLocId));

  // 5) RBAC pre-check + INSERT pending — atomik.
  const tool = getWriteTool(toolName);
  if (tool === undefined) {
    return { kind: 'skipped', line: `• ${toolName} — noma'lum tool` };
  }
  let validated: Record<string, unknown>;
  try {
    validated = tool.validateArgs(toolArgs);
  } catch (err) {
    return { kind: 'skipped', line: `• ${match.name} — ${(err as Error).message}` };
  }

  const staged = await withTransaction(async (tx: TxClient) => {
    const decision = await tool.canExecute(validated, principal, tx);
    if (decision !== 'allowed') {
      return { denied: decision.reason };
    }
    const summary = await tool.summarize(validated, principal, tx);
    const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MINUTES * 60_000);

    // Voice flow ADR-0014 §7: bitta voice'dan kelgan N action paralel pending
    // bo'lishi mumkin — bu yerda superseded qilmaymiz.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assistant_actions
         (session_id, user_id, tool_name, args, summary, status, expires_at, voice_message_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id`,
      [
        sessionId,
        principal.userId,
        toolName,
        JSON.stringify(validated),
        summary,
        expiresAt.toISOString(),
        voiceId,
      ],
    );
    const idRaw = rows[0]?.id;
    if (idRaw === undefined) {
      throw AppError.internal('assistant_actions insert returned no row.');
    }
    const actionId = Number(idRaw);
    await writeAudit(tx, {
      actorUserId: principal.userId,
      action: 'assistant_action.create',
      entity: 'assistant_action',
      entityId: actionId,
      payload: {
        tool: toolName,
        args: validated,
        voice_message_id: voiceId,
        summary,
        source: 'voice',
      },
    });
    return { actionId, summary };
  });

  if ('denied' in staged) {
    return { kind: 'skipped', line: `• ${match.name} — RBAC: ${staged.denied}` };
  }
  return {
    kind: 'staged',
    staged: {
      actionId: staged.actionId,
      summary: staged.summary,
      toolName,
      offerNakladnoy,
    },
    line: `• ${staged.summary}`,
  };
}

/**
 * Voice flow uchun har voice messageda alohida `assistant_sessions` qator
 * ochamiz (chat session'lariga aralashtirmaymiz, audit aniq qoladi).
 */
async function ensureVoiceSession(
  userId: number,
  transcript: string,
): Promise<number> {
  const title = `voice: ${transcript.slice(0, 32)}`;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO assistant_sessions (user_id, title)
     VALUES ($1, $2) RETURNING id`,
    [userId, title],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw AppError.internal('voice session insert failed');
  return Number(id);
}

// ---------------------------------------------------------------------------
// Bot keyboard helpers
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = InlineButton[][];

function buildActionKeyboard(
  staged: readonly StagedAction[],
  voiceId: number,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (const s of staged) {
    rows.push([
      { text: '✅ Tasdiq', callback_data: `apprv:act:${s.actionId}` },
      { text: '❌ Rad', callback_data: `rej:act:${s.actionId}` },
    ]);
    // EPIC 8.6 — do'kon FINISHED mahsulot oldi: nakladnoy yaratish tugmasi.
    if (s.offerNakladnoy) {
      rows.push([
        { text: '📄 Nakladnoy', callback_data: `nakl:act:${s.actionId}` },
      ]);
    }
  }
  if (staged.length > 1) {
    rows.push([
      { text: '✅ Hammasi tasdiq', callback_data: `apprv_all:vmsg:${voiceId}` },
      { text: '❌ Hammasi rad', callback_data: `rej_all:vmsg:${voiceId}` },
    ]);
  }
  return rows;
}

function buildClarifyKeyboard(
  voiceId: number,
  candidates: ReadonlyArray<{ id: number; name: string }>,
): InlineKeyboard {
  return candidates.map((c) => [
    { text: c.name, callback_data: `clarify:vmsg:${voiceId}:${c.id}` },
  ]);
}

// ---------------------------------------------------------------------------
// Top-level handler
// ---------------------------------------------------------------------------

const VOICE_TMP_PREFIX = 'adia-voice-';

export type HandleVoiceResult = {
  readonly voiceMessageId: number | null;
  readonly status: VoiceStatus | 'rejected_unknown_user';
  readonly stagedActionIds: number[];
};

/**
 * Voice message ni qayta ishlovchi yagona entry. Test'lar shu funksiyani
 * mock'lar bilan chaqiradi; production'da `bot.on('message:voice')` ham shu
 * funksiyaga delegate qiladi (`wireVoiceHandler` orqali).
 */
export async function handleVoiceMessage(
  ctx: VoiceCtxLike,
  deps: VoiceHandlerDeps,
): Promise<HandleVoiceResult> {
  const tgId = ctx.from?.id;
  const voice = ctx.message?.voice;
  const messageId = ctx.message?.message_id;
  if (tgId === undefined || voice === undefined || messageId === undefined) {
    // Grammy bunday updateni voice handlerga yo'naltirmasligi kerak edi —
    // himoyaviy chiqamiz.
    return { voiceMessageId: null, status: 'failed', stagedActionIds: [] };
  }

  // 1. User lookup.
  const principal = await loadVoicePrincipal(tgId);
  if (principal === null) {
    await safeReply(
      ctx,
      "Sizning Telegram hisobingiz tizimda ro'yxatdan o'tmagan. PM bilan bog'laning.",
    );
    await writeAudit(poolRunner, {
      actorUserId: null,
      action: 'voice_message.rejected_unauthorized',
      entity: 'voice_messages',
      entityId: null,
      payload: { telegram_id: String(tgId), telegram_message_id: messageId },
    });
    return {
      voiceMessageId: null,
      status: 'rejected_unknown_user',
      stagedActionIds: [],
    };
  }

  // 2. voice_messages row.
  const voiceRow = await insertVoiceRow({
    userId: principal.userId,
    telegramMessageId: messageId,
    fileId: voice.file_id,
    durationSec: voice.duration ?? null,
    bytes: voice.file_size ?? null,
  });

  // 3. Download → /tmp/adia-voice-<id>-<ts>.oga
  const tmpName = `${VOICE_TMP_PREFIX}${principal.userId}-${voiceRow.id}-${Date.now()}.oga`;
  const tmpPath = path.join(deps.tmpDir, tmpName);
  let audioBuf: Buffer | null = null;
  try {
    try {
      audioBuf = await deps.downloadVoice(voice.file_id);
    } catch (err) {
      const msg = (err as Error).message;
      await updateVoiceStatus(voiceRow.id, {
        status: 'failed',
        errorDetail: `download: ${msg}`.slice(0, 500),
        markProcessed: true,
      });
      await safeReply(ctx, 'Voice faylni yuklab bo\'lmadi. Qaytadan urinib ko\'ring.');
      return { voiceMessageId: voiceRow.id, status: 'failed', stagedActionIds: [] };
    }
    await fs.writeFile(tmpPath, audioBuf);

    // 4. STT.
    let transcript = '';
    try {
      const stt = await deps.recognize(audioBuf);
      transcript = stt.text.trim();
    } catch (err) {
      const detail =
        err instanceof YandexSttError ? err.message : (err as Error).message;
      await updateVoiceStatus(voiceRow.id, {
        status: 'failed',
        errorDetail: `stt: ${detail}`.slice(0, 500),
        markProcessed: true,
      });
      await safeReply(ctx, 'Ovozni tushuna olmadim (STT xatosi). Qaytadan urinib ko\'ring.');
      return { voiceMessageId: voiceRow.id, status: 'failed', stagedActionIds: [] };
    }
    if (transcript === '') {
      await updateVoiceStatus(voiceRow.id, {
        status: 'failed',
        transcript: '',
        errorDetail: 'stt: empty transcript',
        markProcessed: true,
      });
      await safeReply(ctx, 'Nutq aniqlanmadi, qayta urinib ko\'ring.');
      return { voiceMessageId: voiceRow.id, status: 'failed', stagedActionIds: [] };
    }
    await updateVoiceStatus(voiceRow.id, {
      status: 'transcribed',
      transcript,
    });

    // 5. Vertex parse.
    let parseResult: Awaited<ReturnType<typeof parseStockMovementIntent>>;
    try {
      parseResult = await deps.parseIntent(transcript, principal);
    } catch (err) {
      const detail = (err as Error).message;
      await updateVoiceStatus(voiceRow.id, {
        status: 'failed',
        errorDetail: `parse: ${detail}`.slice(0, 500),
        markProcessed: true,
      });
      await safeReply(
        ctx,
        `📝 Eshitdim: "${transcript}"\n\nLekin tahlilda xatolik yuz berdi (AI). Keyinroq urinib ko'ring.`,
      );
      return { voiceMessageId: voiceRow.id, status: 'failed', stagedActionIds: [] };
    }
    await updateVoiceStatus(voiceRow.id, {
      intentParseResult: { intents: parseResult.intents, empty_reason: parseResult.empty_reason },
    });

    if (parseResult.intents.length === 0) {
      await updateVoiceStatus(voiceRow.id, {
        status: 'failed',
        errorDetail: parseResult.empty_reason ?? 'no_intents',
        markProcessed: true,
      });
      await safeReply(
        ctx,
        `📝 Eshitdim: "${transcript}"\n\nAmal aniqlanmadi.`,
      );
      return { voiceMessageId: voiceRow.id, status: 'failed', stagedActionIds: [] };
    }

    await updateVoiceStatus(voiceRow.id, { status: 'parsed' });

    // 6. Har intent uchun pending action yaratish.
    const sessionId = await ensureVoiceSession(principal.userId, transcript);
    const staged: StagedAction[] = [];
    const lines: string[] = [];
    const clarifyKeyboards: InlineKeyboard[] = [];
    for (const intent of parseResult.intents) {
      const outcome = await stageIntentAsAction(
        intent,
        principal,
        voiceRow.id,
        sessionId,
      );
      lines.push(outcome.line);
      if (outcome.kind === 'staged') {
        staged.push(outcome.staged);
      } else if (outcome.kind === 'clarify') {
        clarifyKeyboards.push(
          buildClarifyKeyboard(voiceRow.id, outcome.candidates),
        );
      }
    }

    // 7. Bot xabari + tugmalar.
    const header = `📝 Eshitdim: "${transcript}"\nAniqlandi:`;
    const body = lines.join('\n');
    const text = `${header}\n${body}`;
    const keyboard: InlineKeyboard = [];
    if (staged.length > 0) {
      keyboard.push(...buildActionKeyboard(staged, voiceRow.id));
    }
    for (const ck of clarifyKeyboards) {
      keyboard.push(...ck);
    }
    if (keyboard.length === 0) {
      await safeReply(ctx, text);
    } else {
      await safeReply(ctx, text, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    const nextStatus: VoiceStatus =
      staged.length > 0
        ? 'actions_pending'
        : clarifyKeyboards.length > 0
          ? 'clarification_needed'
          : 'failed';
    await updateVoiceStatus(voiceRow.id, {
      status: nextStatus,
      markProcessed: nextStatus !== 'actions_pending',
    });

    return {
      voiceMessageId: voiceRow.id,
      status: nextStatus,
      stagedActionIds: staged.map((s) => s.actionId),
    };
  } finally {
    // Voice fayl doimo o'chiriladi (invariant 15 — tmp leak yo'q).
    try {
      await fs.unlink(tmpPath);
    } catch {
      // fayl mavjud bo'lmasa — issue emas (download muvaffaqiyatsiz tugagan).
    }
  }
}

// ---------------------------------------------------------------------------
// Grammy wiring
// ---------------------------------------------------------------------------

/**
 * Grammy bot ga `message:voice` handler ulash. `bot.ts` uni
 * `ensureCallbackHandlerWired` yonida chaqiradi.
 */
export function wireVoiceHandler(
  bot: Pick<Bot, 'on' | 'api'>,
): void {
  const deps: VoiceHandlerDeps = {
    ...DEFAULT_VOICE_DEPS,
    downloadVoice: makeDefaultDownloadVoice(bot),
  };
  bot.on('message:voice', async (ctx: Context) => {
    try {
      await handleVoiceMessage(ctx as unknown as VoiceCtxLike, deps);
    } catch (err) {
      // Voice handler hech qachon Grammy'ni qulatmaslik kerak —
      // ichki xatolarni log'ga chiqaramiz va foydalanuvchiga umumiy javob.
      console.error(
        '[telegram-voice] uncaught:',
        (err as Error).message,
        (err as Error).stack,
      );
      try {
        await ctx.reply('Texnik xatolik yuz berdi. Keyinroq urinib ko\'ring.');
      } catch {
        /* swallow */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReply(
  ctx: VoiceCtxLike,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-voice] reply failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** TEST-ONLY — internal helpers exposed for unit tests. */
export const __forTesting = {
  resolveProduct,
  resolveLocationHint,
  stageIntentAsAction,
  buildActionKeyboard,
  buildClarifyKeyboard,
  insertVoiceRow,
  updateVoiceStatus,
  ensureVoiceSession,
  VOICE_TMP_PREFIX,
};
