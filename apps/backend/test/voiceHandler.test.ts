/**
 * F4.3 (ADR-0014) — voiceHandler integration tests.
 *
 * Mock STT + mock Vertex parseIntent + DB harness. Telegram bot.api ham
 * mock (file_path qaytaradi, fetch'ni override qilamiz).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  handleVoiceMessage,
  loadVoicePrincipal,
  __forTesting,
  type VoiceCtxLike,
  type VoiceHandlerDeps,
} from '../src/integrations/telegram/voiceHandler.js';
import type { ParsedIntent } from '../src/integrations/vertex/parseIntent.js';

let ctx: TestContext;
let omborLocId: number;
let unProductId: number;
let yogProductId: number;
let userId: number;
let tgId: number;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  omborLocId = await makeLocation(ctx.db, {
    type: 'raw_warehouse',
    name: `Ombor ${Math.random().toString(36).slice(2, 6)}`,
  });
  unProductId = await makeProduct(ctx.db, { name: 'Un Oliy nav', unit: 'kg' });
  yogProductId = await makeProduct(ctx.db, { name: "Yog' Kungaboqar", unit: 'l' });
  await setStock(ctx.db, {
    locationId: omborLocId,
    productId: unProductId,
    qty: 0,
    minLevel: 100,
    maxLevel: 1000,
  });
  await setStock(ctx.db, {
    locationId: omborLocId,
    productId: yogProductId,
    qty: 5,
    minLevel: 10,
    maxLevel: 100,
  });
  const user = await makeUser(ctx.db, {
    role: 'raw_warehouse_manager',
    locationId: omborLocId,
  });
  userId = user.id;
  // Attach telegram_id to the user (loadVoicePrincipal looks it up).
  tgId = 100000 + userId;
  await ctx.db.query(
    `UPDATE users SET telegram_id = $1 WHERE id = $2`,
    [String(tgId), userId],
  );
});

function fakeCtx(opts?: { tgId?: number; fileId?: string }): VoiceCtxLike & {
  replies: Array<{ text: string; opts?: Record<string, unknown> }>;
} {
  const replies: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  return {
    from: { id: opts?.tgId ?? tgId },
    message: {
      message_id: 9001,
      voice: {
        file_id: opts?.fileId ?? 'voice_file_id_xyz',
        duration: 4,
        file_size: 12345,
      },
    },
    replies,
    async reply(text: string, replyOpts?: Record<string, unknown>) {
      replies.push({ text, opts: replyOpts });
      return undefined;
    },
  };
}

function makeDeps(opts: {
  transcript?: string;
  intents?: ParsedIntent[];
  sttThrows?: boolean;
  emptyTranscript?: boolean;
  downloadThrows?: boolean;
  parseEmptyReason?: 'no_function_call' | 'no_intents' | null;
}): VoiceHandlerDeps {
  return {
    tmpDir: os.tmpdir(),
    downloadVoice: async (_fileId: string) => {
      if (opts.downloadThrows === true) {
        throw new Error('download failed');
      }
      return Buffer.from('OggS-fake-bytes');
    },
    recognize: async (_audio: Buffer) => {
      if (opts.sttThrows === true) {
        throw new Error('stt unavailable');
      }
      return {
        text: opts.emptyTranscript === true ? '' : (opts.transcript ?? 'default'),
        elapsedMs: 150,
      };
    },
    parseIntent: async () => ({
      intents: opts.intents ?? [],
      empty_reason:
        opts.parseEmptyReason !== undefined
          ? opts.parseEmptyReason
          : (opts.intents?.length ?? 0) === 0
            ? 'no_intents'
            : null,
    }),
  };
}

describe('handleVoiceMessage — happy path', () => {
  it('AC4.3.1: 1 ta intent → 1 pending action + tugmalar', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({
        transcript: 'Omborga 500 kg un keldi',
        intents: [
          {
            action: 'adjust_in',
            product_name: 'Un Oliy nav',
            qty: 500,
            unit: 'kg',
            from_location_hint: null,
            to_location_hint: null,
          },
        ],
      }),
    );
    expect(result.status).toBe('actions_pending');
    expect(result.stagedActionIds).toHaveLength(1);

    const { rows: actions } = await ctx.db.query<{
      id: string;
      tool_name: string;
      args: unknown;
      status: string;
      voice_message_id: string | null;
    }>(
      `SELECT id, tool_name, args, status, voice_message_id FROM assistant_actions
        WHERE id = $1`,
      [result.stagedActionIds[0]!],
    );
    expect(actions[0]?.tool_name).toBe('adjust_stock');
    expect(actions[0]?.status).toBe('pending');
    expect(Number(actions[0]?.voice_message_id)).toBe(result.voiceMessageId);
    const args = actions[0]?.args as Record<string, unknown>;
    expect(args.delta).toBe(500);
    expect(args.product_id).toBe(unProductId);
    expect(args.location_id).toBe(omborLocId);

    // Bot xabari yuborildi va keyboard bor.
    expect(ctxF.replies).toHaveLength(1);
    const replyOpts = ctxF.replies[0]?.opts as
      | { reply_markup?: { inline_keyboard?: unknown[][] } }
      | undefined;
    expect(replyOpts?.reply_markup?.inline_keyboard).toBeDefined();
  });

  it('AC4.3.2: 2 intent → 2 pending action + "Hammasi tasdiq" tugmasi', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({
        transcript: "Omborga 500 kg un va 50 l yog' keldi",
        intents: [
          {
            action: 'adjust_in',
            product_name: 'Un Oliy nav',
            qty: 500,
            unit: 'kg',
            from_location_hint: null,
            to_location_hint: null,
          },
          {
            action: 'adjust_in',
            product_name: "Yog' Kungaboqar",
            qty: 50,
            unit: 'l',
            from_location_hint: null,
            to_location_hint: null,
          },
        ],
      }),
    );
    expect(result.status).toBe('actions_pending');
    expect(result.stagedActionIds).toHaveLength(2);

    const replyOpts = ctxF.replies[0]?.opts as
      | { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }
      | undefined;
    const keyboard = replyOpts?.reply_markup?.inline_keyboard ?? [];
    // "Hammasi tasdiq" satri mavjudligini tasdiqlaymiz.
    const flat = keyboard.flat().map((b) => b.callback_data ?? '');
    expect(flat).toContain(`apprv_all:vmsg:${result.voiceMessageId}`);
    expect(flat).toContain(`rej_all:vmsg:${result.voiceMessageId}`);
  });

  it('AC4.3.5: intent yo\'q → "Amal aniqlanmadi" + status failed', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({
        transcript: 'Salom, qalaysiz',
        intents: [],
        parseEmptyReason: 'no_intents',
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.stagedActionIds).toHaveLength(0);
    expect(ctxF.replies[0]?.text ?? '').toContain('Amal aniqlanmadi');
  });
});

describe('handleVoiceMessage — failure paths', () => {
  it('AC4.3.6: notanish telegram_id → rejected_unknown_user', async () => {
    const ctxF = fakeCtx({ tgId: 999999999 });
    const result = await handleVoiceMessage(ctxF, makeDeps({ transcript: 'x' }));
    expect(result.status).toBe('rejected_unknown_user');
    expect(result.voiceMessageId).toBeNull();
    expect(ctxF.replies[0]?.text ?? '').toContain("ro'yxatdan o'tmagan");
  });

  it('STT bo\'sh transcript → status=failed', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({ emptyTranscript: true }),
    );
    expect(result.status).toBe('failed');
    expect(ctxF.replies[0]?.text ?? '').toContain('Nutq aniqlanmadi');
  });

  it('STT throws → status=failed + bot xato javob', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({ sttThrows: true }),
    );
    expect(result.status).toBe('failed');
    expect(ctxF.replies[0]?.text ?? '').toContain('STT xatosi');
  });

  it('AC4.3.8: tmp fayl finally orqali o\'chiriladi', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adia-voice-test-'));
    try {
      const ctxF = fakeCtx();
      await handleVoiceMessage(ctxF, {
        ...makeDeps({
          transcript: 'omborga 500 kg un keldi',
          intents: [
            {
              action: 'adjust_in',
              product_name: 'Un Oliy nav',
              qty: 500,
              unit: 'kg',
              from_location_hint: null,
              to_location_hint: null,
            },
          ],
        }),
        tmpDir,
      });
      const entries = await fs.readdir(tmpDir);
      const leftover = entries.filter((e) => e.startsWith('adia-voice-'));
      expect(leftover).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('handleVoiceMessage — product matching', () => {
  it('topilmagan mahsulot → skip line', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({
        transcript: '5 ta xayoliy mahsulot',
        intents: [
          {
            action: 'adjust_in',
            product_name: 'xayoliy_bo\'lmagan_mahsulot',
            qty: 5,
            unit: 'dona',
            from_location_hint: null,
            to_location_hint: null,
          },
        ],
      }),
    );
    expect(result.stagedActionIds).toHaveLength(0);
    expect(ctxF.replies[0]?.text ?? '').toContain('topilmadi');
  });

  it('qty=0 / unit=unknown → skip', async () => {
    const ctxF = fakeCtx();
    const result = await handleVoiceMessage(
      ctxF,
      makeDeps({
        transcript: 'biroz un keldi',
        intents: [
          {
            action: 'adjust_in',
            product_name: 'Un Oliy nav',
            qty: 0,
            unit: 'unknown',
            from_location_hint: null,
            to_location_hint: null,
          },
        ],
      }),
    );
    expect(result.stagedActionIds).toHaveLength(0);
    expect(ctxF.replies[0]?.text ?? '').toContain('miqdor');
  });
});

describe('loadVoicePrincipal', () => {
  it('topadi va locationIds bilan qaytaradi (M:N)', async () => {
    const p = await loadVoicePrincipal(tgId);
    expect(p).not.toBeNull();
    expect(p?.userId).toBe(userId);
    expect(p?.locationId).toBe(omborLocId);
    expect(p?.locationIds).toEqual([omborLocId]);
    expect(p?.activeLocationId).toBe(omborLocId);
  });

  it('notanish telegram_id → null', async () => {
    const p = await loadVoicePrincipal(987654321);
    expect(p).toBeNull();
  });
});

describe('resolveProduct (forTesting)', () => {
  it('aniq nom match (unique products in this test)', async () => {
    const uniqName = `UniqUn_${Math.random().toString(36).slice(2, 8)}`;
    const id = await makeProduct(ctx.db, { name: uniqName, unit: 'kg' });
    const r = await __forTesting.resolveProduct(uniqName);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.id).toBe(id);
  });

  it('substring — yangi unique nomda', async () => {
    const uniqName = `UnUniq_${Math.random().toString(36).slice(2, 8)}`;
    await makeProduct(ctx.db, { name: uniqName, unit: 'kg' });
    const r = await __forTesting.resolveProduct(uniqName.slice(0, 8));
    // 1 ta yangi mahsulot bilan boshlanadi — boshqa "Un..." mahsulotlar
    // mavjud bo'lishi mumkin, lekin uniqName bo'yicha prefix yagona.
    expect(['unique', 'ambiguous']).toContain(r.kind);
  });

  it('not_found', async () => {
    const r = await __forTesting.resolveProduct('zzz_yo\'q_mahsulot_xxxxx');
    expect(r.kind).toBe('not_found');
  });
});
