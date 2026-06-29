/**
 * EPIC 8.5 — Telegram `message:text` handler: kassir smena topshirig'i.
 *
 * Oqim (changes-2026-05-owner-feedback.md §8.5):
 *   1. Kassir bot gruppasiga kun oxirida matn yozadi:
 *        "rasxod 5 000 000, qoldim 3 000 000 (kartadan 2 000 000), itogo savdo"
 *   2. Telegram_id orqali foydalanuvchi tasdiqlanadi (`is_active`).
 *   3. RBAC: faqat `store_manager` (o'z do'koni) yoki `pm` topshira oladi.
 *   4. Matn parse qilinadi (`parseCashShiftSubmission`).
 *   5. `cash_shift` money nakladnoy yaratiladi (`createCashShiftNakladnoy`) +
 *      kassir + admin/PM ga bildirishnoma.
 *   6. Bot kassirning o'ziga itogo savdo / qoldiq xulosasini qaytaradi.
 *
 * MUHIM: bu handler FAQAT smena topshirig'iga o'xshagan matnga javob beradi
 * (kalit so'z: rasxod/qoldiq/karta yoki "smena"/"kassa"). Boshqa har qanday
 * matn e'tiborsiz qoldiriladi — bot oddiy suhbatni buzmaydi. Production-dialog
 * va user-link oqimlariga tegmaydi (faqat CASH verbi qo'shiladi).
 *
 * `startCommand.ts` / `voiceHandler.ts` uslubida: kichik adapter (`CashShiftCtx
 * Like`) bilan to'liq unit-test qilinadi — real Grammy `Context` shart emas.
 */
import { writeAudit, poolRunner } from '../../lib/audit.js';
import { loadVoicePrincipal } from './voiceHandler.js';
import {
  parseCashShiftSubmission,
  createCashShiftNakladnoy,
} from '../../services/cashShiftSubmission.js';

/** Real Grammy `Context` ham, testdagi soxta obyekt ham mos keladigan surface. */
export type CashShiftCtxLike = {
  readonly from?: { id?: number };
  readonly message?: { readonly text?: string };
  reply(text: string, opts?: Record<string, unknown>): Promise<unknown>;
};

export type CashShiftHandleResult = {
  readonly handled: boolean;
  readonly nakladnoyId: number | null;
  readonly reason?: string;
};

/**
 * Matn smena topshirig'iga o'xshaydimi? Kamida bitta pul kalit so'zi
 * ("rasxod"/"qoldi"/"karta") YOKI aniq "smena"/"kassa topshir" iborasi bo'lsa
 * — biz uni qabul qilamiz. Aks holda handler indamaydi (`handled:false`).
 */
export function looksLikeCashShift(text: string): boolean {
  const t = text.toLowerCase();
  const moneyHints =
    /\b(rasxod|расход|rashod|qoldi|qolgan|qolim|остат|qoldiq|karta|карта)\b/.test(t);
  const shiftHints = /(smena|смена|kassa topshir|касса)/.test(t);
  return moneyHints || shiftHints;
}

/**
 * Bitta matn xabarni qayta ishlovchi yagona entry. `bot.ts` uni
 * `bot.on('message:text', ...)` ostida chaqiradi; testlar to'g'ridan-to'g'ri
 * chaqiradi.
 */
export async function handleCashShiftMessage(
  ctx: CashShiftCtxLike,
): Promise<CashShiftHandleResult> {
  const tgId = ctx.from?.id;
  const text = ctx.message?.text;
  if (tgId === undefined || typeof text !== 'string' || text.trim() === '') {
    return { handled: false, nakladnoyId: null, reason: 'no_text' };
  }
  // Smena topshirig'iga o'xshamasa — boshqa handlerlarga / suhbatga xalaqit
  // bermaymiz.
  if (!looksLikeCashShift(text)) {
    return { handled: false, nakladnoyId: null, reason: 'not_a_submission' };
  }

  // 1. Foydalanuvchi.
  const principal = await loadVoicePrincipal(tgId);
  if (principal === null) {
    await safeReply(
      ctx,
      "Sizning Telegram hisobingiz tizimda ro'yxatdan o'tmagan. PM bilan bog'laning.",
    );
    await writeAudit(poolRunner, {
      actorUserId: null,
      action: 'cash_shift.rejected_unauthorized',
      entity: 'nakladnoy',
      entityId: null,
      payload: { telegram_id: String(tgId) },
    });
    return { handled: true, nakladnoyId: null, reason: 'unauthorized' };
  }

  // 2. RBAC — faqat store_manager (o'z do'koni) yoki pm.
  if (principal.role !== 'store_manager' && principal.role !== 'pm') {
    await safeReply(ctx, "Smena topshirig'ini faqat do'kon kassiri yoki PM topshira oladi.");
    return { handled: true, nakladnoyId: null, reason: 'rbac' };
  }
  const locationId = principal.activeLocationId ?? principal.locationId;
  if (locationId === null) {
    await safeReply(
      ctx,
      "Sizga do'kon biriktirilmagan. PM bilan bog'laning.",
    );
    return { handled: true, nakladnoyId: null, reason: 'no_location' };
  }

  // 3. Parse.
  const parsed = parseCashShiftSubmission(text);
  if (!parsed.ok) {
    await safeReply(
      ctx,
      `Smena summalarini o'qiy olmadim: ${parsed.reason}\n\n` +
        "Namuna: \"rasxod 5 000 000, qoldim 3 000 000 (kartadan 2 000 000)\"",
    );
    return { handled: true, nakladnoyId: null, reason: parsed.reason };
  }

  // 4. Money nakladnoy + bildirishnomalar.
  try {
    const result = await createCashShiftNakladnoy({
      locationId,
      actorUserId: principal.userId,
      figures: parsed.figures,
      note: text.slice(0, 500),
    });
    await safeReply(
      ctx,
      `✅ Smena topshirildi (Nakladnoy #${result.nakladnoyId}).\n` +
        `Itogo savdo: ${fmt(result.totalSales)} so'm\n` +
        `Qoldiq (naqd): ${fmt(result.cashRemainder)} so'm\n` +
        `Qoldiq (karta): ${fmt(parsed.figures.card)} so'm\n` +
        `Rasxod: ${fmt(parsed.figures.expense)} so'm\n\n` +
        'Admin ham ko\'radi.',
    );
    return { handled: true, nakladnoyId: result.nakladnoyId };
  } catch (err) {
    console.error('[telegram-cashshift] create failed:', (err as Error).message);
    await safeReply(ctx, "Smena topshirig'ini saqlab bo'lmadi. Keyinroq urinib ko'ring.");
    return { handled: true, nakladnoyId: null, reason: 'failed' };
  }
}

async function safeReply(
  ctx: CashShiftCtxLike,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-cashshift] reply failed:', (err as Error).message);
  }
}

function fmt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}
