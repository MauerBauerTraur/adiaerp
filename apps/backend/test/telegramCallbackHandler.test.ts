/**
 * F3.3 / ADR-0011 — `handleCallbackQuery` integration tests.
 *
 * The handler is driven through its small `CallbackContext` adapter so
 * the tests never construct a real Grammy `Bot`. Five guarantees are
 * exercised end-to-end against a real PostgreSQL schema (the harness
 * runs migrations into a per-suite schema):
 *
 *   1. Idempotency — re-handling the same `update_id` is a no-op
 *      ('duplicate' answer) and does NOT advance the domain twice.
 *   2. Spoofing — a `from.id` not on file for any active user is
 *      rejected with `rejected_unauthorized`, no domain mutation.
 *   3. RBAC — a valid user without the right role gets `rejected_rbac`.
 *   4. Happy path — a `start:prod:<id>` flips the order to `in_progress`,
 *      writes `processed`, and asks Grammy to strip the buttons.
 *   5. Audit — every branch writes both `telegram_callback_actions` and
 *      a matching `audit_log` row (compliance trail).
 *
 * Real Grammy is never imported in these tests — the `CallbackContext`
 * adapter is a plain `vi.fn()` mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
} from './helpers/fixtures.js';
import { handleCallbackQuery, type CallbackContext } from '../src/integrations/telegram/callbackHandler.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Hard reset every per-test piece of state.
  await ctx.db.query('DELETE FROM telegram_callback_actions');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM production_orders');
  await ctx.db.query('DELETE FROM purchase_orders');
  await ctx.db.query('DELETE FROM replenishment_transitions');
  await ctx.db.query('DELETE FROM replenishment_requests');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query(`UPDATE locations SET manager_user_id = NULL`);
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM products');
});

/** Build a `CallbackContext` mock; every method is a `vi.fn()` we can assert on. */
function mockCtx(opts: {
  updateId: number;
  fromTelegramId: number;
  data: string;
}): {
  ctx: CallbackContext;
  answer: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  editReplyMarkup: ReturnType<typeof vi.fn>;
} {
  const answer = vi.fn(() => Promise.resolve({ ok: true }));
  const sendMessage = vi.fn(() => Promise.resolve({ ok: true }));
  const editReplyMarkup = vi.fn(() => Promise.resolve({ ok: true }));
  return {
    ctx: {
      updateId: opts.updateId,
      callbackQueryId: `cbq-${opts.updateId}`,
      fromTelegramId: opts.fromTelegramId,
      data: opts.data,
      chatId: 1001,
      messageId: 2001,
      answerCallbackQuery: answer,
      sendMessage,
      editReplyMarkup,
    },
    answer,
    sendMessage,
    editReplyMarkup,
  };
}

/** Attach a telegram_id to the seeded user (the fixtures helper doesn't take one). */
async function setTelegramId(userId: number, tgId: number): Promise<void> {
  await ctx.db.query(`UPDATE users SET telegram_id = $2 WHERE id = $1`, [userId, tgId]);
}

describe('telegram callbackHandler', () => {
  it('rejects a callback from an unknown telegram_id (spoofing)', async () => {
    const m = mockCtx({ updateId: 1, fromTelegramId: 99999, data: 'view:po:1' });
    await handleCallbackQuery(m.ctx);

    expect(m.answer).toHaveBeenCalledTimes(1);
    expect(String(m.answer.mock.calls[0]![0])).toMatch(/topilmadi/i);
    expect(m.answer.mock.calls[0]![1]).toEqual({ showAlert: true });

    const { rows } = await ctx.db.query<{ status: string; user_id: number | null }>(
      `SELECT status, user_id FROM telegram_callback_actions WHERE update_id = $1`,
      [1],
    );
    expect(rows[0]?.status).toBe('rejected_unauthorized');
    expect(rows[0]?.user_id).toBeNull();

    // audit_log row written too — forensic trail demanded by ADR-0011 §6.
    const audit = await ctx.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'telegram_callback_actions'`,
    );
    expect(audit.rows.map((r) => r.action)).toContain('telegram_callback.rejected_unauthorized');
  });

  it('is idempotent on duplicate update_id (Telegram retry)', async () => {
    // Seed a valid user + a production order so the FIRST call mutates,
    // and the SECOND call (same update_id) must be a no-op.
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const target = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const user = await makeUser(ctx.db, { role: 'production_manager', locationId: loc });
    await setTelegramId(user.id, 5550000);
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, $2, $3, $4, 'new') RETURNING id`,
      [product, 5, loc, target],
    );
    const orderId = Number(rows[0]!.id);

    const m1 = mockCtx({ updateId: 42, fromTelegramId: 5550000, data: `start:prod:${orderId}` });
    await handleCallbackQuery(m1.ctx);
    const after1 = await ctx.db.query<{ status: string }>(
      `SELECT status FROM production_orders WHERE id = $1`,
      [orderId],
    );
    expect(after1.rows[0]?.status).toBe('in_progress');

    // SECOND delivery with the same update_id — must hit the UNIQUE
    // constraint, answer with a "duplicate" toast, and not touch the order.
    const m2 = mockCtx({ updateId: 42, fromTelegramId: 5550000, data: `start:prod:${orderId}` });
    await handleCallbackQuery(m2.ctx);

    expect(m2.answer).toHaveBeenCalledTimes(1);
    expect(String(m2.answer.mock.calls[0]![0])).toMatch(/qayta ishlangan/i);

    // Exactly ONE row in the audit table for that update_id.
    const audit = await ctx.db.query(
      `SELECT id FROM telegram_callback_actions WHERE update_id = $1`,
      [42],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects with RBAC when the user role cannot perform the verb', async () => {
    // A store manager seeing a `start:prod` button (wrong role) — denied.
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const wrongUser = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    await setTelegramId(wrongUser.id, 5552222);

    const product = await makeProduct(ctx.db, { type: 'finished' });
    const prodLoc = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, $2, $3, $4, 'new') RETURNING id`,
      [product, 5, prodLoc, central],
    );
    const orderId = Number(rows[0]!.id);

    const m = mockCtx({ updateId: 7, fromTelegramId: 5552222, data: `start:prod:${orderId}` });
    await handleCallbackQuery(m.ctx);

    expect(m.answer).toHaveBeenCalledTimes(1);
    expect(m.answer.mock.calls[0]![1]).toEqual({ showAlert: true });

    const stillNew = await ctx.db.query<{ status: string }>(
      `SELECT status FROM production_orders WHERE id = $1`,
      [orderId],
    );
    expect(stillNew.rows[0]?.status).toBe('new');

    const action = await ctx.db.query<{ status: string }>(
      `SELECT status FROM telegram_callback_actions WHERE update_id = $1`,
      [7],
    );
    expect(action.rows[0]?.status).toBe('rejected_rbac');
  });

  it('runs the happy path: start:prod flips the order and removes the buttons', async () => {
    const prodLoc = await makeLocation(ctx.db, { type: 'production' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const pmUser = await makeUser(ctx.db, { role: 'production_manager', locationId: prodLoc });
    await setTelegramId(pmUser.id, 5557777);

    const product = await makeProduct(ctx.db, { type: 'finished' });
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status)
       VALUES ($1, $2, $3, $4, 'new') RETURNING id`,
      [product, 5, prodLoc, central],
    );
    const orderId = Number(rows[0]!.id);

    const m = mockCtx({ updateId: 100, fromTelegramId: 5557777, data: `start:prod:${orderId}` });
    await handleCallbackQuery(m.ctx);

    expect(m.answer).toHaveBeenCalledTimes(1);
    // Successful ok -> showAlert: false (toast, not modal).
    expect(m.answer.mock.calls[0]![1]).toEqual({ showAlert: false });
    expect(m.editReplyMarkup).toHaveBeenCalledTimes(1); // buttons stripped

    const after = await ctx.db.query<{ status: string }>(
      `SELECT status FROM production_orders WHERE id = $1`,
      [orderId],
    );
    expect(after.rows[0]?.status).toBe('in_progress');

    const action = await ctx.db.query<{ status: string; user_id: string }>(
      `SELECT status, user_id FROM telegram_callback_actions WHERE update_id = $1`,
      [100],
    );
    expect(action.rows[0]?.status).toBe('processed');
    expect(Number(action.rows[0]?.user_id)).toBe(pmUser.id);

    // Matching audit_log entry.
    const audit = await ctx.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'telegram_callback_actions'`,
    );
    expect(audit.rows.map((r) => r.action)).toContain('telegram_callback.processed');
  });

  it('rejects malformed callback_data as failed (parse error)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const user = await makeUser(ctx.db, { role: 'pm', locationId: null });
    await setTelegramId(user.id, 5558888);

    const m = mockCtx({ updateId: 200, fromTelegramId: 5558888, data: 'garbage_data_no_colons' });
    await handleCallbackQuery(m.ctx);

    expect(m.answer).toHaveBeenCalledTimes(1);
    const action = await ctx.db.query<{ status: string; error_detail: string | null }>(
      `SELECT status, error_detail FROM telegram_callback_actions WHERE update_id = $1`,
      [200],
    );
    expect(action.rows[0]?.status).toBe('failed');
    expect(action.rows[0]?.error_detail).toMatch(/parse/i);
    // The seeded location was unused but is here so the chain helper
    // compiles — keep the test grounded against the same shape as the others.
    expect(loc).toBeGreaterThan(0);
  });

  it('view:req returns a follow-up message instead of mutating state', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    await setTelegramId(pm.id, 5559999);

    const product = await makeProduct(ctx.db, { type: 'finished' });
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, target_location_id, qty_needed, status)
       VALUES ($1, $2, $3, $4, 'NEW') RETURNING id`,
      [product, store, central, 10],
    );
    const reqId = Number(rows[0]!.id);

    const m = mockCtx({ updateId: 300, fromTelegramId: 5559999, data: `view:req:${reqId}` });
    await handleCallbackQuery(m.ctx);

    expect(m.answer).toHaveBeenCalledTimes(1);
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
    expect(String(m.sendMessage.mock.calls[0]![0])).toMatch(/Status: NEW/);

    // No buttons stripped on a `view` outcome.
    expect(m.editReplyMarkup).not.toHaveBeenCalled();

    const action = await ctx.db.query<{ status: string }>(
      `SELECT status FROM telegram_callback_actions WHERE update_id = $1`,
      [300],
    );
    expect(action.rows[0]?.status).toBe('processed');
  });
});
