/**
 * F2.2 Sprint-3 — assistant audit payload + token guard regression tests.
 *
 * Two invariants we caught failing in QA brauzer e2e:
 *
 *   MEDIUM 3 — the `audit_log.payload` for `assistant_query.run` must carry
 *   the full set the spec §2.2 requires (`user_question`, `tools_used`,
 *   `response_text` truncated, `latency_ms`), not just `tool_calls` +
 *   `response_chars`.
 *
 *   MEDIUM 4 — a message longer than `cfg.vertex.maxInputTokens * 3` chars
 *   must be rejected with a 422 VALIDATION_ERROR BEFORE we open a Vertex
 *   round-trip, the DB session, or the audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import { runAssistantQuery } from '../src/services/assistant.js';
import { loadConfig } from '../src/config/index.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

function textResponse(text: string): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        index: 0,
      },
    ],
  } as unknown as GenerateContentResponse;
}

function fakeClient(queue: GenerateContentResponse[]): VertexClient {
  return {
    enabled: true,
    async generate() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('queue empty');
      }
      return next;
    },
  };
}

describe('runAssistantQuery — audit payload (MEDIUM 3)', () => {
  it('writes user_question, response_text (truncated), latency_ms, tools_used', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const question = 'Markaziy skladda nima qizil?';
    const client = fakeClient([textResponse('Hozircha hech narsa.')]);

    const result = await runAssistantQuery({
      message: question,
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    const { rows } = await ctx.db.query<{ payload: unknown }>(
      `SELECT payload FROM audit_log
        WHERE entity = 'assistant_query' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [result.session_id],
    );
    const payload = rows[0]?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.user_question).toBe(question);
    expect(payload?.response_text).toBe('Hozircha hech narsa.');
    expect(typeof payload?.latency_ms).toBe('number');
    expect((payload?.latency_ms as number) >= 0).toBe(true);
    expect(Array.isArray(payload?.tools_used)).toBe(true);
    // No tools were called in this plain-text path.
    expect(payload?.tools_used).toEqual([]);
    expect(payload?.session_id).toBe(result.session_id);
    expect(payload?.response_chars).toBe('Hozircha hech narsa.'.length);
  });

  it('truncates response_text in the audit payload to ~1000 chars', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const longText = 'a'.repeat(2500);
    const client = fakeClient([textResponse(longText)]);

    const result = await runAssistantQuery({
      message: 'Hammasini ayt',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    const { rows } = await ctx.db.query<{ payload: unknown }>(
      `SELECT payload FROM audit_log
        WHERE entity = 'assistant_query' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [result.session_id],
    );
    const payload = rows[0]?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    const responseText = payload?.response_text as string;
    expect(typeof responseText).toBe('string');
    // Bounded — the truncated audit entry is no longer than 1000 chars.
    expect(responseText.length).toBeLessThanOrEqual(1000);
    // But the response_chars field still reports the FULL response length.
    expect(payload?.response_chars).toBe(longText.length);
    // And the persisted assistant message keeps the full text intact.
    const msgRes = await ctx.db.query<{ content: string }>(
      `SELECT content FROM assistant_messages
        WHERE session_id = $1 AND role = 'assistant'
        ORDER BY id DESC LIMIT 1`,
      [result.session_id],
    );
    expect(msgRes.rows[0]?.content.length).toBe(longText.length);
  });
});

describe('runAssistantQuery — token-budget guard (MEDIUM 4)', () => {
  it('rejects an oversize message with VALIDATION_ERROR (422) BEFORE Vertex', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cfg = loadConfig();
    // The cap is `maxInputTokens * 3` characters; build one over.
    const tooLong = 'x'.repeat(cfg.vertex.maxInputTokens * 3 + 1);

    let generateCalled = false;
    const client: VertexClient = {
      enabled: true,
      async generate() {
        generateCalled = true;
        return textResponse('should not run');
      },
    };

    await expect(
      runAssistantQuery({
        message: tooLong,
        principal: { userId: pm.id, role: 'pm', locationId: null },
        client,
      }),
    ).rejects.toMatchObject({
      // AppError.validation -> status 422, code VALIDATION_ERROR.
      status: 422,
      code: 'VALIDATION_ERROR',
    });

    // No Vertex round-trip happened.
    expect(generateCalled).toBe(false);
    // No session row created for this user as a side effect.
    const sessRes = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_sessions WHERE user_id = $1`,
      [pm.id],
    );
    expect(Number(sessRes.rows[0]?.cnt ?? '0')).toBe(0);
  });

  it('accepts a message just under the cap', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cfg = loadConfig();
    const justUnder = 'y'.repeat(cfg.vertex.maxInputTokens * 3 - 10);
    const client = fakeClient([textResponse('OK')]);

    const result = await runAssistantQuery({
      message: justUnder,
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });
    expect(result.response).toBe('OK');
  });
});
