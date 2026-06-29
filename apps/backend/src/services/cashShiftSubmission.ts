/**
 * EPIC 8.5 — kassir bot orqali smena topshirig'i → money nakladnoy.
 *
 * Owner scenario (changes-2026-05-owner-feedback.md §8.5, image2 referens):
 *   "1 bot gruppaga kassir savdoni topshiradi, kun oxirida kassa yopganda:
 *    rasxod qildim 5 000 000, qo'limda qolgan summa 3 000 000 (kartadan
 *    2 000 000), itogo savdo — botga yozsa, unga ko'rinadigan VA menga
 *    (admin/PM) ko'rinadigan nakladnoy shakllansin."
 *
 * Bu modul kassirning TEXT xabaridan summalarni ajratib oladi (`parseCashShift
 * Submission`) va `cash_shift` manbali, PUL-ASOSLI nakladnoy yaratadi
 * (`createCashShiftNakladnoy`). 8.4 BOM nakladnoyidan farqi: bu yerda mahsulot
 * yo'q — header.product_id NULL, qatorlar money-only (component_product_id NULL,
 * unit = 'som'). itogo savdo = naqd_qoldiq + karta + rasxod (kun savdosi).
 *
 * INVARIANTLAR:
 *   - Poster'ga write-back YO'Q, stock o'zgarmaydi (egasi qarori). Faqat ADIA
 *     ichida nakladnoy + audit + notification.
 *   - Bitta tranzaksiyada: header + lines + audit (yoki hammasi, yoki hech narsa).
 *   - Manfiy summa qabul qilinmaydi (kassir xato kiritsa — validation 422).
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { AppError } from '../errors/index.js';
import {
  createNotification,
  getPmRecipients,
  getLocationManager,
} from './notify.js';

// -----------------------------------------------------------------------------
// Parsing — kassir matni → summalar
// -----------------------------------------------------------------------------

/** Kassir kiritgan smena summalar (so'mda). */
export type CashShiftFigures = {
  /** Rasxod (kun davomida sarflangan pul). */
  readonly expense: number;
  /** Qo'lda qolgan jami summa (naqd + karta qoldiq). */
  readonly remainder: number;
  /** Qoldiqning karta ulushi (remainder ichidagi karta). */
  readonly card: number;
};

/**
 * Bitta raqamni so'mga aylantirish. "5 000 000", "5.000.000", "5000000",
 * "5kk" / "5 mln" kabi qisqartmalarni qo'llab-quvvatlaydi (kassir tezda yozadi).
 * Topilmasa null.
 */
function parseAmount(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  // "5kk", "5 kk", "5 mln", "5m", "5млн" → million.
  const mln = t.match(/^([\d.,\s]+)\s*(kk|mln|m|млн)$/);
  if (mln !== null) {
    const base = cleanNumber(mln[1]!);
    return base === null ? null : base * 1_000_000;
  }
  // "5k", "5 ming", "5 тыс" → ming.
  const k = t.match(/^([\d.,\s]+)\s*(k|ming|тыс|минг)$/);
  if (k !== null) {
    const base = cleanNumber(k[1]!);
    return base === null ? null : base * 1_000;
  }
  return cleanNumber(t);
}

/**
 * Guruh ajratgichlarini (bo'sh joy, nuqta, vergul) olib tashlab raqamga
 * aylantirish. "5 000 000" → 5000000, "5.000.000" → 5000000.
 * Faqat raqam + ajratgichdan iborat bo'lsa qabul qiladi.
 */
function cleanNumber(raw: string): number | null {
  const compact = raw.replace(/[\s.,]/g, '');
  if (compact === '' || !/^\d+$/.test(compact)) return null;
  const n = Number(compact);
  return Number.isFinite(n) ? n : null;
}

export type ParseCashShiftResult =
  | { readonly ok: true; readonly figures: CashShiftFigures }
  | { readonly ok: false; readonly reason: string };

/**
 * Kassirning erkin matnidan smena summalarini ajratib olish. Kalit so'zlar
 * (o'zbek/rus): "rasxod"/"расход", "qoldi"/"qolgan"/"остаток", "karta"/"карта".
 * Misol:
 *   "rasxod 5 000 000, qoldim 3 000 000 (kartadan 2 000 000), itogo savdo"
 *
 * Eng kamida `qoldiq` (remainder) topilishi shart. Topilmasa `ok:false`.
 */
export function parseCashShiftSubmission(text: string): ParseCashShiftResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  const lower = text.toLowerCase();

  const expense = matchLabeledAmount(lower, [
    'rasxod',
    'расход',
    'rashod',
    'chiqim',
  ]);
  const remainder = matchLabeledAmount(lower, [
    'qoldi',
    'qolgan',
    'qolim',
    'qol',
    'остат',
    'qoldiq',
  ]);
  const card = matchLabeledAmount(lower, ['karta', 'карта', 'card']);

  if (remainder === null) {
    return {
      ok: false,
      reason:
        "qoldiq summasi topilmadi. Masalan: \"rasxod 5 000 000, qoldim 3 000 000 (kartadan 2 000 000)\"",
    };
  }
  const cardVal = card ?? 0;
  if (cardVal > remainder) {
    return {
      ok: false,
      reason: 'karta summasi qoldiqdan katta bo\'lishi mumkin emas',
    };
  }
  return {
    ok: true,
    figures: {
      expense: expense ?? 0,
      remainder,
      card: cardVal,
    },
  };
}

/**
 * Bitta kalit so'zdan keyingi birinchi raqamni topish. "kartadan 2 000 000",
 * "rasxod: 5kk" kabi shakllarni qamrab oladi. Topilmasa null.
 */
function matchLabeledAmount(lower: string, labels: readonly string[]): number | null {
  for (const label of labels) {
    const idx = lower.indexOf(label);
    if (idx === -1) continue;
    // Kalit so'zdan keyingi 40 belgini olamiz va undan raqamni ajratamiz.
    const after = lower.slice(idx + label.length, idx + label.length + 40);
    // Birlik qo'shimchasi (k/m/ming...) FAQAT alohida token bo'lsa qabul qilinadi —
    // aks holda "kartadan" so'zining 'k' harfi "ming" deb o'qilib, "1 000 000
    // kartadan" → 1 mlrd bo'lib ketadi (negative lookahead: keyin harf kelmasin).
    const m = after.match(
      /([\d][\d.,\s]*\d|\d)\s*(kk|mln|m|млн|k|ming|тыс|минг)?(?![a-zа-яё])/,
    );
    if (m !== null) {
      const amt = parseAmount(m[0]!);
      if (amt !== null) return amt;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Persistence — money nakladnoy
// -----------------------------------------------------------------------------

export type CashShiftNakladnoyLine = {
  readonly label: string;
  readonly amount: number;
};

export type CashShiftNakladnoyInput = {
  /** Topshirilayotgan do'kon/lokatsiya (RBAC anchor). */
  readonly locationId: number;
  /** Topshirgan kassir (ADIA user). */
  readonly actorUserId: number;
  readonly figures: CashShiftFigures;
  /** Optional erkin izoh (xom transcript). */
  readonly note?: string | null;
};

export type CashShiftNakladnoyResult = {
  readonly nakladnoyId: number;
  /** itogo savdo = naqd qoldiq + karta + rasxod. */
  readonly totalSales: number;
  /** Qoldiqning naqd ulushi (remainder − card). */
  readonly cashRemainder: number;
  readonly lines: readonly CashShiftNakladnoyLine[];
};

/**
 * Kassir smenasidan PUL-asosli `cash_shift` nakladnoy yaratish. Header
 * product_id NULL, qatorlar money-only (`section='itogo'`, unit='som',
 * component_product_id NULL). itogo savdo = qoldiq + rasxod (kun savdosi).
 *
 * O'z tranzaksiyasida ishlaydi (yoki berilganida — caller'niki). header +
 * lines + audit + notification (admin/PM + kassirning o'zi) birga commit
 * bo'ladi.
 */
export async function createCashShiftNakladnoy(
  input: CashShiftNakladnoyInput,
  tx?: TxClient,
): Promise<CashShiftNakladnoyResult> {
  const { expense, remainder, card } = input.figures;
  for (const [name, v] of [
    ['rasxod', expense],
    ['qoldiq', remainder],
    ['karta', card],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw AppError.validation(`cash shift: ${name} summasi manfiy bo'lishi mumkin emas.`);
    }
  }
  if (card > remainder) {
    throw AppError.validation('cash shift: karta summasi qoldiqdan katta.');
  }

  const cashRemainder = round2(remainder - card);
  // Kun savdosi (itogo): qo'lda qolgan (naqd + karta) + kun davomida rasxod.
  const totalSales = round2(remainder + expense);

  const lines: CashShiftNakladnoyLine[] = [
    { label: 'Rasxod', amount: round2(expense) },
    { label: 'Qoldiq (naqd)', amount: cashRemainder },
    { label: 'Qoldiq (karta)', amount: round2(card) },
    { label: 'Itogo savdo', amount: totalSales },
  ];

  const run = async (txc: TxClient): Promise<CashShiftNakladnoyResult> => {
    const { rows } = await txc.query<{ id: string }>(
      `INSERT INTO nakladnoy
         (source, source_ref, product_id, qty, location_id, total_amount, note, created_by)
       VALUES ('cash_shift', $1, NULL, 0, $2, $3, $4, $5)
       RETURNING id`,
      [
        `loc:${input.locationId}`,
        input.locationId,
        totalSales,
        input.note ?? null,
        input.actorUserId,
      ],
    );
    const idRaw = rows[0]?.id;
    if (idRaw === undefined) {
      throw AppError.internal('cash shift nakladnoy insert returned no row.');
    }
    const nakladnoyId = Number(idRaw);

    for (const line of lines) {
      await txc.query(
        `INSERT INTO nakladnoy_lines
           (nakladnoy_id, section, component_product_id, label, qty, unit)
         VALUES ($1, 'itogo', NULL, $2, $3, 'som')`,
        [nakladnoyId, line.label, line.amount],
      );
    }

    await writeAudit(txc, {
      actorUserId: input.actorUserId,
      action: 'nakladnoy.create',
      entity: 'nakladnoy',
      entityId: nakladnoyId,
      payload: {
        source: 'cash_shift',
        location_id: input.locationId,
        expense,
        remainder,
        card,
        total_sales: totalSales,
      },
    });

    // Admin/PM + kassirning o'zi ko'radigan bildirishnoma (egasi: "unga
    // ko'rinadigan va menga ham ko'rinadigan").
    const body =
      `Itogo savdo: ${fmt(totalSales)} so'm\n` +
      `Rasxod: ${fmt(expense)} so'm\n` +
      `Qoldiq (naqd): ${fmt(cashRemainder)} so'm\n` +
      `Qoldiq (karta): ${fmt(card)} so'm`;
    const recipients = new Set<number>([input.actorUserId]);
    for (const pm of await getPmRecipients(txc)) recipients.add(pm);
    const manager = await getLocationManager(txc, input.locationId);
    if (manager !== null) recipients.add(manager);
    for (const userId of recipients) {
      await createNotification(txc, {
        recipientUserId: userId,
        type: 'cash_shift_submitted',
        title: 'Kassa smenasi topshirildi',
        body,
        payload: { nakladnoy_id: nakladnoyId, location_id: input.locationId },
      });
    }

    return { nakladnoyId, totalSales, cashRemainder, lines };
  };

  return tx === undefined ? withTransaction(run) : run(tx);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}
