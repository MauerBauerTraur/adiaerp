/**
 * F4.3 (ADR-0014) — Telegram dispatch yangi verbs testlari.
 *
 *   - parseCallbackData yangi 3 va 4 segmentli formatlarni qabul qiladi.
 *   - apprv:act:<id>, rej:act:<id> — assistant_actions ni confirm/reject.
 *   - apprv_all:vmsg:<voiceId>, rej_all:vmsg:<voiceId> — batch.
 *   - clarify:vmsg:<voiceId>:<productId> — clarification audit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
} from './helpers/fixtures.js';
import {
  dispatchCallback,
  parseCallbackData,
  type CallbackPrincipal,
} from '../src/integrations/telegram/dispatch.js';

let ctx: TestContext;
let omborId: number;
let productId: number;
let userId: number;
let principal: CallbackPrincipal;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  omborId = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  productId = await makeProduct(ctx.db, { name: 'Un', unit: 'kg' });
  await setStock(ctx.db, { locationId: omborId, productId, qty: 0, minLevel: 100, maxLevel: 1000 });
  const u = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: omborId });
  userId = u.id;
  principal = { userId, role: 'raw_warehouse_manager', locationId: omborId };
});

async function makeVoiceMessage(): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO voice_messages
       (user_id, telegram_message_id, telegram_file_id, transcript, status)
     VALUES ($1, 1234, 'file_xyz', 'test', 'actions_pending')
     RETURNING id`,
    [userId],
  );
  return Number(rows[0]?.id);
}

async function makePendingAction(voiceId: number): Promise<number> {
  const { rows: sess } = await ctx.db.query<{ id: string }>(
    `INSERT INTO assistant_sessions (user_id, title) VALUES ($1, 'voice') RETURNING id`,
    [userId],
  );
  const sessionId = Number(sess[0]?.id);
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const args = {
    product_id: productId,
    location_id: omborId,
    delta: 500,
    note: 'voice',
  };
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO assistant_actions
       (session_id, user_id, tool_name, args, summary, status, expires_at, voice_message_id)
     VALUES ($1, $2, 'adjust_stock', $3, $4, 'pending', $5, $6)
     RETURNING id`,
    [
      sessionId,
      userId,
      JSON.stringify(args),
      'Ombor: +500 kg Un',
      expiresAt,
      voiceId,
    ],
  );
  return Number(rows[0]?.id);
}

describe('parseCallbackData — yangi formatlar', () => {
  it('apprv_all:vmsg:42 — uchta segment', () => {
    const p = parseCallbackData('apprv_all:vmsg:42');
    expect(p).not.toBeNull();
    expect(p?.verb).toBe('apprv_all');
    expect(p?.entity).toBe('vmsg');
    expect(p?.id).toBe(42);
    expect(p?.extraId).toBeNull();
  });

  it('rej_all:vmsg:7', () => {
    const p = parseCallbackData('rej_all:vmsg:7');
    expect(p?.verb).toBe('rej_all');
    expect(p?.entity).toBe('vmsg');
    expect(p?.id).toBe(7);
  });

  it('clarify:vmsg:42:99 — to\'rtta segment + extraId', () => {
    const p = parseCallbackData('clarify:vmsg:42:99');
    expect(p?.verb).toBe('clarify');
    expect(p?.entity).toBe('vmsg');
    expect(p?.id).toBe(42);
    expect(p?.extraId).toBe(99);
  });

  it('apprv:act:99', () => {
    const p = parseCallbackData('apprv:act:99');
    expect(p?.verb).toBe('apprv');
    expect(p?.entity).toBe('act');
    expect(p?.id).toBe(99);
  });

  it('4-segment faqat clarify uchun ruxsat — apprv:po:1:2 → null', () => {
    expect(parseCallbackData('apprv:po:1:2')).toBeNull();
  });

  it('noto\'g\'ri verb → null', () => {
    expect(parseCallbackData('xx:act:1')).toBeNull();
  });
});

describe('dispatchCallback — voice verbs', () => {
  it('apprv:act:<id> — adjust_stock ni bajaradi', async () => {
    const voiceId = await makeVoiceMessage();
    const actionId = await makePendingAction(voiceId);
    const parsed = parseCallbackData(`apprv:act:${actionId}`);
    expect(parsed).not.toBeNull();
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');
    // assistant_action executed.
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [actionId],
    );
    expect(rows[0]?.status).toBe('executed');
    // Stock yangilandi.
    const { rows: stock } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [omborId, productId],
    );
    expect(Number(stock[0]?.qty)).toBe(500);
  });

  it('rej:act:<id> — rejected', async () => {
    const voiceId = await makeVoiceMessage();
    const actionId = await makePendingAction(voiceId);
    const parsed = parseCallbackData(`rej:act:${actionId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [actionId],
    );
    expect(rows[0]?.status).toBe('rejected');
  });

  it('apprv_all:vmsg:<id> — barcha pending\'larni bajaradi', async () => {
    const voiceId = await makeVoiceMessage();
    const a1 = await makePendingAction(voiceId);
    const a2 = await makePendingAction(voiceId);
    const parsed = parseCallbackData(`apprv_all:vmsg:${voiceId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id IN ($1, $2) ORDER BY id`,
      [a1, a2],
    );
    expect(rows.map((r) => r.status)).toEqual(['executed', 'executed']);
    // voice_messages.status -> executed.
    const { rows: vm } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM voice_messages WHERE id = $1`,
      [voiceId],
    );
    expect(vm[0]?.status).toBe('executed');
  });

  it('rej_all:vmsg:<id> — barcha pending\'larni rad etadi', async () => {
    const voiceId = await makeVoiceMessage();
    const a1 = await makePendingAction(voiceId);
    const a2 = await makePendingAction(voiceId);
    const parsed = parseCallbackData(`rej_all:vmsg:${voiceId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id IN ($1, $2) ORDER BY id`,
      [a1, a2],
    );
    expect(rows.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('apprv_all:vmsg pending yo\'q — invalid', async () => {
    const voiceId = await makeVoiceMessage();
    const parsed = parseCallbackData(`apprv_all:vmsg:${voiceId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('invalid');
  });

  it('clarify:vmsg:<voiceId>:<productId> — audit yoziladi va ok', async () => {
    const voiceId = await makeVoiceMessage();
    const parsed = parseCallbackData(`clarify:vmsg:${voiceId}:${productId}`);
    const outcome = await dispatchCallback(parsed!, principal);
    expect(outcome.kind).toBe('ok');
    const { rows } = await ctx.db.query<{ count: string }>(
      `SELECT count(*) FROM audit_log
        WHERE action = 'voice_message.clarify' AND entity_id = $1`,
      [voiceId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('clarify:vmsg foreign user — rbac', async () => {
    const voiceId = await makeVoiceMessage();
    const otherUser = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: omborId,
    });
    const otherPrincipal: CallbackPrincipal = {
      userId: otherUser.id,
      role: 'store_manager',
      locationId: omborId,
    };
    const parsed = parseCallbackData(`clarify:vmsg:${voiceId}:${productId}`);
    const outcome = await dispatchCallback(parsed!, otherPrincipal);
    expect(outcome.kind).toBe('rbac');
  });
});
