/**
 * F2.2 — Assistant routes integration tests.
 *
 *   POST /api/assistant/query
 *   GET  /api/assistant/sessions
 *   GET  /api/assistant/sessions/:id
 *
 * The Vertex SDK is mocked at the module boundary so the suite is
 * hermetic — no GCP credentials, no network. We override:
 *   * `isVertexEnabled()` so the 503 gate flips on/off per scenario;
 *   * `defaultVertexClient.generate()` so the multi-turn loop is driven
 *     by canned `GenerateContentResponse` values.
 *
 * Scenarios covered:
 *   1. Plain Q&A — no tool call; session created; user + assistant rows
 *      and one audit row are persisted.
 *   2. Tool call path — model returns a `functionCall`; the executor runs
 *      against the test DB; the model's second turn returns plain text;
 *      `tool_calls[]` in the response carries `{tool_name, args,
 *      result_summary}`.
 *   3. Multi-turn — second request carries `session_id` and resumes
 *      context.
 *   4. 503 VERTEX_UNAVAILABLE when the gate is off.
 *   5. RBAC — User B cannot list or read User A's sessions.
 *   6. Validation — empty message rejected with 422.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { GenerateContentResponse, Content } from '@google/genai';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
  type SeededUser,
} from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Toggleable gate. Default ON for the bulk of the suite; one scenario flips
// it OFF to assert the 503 path.
const gate = { enabled: true };

// Queue of canned Vertex responses the next `generate()` calls will return.
const generateQueue: GenerateContentResponse[] = [];

// Captured arguments passed to `generate()` so we can assert system prompt
// content + tool wiring without re-implementing the contract.
const generateCalls: Array<{
  systemInstruction: string;
  contents: Content[];
}> = [];

vi.mock('../src/integrations/vertex/client.js', () => ({
  isVertexEnabled: () => gate.enabled,
  defaultVertexClient: {
    get enabled() {
      return gate.enabled;
    },
    async generate(req: { systemInstruction: string; contents: Content[] }) {
      generateCalls.push({
        systemInstruction: req.systemInstruction,
        contents: req.contents,
      });
      const next = generateQueue.shift();
      if (next === undefined) {
        throw new Error('vertex mock: no canned response queued');
      }
      return next;
    },
  },
  resetVertexClientCache: () => undefined,
}));

// ---------------------------------------------------------------------------
// Helpers — build responses in the Vertex SDK shape
// ---------------------------------------------------------------------------

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

function functionCallResponse(
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

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

afterEach(() => {
  gate.enabled = true;
  generateQueue.length = 0;
  generateCalls.length = 0;
});

async function makePmUser(): Promise<SeededUser> {
  return makeUser(ctx.db, { role: 'pm' });
}

// ---------------------------------------------------------------------------
// 1. Plain Q&A — no tool call
// ---------------------------------------------------------------------------

describe('POST /api/assistant/query — plain Q&A', () => {
  it('creates a session and persists user + assistant + audit', async () => {
    const pm = await makePmUser();
    generateQueue.push(textResponse('Salom! Qanday yordam beraman?'));

    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Salom' });

    expect(res.status).toBe(200);
    expect(res.body.session_id).toEqual(expect.any(Number));
    expect(res.body.response).toBe('Salom! Qanday yordam beraman?');
    expect(res.body.tool_calls).toEqual([]);

    // Vertex was called once.
    expect(generateCalls).toHaveLength(1);

    // DB rows: one session, one user + one assistant message.
    const sessId = res.body.session_id as number;
    const msgRes = await ctx.db.query<{ role: string; content: string }>(
      `SELECT role, content FROM assistant_messages
        WHERE session_id = $1 ORDER BY id`,
      [sessId],
    );
    expect(msgRes.rows.map((r) => r.role)).toEqual(['user', 'assistant']);

    // Audit row.
    const auditRes = await ctx.db.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log
        WHERE entity = 'assistant_query' ORDER BY id DESC LIMIT 1`,
    );
    expect(auditRes.rows[0]?.action).toBe('assistant_query.run');
    expect(Number(auditRes.rows[0]?.entity_id)).toBe(sessId);
  });

  it('derives a title from the first user message', async () => {
    const pm = await makePmUser();
    generateQueue.push(textResponse('OK'));

    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Storedagi tortlar miqdori qancha?' });

    const sessId = res.body.session_id as number;
    const { rows } = await ctx.db.query<{ title: string }>(
      `SELECT title FROM assistant_sessions WHERE id = $1`,
      [sessId],
    );
    expect(rows[0]?.title).toBe('Storedagi tortlar miqdori qancha?');
  });
});

// ---------------------------------------------------------------------------
// 2. Tool-call path
// ---------------------------------------------------------------------------

describe('POST /api/assistant/query — tool-call path', () => {
  it('executes get_stock and returns its summary as tool_calls[0]', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
    const product = await makeProduct(ctx.db, { name: 'Cake', type: 'finished' });
    await setStock(ctx.db, {
      locationId: store,
      productId: product,
      qty: 5,
      minLevel: 10,
      maxLevel: 20,
    });
    const pm = await makePmUser();

    // Turn 1: model asks to call get_stock. Turn 2: model replies with text.
    generateQueue.push(
      functionCallResponse('get_stock', { only_below_min: true }),
    );
    generateQueue.push(
      textResponse('Bitta mahsulot min darajadan past: Cake (qty=5, min=10).'),
    );

    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Qaysi mahsulotlar min\'dan past?' });

    expect(res.status).toBe(200);
    expect(res.body.tool_calls).toHaveLength(1);
    expect(res.body.tool_calls[0].tool_name).toBe('get_stock');
    expect(res.body.tool_calls[0].args).toEqual({ only_below_min: true });
    expect(typeof res.body.tool_calls[0].result_summary).toBe('string');
    expect(res.body.tool_calls[0].result_summary).toContain('get_stock');

    // Both Vertex round-trips happened.
    expect(generateCalls).toHaveLength(2);

    // A `role='tool'` row was persisted for the executed tool.
    const sessId = res.body.session_id as number;
    const toolRows = await ctx.db.query<{
      role: string;
      tool_name: string | null;
    }>(
      `SELECT role, tool_name FROM assistant_messages
        WHERE session_id = $1 AND role = 'tool'`,
      [sessId],
    );
    expect(toolRows.rows).toHaveLength(1);
    expect(toolRows.rows[0]?.tool_name).toBe('get_stock');
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-turn — second request resumes a session
// ---------------------------------------------------------------------------

describe('POST /api/assistant/query — multi-turn', () => {
  it('reuses session_id and feeds prior history into Vertex', async () => {
    const pm = await makePmUser();

    generateQueue.push(textResponse('Birinchi javob.'));
    const first = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Birinchi savol' });
    expect(first.status).toBe(200);

    generateQueue.push(textResponse('Ikkinchi javob.'));
    const second = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ session_id: first.body.session_id, message: 'Ikkinchi savol' });

    expect(second.status).toBe(200);
    expect(second.body.session_id).toBe(first.body.session_id);

    // The second Vertex call should have received the first turn (2 messages)
    // PLUS the second user question = 3 contents.
    const secondCall = generateCalls.at(-1)!;
    expect(secondCall.contents.length).toBeGreaterThanOrEqual(3);
    // The opening user message must be present in the history.
    const firstUserText = secondCall.contents[0]?.parts?.[0];
    expect(firstUserText).toMatchObject({ text: 'Birinchi savol' });
  });
});

// ---------------------------------------------------------------------------
// 4. 503 VERTEX_UNAVAILABLE
// ---------------------------------------------------------------------------

describe('POST /api/assistant/query — 503 path', () => {
  it('returns 503 VERTEX_UNAVAILABLE when the gate is off', async () => {
    gate.enabled = false;
    const pm = await makePmUser();

    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Salom' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('VERTEX_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// 5. RBAC — sessions are per-user
// ---------------------------------------------------------------------------

describe('GET /api/assistant/sessions[/:id] — RBAC', () => {
  it('does not expose another user\'s session in the list', async () => {
    const a = await makePmUser();
    const b = await makeUser(ctx.db, { role: 'pm' });

    generateQueue.push(textResponse('Javob A.'));
    const aFirst = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ message: 'A savol' });

    // B lists their own sessions — must not contain A's session.
    const list = await request(ctx.app)
      .get('/api/assistant/sessions')
      .set('Authorization', `Bearer ${b.token}`);
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { id: number }) => i.id);
    expect(ids).not.toContain(aFirst.body.session_id);
  });

  it('returns 403 when fetching another user\'s session detail', async () => {
    const a = await makePmUser();
    const b = await makeUser(ctx.db, { role: 'pm' });

    generateQueue.push(textResponse('Javob A.'));
    const aFirst = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ message: 'A savol' });

    const res = await request(ctx.app)
      .get(`/api/assistant/sessions/${aFirst.body.session_id}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(403);
  });

  it('returns the session + messages to the owner', async () => {
    const pm = await makePmUser();
    generateQueue.push(textResponse('Bir javob.'));
    const created = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'Bir savol' });

    const res = await request(ctx.app)
      .get(`/api/assistant/sessions/${created.body.session_id}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(created.body.session_id);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
    const roles = res.body.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('returns paginated list with {items, total, limit, offset}', async () => {
    const pm = await makePmUser();
    // Seed two sessions.
    for (let i = 0; i < 2; i++) {
      generateQueue.push(textResponse('OK'));
      await request(ctx.app)
        .post('/api/assistant/query')
        .set('Authorization', `Bearer ${pm.token}`)
        .send({ message: `Q${i}` });
    }
    const res = await request(ctx.app)
      .get('/api/assistant/sessions?limit=1&offset=0')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Validation + auth
// ---------------------------------------------------------------------------

describe('POST /api/assistant/query — validation + auth', () => {
  it('rejects an empty message with 422', async () => {
    const pm = await makePmUser();
    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: '   ' });
    expect(res.status).toBe(422);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .send({ message: 'Salom' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown session_id with 404', async () => {
    const pm = await makePmUser();
    generateQueue.push(textResponse('ignored')); // unused — the call fails before model
    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ session_id: 999_999, message: 'Salom' });
    expect(res.status).toBe(404);
  });
});
