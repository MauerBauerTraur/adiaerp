/**
 * /jonatish — bugungi sklad jo'natish (production_dispatches) ro'yxati.
 *
 * Warehouse manager: `/jonatish` → barcha `pending` dispatch itemlar
 * Production manager: `/jonatish` → o'z sexiga `dispatched` itemlar
 * PM: `/jonatish` → barcha itemlar
 *
 * Inline tugmalar:
 *   - Warehouse: [📦 Berildi] → snd:dsp:<id>
 *   - Production: [✅ Qabul qildim] → rcv:dsp:<id>
 */
import { query, type SqlParam } from '../../../db/index.js';
import { lookupTelegramUser } from '../dispatch.js';

export type JonatishContext = {
  readonly fromTelegramId: number;
  readonly text: string;
  reply(text: string, opts?: { reply_markup?: unknown }): Promise<void>;
};

const DSP_STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  dispatched: '🚚',
  received: '✅',
};

const DSP_STATUS_LABEL: Record<string, string> = {
  pending: 'Kutilmoqda',
  dispatched: 'Berildi',
  received: 'Qabul qilindi',
};

export async function handleJonatishCommand(ctx: JonatishContext): Promise<void> {
  const principal = await lookupTelegramUser(ctx.fromTelegramId);
  if (principal === null) {
    await safeReply(ctx, "⛔ Siz tizimga ulanmagan. /start orqali akkauntingizni ulang.");
    return;
  }

  const allowed = ['raw_warehouse_manager', 'production_manager', 'pm'];
  if (!allowed.includes(principal.role)) {
    await safeReply(ctx, "⛔ Bu buyruq ombor mudiri, sex mudiri yoki PM uchun.");
    return;
  }

  const parts = ctx.text.trim().split(/\s+/);
  const dateArg = parts[1] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const filterDate = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : today;

  // Status filter va location filter role'ga qarab
  let statusFilter: string;
  let locationCondition = '';
  const params: SqlParam[] = [filterDate];

  if (principal.role === 'raw_warehouse_manager') {
    statusFilter = "d.status = 'pending'";
  } else if (principal.role === 'production_manager') {
    statusFilter = "d.status = 'dispatched'";
    if (principal.locationId !== null) {
      locationCondition = `AND d.to_location_id = $2`;
      params.push(principal.locationId);
    }
  } else {
    // pm — barcha pending + dispatched
    statusFilter = "d.status IN ('pending','dispatched')";
  }

  const { rows } = await query<{
    id: number;
    product_name: string;
    qty_needed: string;
    product_unit: string;
    status: string;
    from_location_name: string | null;
    to_location_name: string | null;
    production_order_id: number;
    po_product_name: string;
  }>(
    `SELECT d.id, d.product_name, d.qty_needed::text, d.product_unit,
            d.status, d.from_location_name, d.to_location_name,
            d.production_order_id, po_p.name AS po_product_name
       FROM production_dispatches d
       JOIN production_orders po ON po.id = d.production_order_id
       JOIN products po_p ON po_p.id = po.product_id
      WHERE po.created_at::date = $1
        AND ${statusFilter}
        ${locationCondition}
   ORDER BY d.to_location_name, d.product_name
      LIMIT 30`,
    params,
  );

  if (rows.length === 0) {
    await safeReply(
      ctx,
      `📭 ${filterDate} sanasida ko'rinadigan jo'natish yozuvlari yo'q.`,
    );
    return;
  }

  // Sex (to_location) bo'yicha guruhlash
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.to_location_name ?? 'Noma\'lum sex';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  for (const [locName, items] of grouped) {
    const header = `🏭 *${locName}* — ${filterDate}\n`;
    const lines = items.map((r) => {
      const emoji = DSP_STATUS_EMOJI[r.status] ?? '❓';
      const label = DSP_STATUS_LABEL[r.status] ?? r.status;
      return `${emoji} ${r.product_name}: ${Number(r.qty_needed)} ${r.product_unit} [${label}]`;
    });

    const text = header + lines.join('\n');

    // Har item uchun tugma
    const keyboard = items
      .filter((r) => r.status === 'pending' || r.status === 'dispatched')
      .map((r) => {
        if (r.status === 'pending' && principal.role !== 'production_manager') {
          return [{ text: `📦 Berildi: ${r.product_name.slice(0, 25)}`, callback_data: `snd:dsp:${r.id}` }];
        }
        if (r.status === 'dispatched' && principal.role !== 'raw_warehouse_manager') {
          return [{ text: `✅ Qabul: ${r.product_name.slice(0, 25)}`, callback_data: `rcv:dsp:${r.id}` }];
        }
        return null;
      })
      .filter((b): b is { text: string; callback_data: string }[] => b !== null);

    await safeReply(ctx, text, {
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    });
  }
}

async function safeReply(
  ctx: JonatishContext,
  text: string,
  opts?: { reply_markup?: unknown },
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-jonatish] reply failed:', (err as Error).message);
  }
}
