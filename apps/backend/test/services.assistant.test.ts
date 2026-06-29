/**
 * F2.2 — `runAssistantQuery` unit tests (service-layer).
 *
 * Whereas `routes.assistant.test.ts` covers the full HTTP loop, this file
 * pokes the service directly with an injected fake `VertexClient`. Three
 * thin invariants:
 *
 *   1. The system prompt the service hands to Vertex carries the principal's
 *      role + location scope — that's how we satisfy ADR-0006 §5.
 *   2. The tool-call loop respects `cfg.vertex.maxToolCallsPerTurn` — a model
 *      that loops forever falls back to a "tool chain limit reached"
 *      message rather than hanging.
 *   3. A disabled client throws `VERTEX_UNAVAILABLE` (no GCP round-trip,
 *      no DB write).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FunctionCallingConfigMode,
  type GenerateContentResponse,
} from '@google/genai';
import type {
  VertexClient,
  VertexGenerateRequest,
} from '../src/integrations/vertex/client.js';
import { runAssistantQuery } from '../src/services/assistant.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

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

function callResponse(
  name: string,
  args: Record<string, unknown>,
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name, args } }],
        },
        index: 0,
      },
    ],
  } as unknown as GenerateContentResponse;
}

type Capture = {
  systemInstructions: string[];
  /** Full request per round-trip — lets a test assert the tool-calling mode. */
  requests: VertexGenerateRequest[];
};

function makeCapture(): Capture {
  return { systemInstructions: [], requests: [] };
}

function makeClient(queue: GenerateContentResponse[], capture: Capture): VertexClient {
  return {
    enabled: true,
    async generate(req) {
      capture.systemInstructions.push(req.systemInstruction);
      capture.requests.push(req);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('queue empty');
      }
      return next;
    },
  };
}

describe('runAssistantQuery — system prompt + scope', () => {
  it('includes the principal role in the system instruction', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
    const capture = makeCapture();
    const client = makeClient([textResponse('OK')], capture);

    const out = await runAssistantQuery({
      message: 'Salom',
      principal: {
        userId: sm.id,
        role: 'store_manager',
        locationId: storeId,
      },
      client,
    });

    expect(out.response).toBe('OK');
    expect(capture.systemInstructions[0]).toMatch(/store_manager/);
  });
});

describe('runAssistantQuery — tool-call chain limit', () => {
  it('stops after maxToolCallsPerTurn and returns a fallback message', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // Push function-call responses indefinitely — the service must cap on
    // its own. Default cap = 5; queue 7 to be safe.
    const queue: GenerateContentResponse[] = [];
    for (let i = 0; i < 7; i++) {
      queue.push(callResponse('get_below_min', {}));
    }

    const capture = makeCapture();
    const client = makeClient(queue, capture);

    const out = await runAssistantQuery({
      message: 'Hammasi qancha?',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    expect(out.response).toMatch(/zanjir chegarasi/i);
    // The service must have stopped issuing more generate() calls — fewer
    // than 7 even though the queue had 7 ready.
    expect(capture.systemInstructions.length).toBeLessThanOrEqual(6);
  });
});

describe('runAssistantQuery — disabled client', () => {
  it('throws VERTEX_UNAVAILABLE without touching the DB', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const disabled: VertexClient = {
      enabled: false,
      async generate() {
        throw new Error('should not be called');
      },
    };
    await expect(
      runAssistantQuery({
        message: 'Salom',
        principal: { userId: pm.id, role: 'pm', locationId: null },
        client: disabled,
      }),
    ).rejects.toThrow(/VERTEX_UNAVAILABLE/);

    // No assistant_sessions row created.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_sessions WHERE user_id = $1`,
      [pm.id],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anti-hallucination — the model must ground every data answer in a tool call.
// Live bug (2026-05-30): a data question ("Markaziy skladda nima qizil?") came
// back with invented numbers and `tool_calls: []`. Root cause — Vertex's
// default AUTO function-calling mode let the model skip every tool. Fix —
// force `mode: ANY` on the first round-trip so the model MUST emit a function
// call before it can answer.
// ---------------------------------------------------------------------------

describe('runAssistantQuery — tool-call grounding (anti-hallucination)', () => {
  it('forces tool-calling mode ANY on the first turn, AUTO afterwards', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const capture = makeCapture();
    // Turn 0: model returns a function call (mode ANY). Turn 1: final text.
    const client = makeClient(
      [callResponse('get_below_min', {}), textResponse('Hech narsa qizil emas.')],
      capture,
    );

    await runAssistantQuery({
      message: 'Markaziy skladda nima qizil holatda?',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    expect(capture.requests.length).toBe(2);
    expect(capture.requests[0]?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.ANY,
    );
    expect(capture.requests[1]?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.AUTO,
    );
  });

  it('always advertises the read tools on every round-trip', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const capture = makeCapture();
    const client = makeClient(
      [callResponse('get_stock', {}), textResponse('OK')],
      capture,
    );

    await runAssistantQuery({
      message: 'Ostatka qancha?',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    for (const req of capture.requests) {
      const names = (req.tools[0]?.functionDeclarations ?? []).map((d) => d.name);
      expect(names).toContain('get_stock');
      expect(names).toContain('get_below_min');
    }
  });

  it('the final answer is built from the tool result, not invented numbers', async () => {
    // Seed a real below-min row so the executed tool returns a known value.
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db, { name: 'Non', type: 'finished' });
    await setStock(ctx.db, {
      locationId: central,
      productId: product,
      qty: 8,
      minLevel: 20,
      maxLevel: 100,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const capture = makeCapture();
    // Turn 0 (forced): the model calls get_below_min for the central wh.
    // Turn 1 (AUTO): the model answers in text. The service feeds the REAL
    // tool rows back as a functionResponse between the two turns.
    const client = makeClient(
      [
        callResponse('get_below_min', { location_id: central }),
        textResponse('Markaziy skladda Non qizil holatda: 8 (min 20).'),
      ],
      capture,
    );

    const out = await runAssistantQuery({
      message: 'Markaziy skladda nima qizil holatda?',
      principal: { userId: pm.id, role: 'pm', locationId: null },
      client,
    });

    // The tool actually ran and is recorded in the API view.
    expect(out.tool_calls.map((t) => t.tool_name)).toContain('get_below_min');
    // The functionResponse fed to turn 1 must carry the real row (qty 8),
    // proving the answer is grounded in DB data, not the model's imagination.
    const turn1 = capture.requests[1]!;
    const fnResponsePart = turn1.contents
      .flatMap((c) => c.parts ?? [])
      .find((p) => 'functionResponse' in p && p.functionResponse !== undefined);
    expect(fnResponsePart).toBeDefined();
    const payload = JSON.stringify(fnResponsePart);
    expect(payload).toContain('get_below_min');
    expect(payload).toContain('"qty":8');
    expect(payload).toContain('"product_name":"Non"');
  });
});
