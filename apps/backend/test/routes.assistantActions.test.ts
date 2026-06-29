/**
 * F3.2 — Assistant write actions: routes + lifecycle integration tests.
 *
 *   POST /api/assistant/actions/:id/confirm
 *   POST /api/assistant/actions/:id/reject
 *   GET  /api/assistant/actions
 *
 * Plus end-to-end coverage of the two-phase commit: model -> pending row
 * -> /confirm -> real DB mutation. The Vertex SDK is mocked the same way
 * as the read-only routes tests so the suite is hermetic.
 *
 * Scenarios covered:
 *   1. Two-phase happy path — model proposes `transfer_stock`, response
 *      carries `pending_action`, no stock_movements yet; confirm applies
 *      the movement and returns the executed action.
 *   2. Confirm idempotency — second `/confirm` returns 409 ACTION_NOT_PENDING.
 *   3. Reject — flips status to rejected; second reject 409.
 *   4. Expire — manually backdating `expires_at` makes confirm return 410.
 *   5. RBAC — another user cannot confirm or reject someone else's action.
 *   6. Pre-check RBAC — model proposes transfer FROM a non-owned location
 *      for a store_manager; no `pending_action` is returned and no row
 *      is inserted.
 *   7. Superseded — a second pending action in the same session flips
 *      the first to `superseded`.
 *   8. List endpoint — paginated, filtered by status; only caller's rows.
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
  getQty,
  type SeededUser,
} from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// Module-level Vertex mock — mirrors routes.assistant.test.ts
// ---------------------------------------------------------------------------

const gate = { enabled: true };
const generateQueue: GenerateContentResponse[] = [];

vi.mock('../src/integrations/vertex/client.js', () => ({
  isVertexEnabled: () => gate.enabled,
  defaultVertexClient: {
    get enabled() {
      return gate.enabled;
    },
    async generate(_req: { systemInstruction: string; contents: Content[] }) {
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
// Helpers — build canned Vertex responses
// ---------------------------------------------------------------------------

function textResponse(text: string): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  } as unknown as GenerateContentResponse;
}

function functionCallResponse(
  name: string,
  args: Record<string, unknown>,
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name, args } }] },
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
});

async function makePmUser(): Promise<SeededUser> {
  return makeUser(ctx.db, { role: 'pm' });
}

/**
 * Seed two stores + one product + stock, then drive a model turn that
 * proposes `transfer_stock`. Returns the request body so tests can assert
 * pending_action and follow-up flows.
 */
async function seedTransferScenario(opts: { sourceQty: number; transferQty: number }) {
  const from = await makeLocation(ctx.db, { type: 'central_warehouse', name: 'Markaziy sklad' });
  const to = await makeLocation(ctx.db, { type: 'store', name: 'Filial-2' });
  const product = await makeProduct(ctx.db, { name: 'Tort', type: 'finished' });
  await setStock(ctx.db, { locationId: from, productId: product, qty: opts.sourceQty });
  await setStock(ctx.db, { locationId: to, productId: product, qty: 0 });
  const pm = await makePmUser();
  return { from, to, product, pm, transferQty: opts.transferQty };
}

// ---------------------------------------------------------------------------
// 1. Happy-path two-phase commit
// ---------------------------------------------------------------------------

describe('two-phase commit — happy path', () => {
  it('returns pending_action and does NOT mutate stock until /confirm', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 10,
      transferQty: 3,
    });

    // Turn 1 — model proposes write tool.
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    // Turn 2 — model emits final text asking for confirmation.
    generateQueue.push(textResponse(`${transferQty} ta jo'natiladi. Tasdiqlaysizmi?`));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: `Filial-2 ga ${transferQty} ta tort jo'nat` });

    expect(queryRes.status).toBe(200);
    expect(queryRes.body.pending_action).toBeDefined();
    expect(queryRes.body.pending_action.tool_name).toBe('transfer_stock');
    expect(queryRes.body.pending_action.args).toMatchObject({
      product_id: product,
      from_location_id: from,
      to_location_id: to,
      qty: transferQty,
    });
    expect(queryRes.body.pending_action.summary).toContain('Tort');
    const actionId = queryRes.body.pending_action.action_id as number;

    // No stock movement yet, source qty unchanged.
    const moveCount = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM stock_movements WHERE product_id = $1`,
      [product],
    );
    expect(Number(moveCount.rows[0]?.cnt ?? '0')).toBe(0);
    expect(await getQty(ctx.db, from, product)).toBe(10);

    // Confirm.
    const confirmRes = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/confirm`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.action.status).toBe('executed');
    expect(confirmRes.body.action.result.movement_id).toEqual(expect.any(Number));
    expect(confirmRes.body.message_appended).toBe(true);

    // Stock moved.
    expect(await getQty(ctx.db, from, product)).toBe(10 - transferQty);
    expect(await getQty(ctx.db, to, product)).toBe(transferQty);

    // Audit row.
    const auditRes = await ctx.db.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity = 'assistant_action' AND entity_id = $1
        ORDER BY id`,
      [actionId],
    );
    expect(auditRes.rows.map((r) => r.action)).toEqual([
      'assistant_action.create',
      'assistant_action.execute',
    ]);
  });

  it('second /confirm is a 409 ACTION_NOT_PENDING (idempotency)', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 10,
      transferQty: 2,
    });
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat' });
    const actionId = queryRes.body.pending_action.action_id as number;

    const first = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/confirm`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/confirm`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ACTION_NOT_PENDING');
  });
});

// ---------------------------------------------------------------------------
// 2. Reject
// ---------------------------------------------------------------------------

describe('reject', () => {
  it('flips status to rejected and does not mutate stock', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 8,
      transferQty: 4,
    });
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat' });
    const actionId = queryRes.body.pending_action.action_id as number;

    const rej = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/reject`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(rej.status).toBe(200);
    expect(rej.body.action.status).toBe('rejected');

    // No stock changes.
    expect(await getQty(ctx.db, from, product)).toBe(8);
    expect(await getQty(ctx.db, to, product)).toBe(0);

    // Second reject — 409.
    const rej2 = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/reject`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(rej2.status).toBe(409);
    expect(rej2.body.error.code).toBe('ACTION_NOT_PENDING');
  });
});

// ---------------------------------------------------------------------------
// 3. Expiry
// ---------------------------------------------------------------------------

describe('expiry', () => {
  it('confirm returns 410 ACTION_EXPIRED once expires_at is in the past', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 6,
      transferQty: 1,
    });
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat' });
    const actionId = queryRes.body.pending_action.action_id as number;

    // Backdate expires_at by 10 minutes.
    await ctx.db.query(
      `UPDATE assistant_actions SET expires_at = now() - interval '10 minutes' WHERE id = $1`,
      [actionId],
    );

    const res = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/confirm`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('ACTION_EXPIRED');

    // Action row is now 'expired'.
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [actionId],
    );
    expect(rows[0]?.status).toBe('expired');
  });

  it('expirePendingActions cron sweep flips overdue pending rows', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 6,
      transferQty: 1,
    });
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat' });
    const actionId = queryRes.body.pending_action.action_id as number;

    await ctx.db.query(
      `UPDATE assistant_actions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [actionId],
    );

    const { runOneCycle } = await import('../src/workers/actionExpireCron.js');
    const result = await runOneCycle();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM assistant_actions WHERE id = $1`,
      [actionId],
    );
    expect(rows[0]?.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// 4. RBAC — only the owner may confirm/reject
// ---------------------------------------------------------------------------

describe('RBAC — owner-only', () => {
  it('another user cannot confirm someone else\'s action (403)', async () => {
    const { from, to, product, pm, transferQty } = await seedTransferScenario({
      sourceQty: 9,
      transferQty: 2,
    });
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: transferQty,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));

    const queryRes = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat' });
    const actionId = queryRes.body.pending_action.action_id as number;

    const other = await makePmUser();
    const res = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/confirm`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({});
    expect(res.status).toBe(403);

    const rej = await request(ctx.app)
      .post(`/api/assistant/actions/${actionId}/reject`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({});
    expect(rej.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 5. Pre-check RBAC — store_manager proposing a foreign transfer is blocked
// ---------------------------------------------------------------------------

describe('pre-check RBAC', () => {
  it('store_manager proposing transfer from another store gets NO pending_action', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'B' });
    const product = await makeProduct(ctx.db, { name: 'Bread' });
    await setStock(ctx.db, { locationId: storeA, productId: product, qty: 5 });
    await setStock(ctx.db, { locationId: storeB, productId: product, qty: 0 });

    const managerB = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: storeB,
    });

    // Model (somehow) proposes transferring OUT of store A — manager of B
    // has no authority over store A's stock.
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: storeA,
        to_location_id: storeB,
        qty: 2,
      }),
    );
    generateQueue.push(textResponse('Ruxsat yo\'q.'));

    const res = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${managerB.token}`)
      .send({ message: 'A dan B ga 2 dona jo\'nat' });

    expect(res.status).toBe(200);
    expect(res.body.pending_action).toBeUndefined();

    // No assistant_actions row was inserted.
    const { rows } = await ctx.db.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_actions WHERE user_id = $1`,
      [managerB.id],
    );
    expect(Number(rows[0]?.cnt ?? '0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Supersede — second pending action in same session
// ---------------------------------------------------------------------------

describe('supersede invariant', () => {
  it('a second pending action in the same session flips the first to superseded', async () => {
    const { from, to, product, pm } = await seedTransferScenario({
      sourceQty: 20,
      transferQty: 1,
    });

    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 1,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));
    const first = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ message: 'jo\'nat 1' });
    const firstId = first.body.pending_action.action_id as number;
    const sessionId = first.body.session_id as number;

    // Second turn in the SAME session — another transfer.
    generateQueue.push(
      functionCallResponse('transfer_stock', {
        product_id: product,
        from_location_id: from,
        to_location_id: to,
        qty: 2,
      }),
    );
    generateQueue.push(textResponse('Tasdiqlaysizmi?'));
    const second = await request(ctx.app)
      .post('/api/assistant/query')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ session_id: sessionId, message: 'jo\'nat 2' });
    const secondId = second.body.pending_action.action_id as number;
    expect(secondId).not.toBe(firstId);

    const { rows } = await ctx.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM assistant_actions
        WHERE id IN ($1, $2) ORDER BY id`,
      [firstId, secondId],
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r.status]));
    expect(byId.get(firstId)).toBe('superseded');
    expect(byId.get(secondId)).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 7. GET /api/assistant/actions — listing
// ---------------------------------------------------------------------------

describe('GET /api/assistant/actions', () => {
  it('returns only the caller\'s actions, paginated, status-filtered', async () => {
    const { from, to, product, pm } = await seedTransferScenario({
      sourceQty: 30,
      transferQty: 1,
    });

    // Stage 3 actions across 3 separate sessions (so they don't supersede
    // each other within the same session).
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      generateQueue.push(
        functionCallResponse('transfer_stock', {
          product_id: product,
          from_location_id: from,
          to_location_id: to,
          qty: 1,
        }),
      );
      generateQueue.push(textResponse('?'));
      const res = await request(ctx.app)
        .post('/api/assistant/query')
        .set('Authorization', `Bearer ${pm.token}`)
        .send({ message: `iter ${i}` });
      ids.push(res.body.pending_action.action_id as number);
    }

    // Reject one, confirm another, leave the third pending.
    await request(ctx.app)
      .post(`/api/assistant/actions/${ids[0]}/reject`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    await request(ctx.app)
      .post(`/api/assistant/actions/${ids[1]}/confirm`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});

    // Unfiltered — all three rows; another user gets none.
    const all = await request(ctx.app)
      .get('/api/assistant/actions')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(3);

    const stranger = await makePmUser();
    const empty = await request(ctx.app)
      .get('/api/assistant/actions')
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(empty.status).toBe(200);
    expect(empty.body.total).toBe(0);

    // Status filter — only pending.
    const pending = await request(ctx.app)
      .get('/api/assistant/actions?status=pending')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(pending.status).toBe(200);
    expect(pending.body.items.every((x: { status: string }) => x.status === 'pending')).toBe(true);
  });
});
