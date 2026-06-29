/**
 * /zayavkalar — bugungi ishlab chiqarish zayavkalari ro'yxati.
 *
 * Foydalanuvchi Telegram'da `/zayavkalar` yoki `/zayavkalar YYYY-MM-DD`
 * yuborsa, tizim shu kundagi production_orders ni inline tugmalar bilan
 * qaytaradi. Tugma bosilganda `dispatch.ts` ning mavjud
 * `start:prod:<id>` / `done:prod:<id>` verblari ishlaydi.
 *
 * RBAC:
 *   - production_manager — faqat o'z sexiga tegishli zayavkalar
 *   - pm               — barcha zayavkalar
 *   - boshqalar        — 403
 */
import { query, type SqlParam } from '../../../db/index.js';
import { lookupTelegramUser } from '../dispatch.js';

export type ZayavkalarContext = {
  readonly fromTelegramId: number;
  readonly text: string;
  reply(text: string, opts?: { reply_markup?: unknown }): Promise<void>;
};

const STATUS_EMOJI: Record<string, string> = {
  new: '🆕',
  in_progress: '⚙️',
  done: '✅',
  cancelled: '❌',
};

const STATUS_LABEL: Record<string, string> = {
  new: 'Yangi',
  in_progress: 'Jarayonda',
  done: 'Tayyor',
  cancelled: 'Bekor',
};

export async function handleZayavkalarCommand(ctx: ZayavkalarContext): Promise<void> {
  const principal = await lookupTelegramUser(ctx.fromTelegramId);
  if (principal === null) {
    await safeReply(ctx, "⛔ Siz tizimga ulanmagan. /start orqali akkauntingizni ulang.");
    return;
  }
  if (principal.role !== 'production_manager' && principal.role !== 'pm') {
    await safeReply(ctx, "⛔ Bu buyruq faqat sex mudiri yoki PM uchun.");
    return;
  }

  // `/zayavkalar 2026-06-22` formatida sana berilishi mumkin
  const parts = ctx.text.trim().split(/\s+/);
  const dateArg = parts[1] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const filterDate = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : today;

  const conditions: string[] = ["po.created_at::date = $1"];
  const params: SqlParam[] = [filterDate];

  if (principal.role === 'production_manager' && principal.locationId !== null) {
    params.push(principal.locationId);
    // Include the manager's own orders AND all nested sub-orders recursively
    conditions.push(`po.id IN (
      WITH RECURSIVE order_tree(id) AS (
        SELECT id FROM production_orders
         WHERE location_id = $2 AND created_at::date = $1
        UNION ALL
        SELECT c.id FROM production_orders c
          JOIN order_tree t ON c.parent_production_order_id = t.id
      )
      SELECT id FROM order_tree
    )`);
  }

  const { rows } = await query<{
    id: number;
    product_name: string;
    qty: string;
    unit: string;
    status: string;
    location_name: string;
    deadline: string | null;
    sub_count: string;
    parent_id: number | null;
    parent_name: string | null;
  }>(
    `SELECT po.id, p.name AS product_name, po.qty::text, p.unit::text AS unit,
            po.status, l.name AS location_name, po.deadline::text,
            COUNT(s.id)::text AS sub_count,
            po.parent_production_order_id AS parent_id,
            pp.name AS parent_name
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       JOIN locations l ON l.id = po.location_id
  LEFT JOIN production_orders s ON s.parent_production_order_id = po.id
  LEFT JOIN production_orders par ON par.id = po.parent_production_order_id
  LEFT JOIN products pp ON pp.id = par.product_id
      WHERE ${conditions.join(' AND ')}
   GROUP BY po.id, p.name, po.qty, p.unit, po.status, l.name, po.deadline,
            po.parent_production_order_id, pp.name
   ORDER BY COALESCE(po.parent_production_order_id, po.id), po.id
      LIMIT 30`,
    params,
  );

  if (rows.length === 0) {
    await safeReply(ctx, `📋 ${filterDate} sanasida zayavkalar yo'q.`);
    return;
  }

  // Har order uchun alohida xabar (inline tugmalar bilan)
  for (const r of rows) {
    const emoji = STATUS_EMOJI[r.status] ?? '❓';
    const label = STATUS_LABEL[r.status] ?? r.status;
    const subInfo = Number(r.sub_count) > 0 ? `\n📦 ${r.sub_count} ta sub-zayafka` : '';
    const deadline = r.deadline ? `\n📅 Muddat: ${r.deadline}` : '';
    const parentInfo = r.parent_id !== null
      ? `\n↳ *#${r.parent_id}* (${r.parent_name ?? ''}) uchun`
      : '';
    const prefix = r.parent_id !== null ? '  ' : '';
    const text =
      `${prefix}${emoji} *Zayafka #${r.id}*${parentInfo}\n` +
      `${prefix}📍 ${r.location_name}\n` +
      `${prefix}🍰 ${r.product_name} — ${Number(r.qty)} ${r.unit}\n` +
      `${prefix}Holat: ${label}${subInfo}${deadline}`;

    const buttons = buildOrderButtons(r.id, r.status);

    await safeReply(ctx, text, {
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    });
  }
}

type TgButton = { text: string; callback_data: string };

function buildOrderButtons(
  orderId: number,
  status: string,
): TgButton[][] | null {
  if (status === 'new') {
    return [
      [
        { text: '▶️ Boshlash', callback_data: `start:prod:${orderId}` },
        { text: '❌ Bekor qilish', callback_data: `rej:prod:${orderId}` },
      ],
    ];
  }
  if (status === 'in_progress') {
    return [[{ text: '✅ Tayyor (yakunlash)', callback_data: `done:prod:${orderId}` }]];
  }
  return null;
}

async function safeReply(
  ctx: ZayavkalarContext,
  text: string,
  opts?: { reply_markup?: unknown },
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-zayavkalar] reply failed:', (err as Error).message);
  }
}
