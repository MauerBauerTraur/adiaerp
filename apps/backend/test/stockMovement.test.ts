/**
 * M3 — stock movement service unit tests (the critical atomicity path).
 *
 * Covers the M3 acceptance criteria at the service level:
 *   AC3.1 — transfer/receipt/issue: source down, destination up, ledger row.
 *   AC3.2 — insufficient stock -> 409, NOTHING changes (full rollback).
 *   AC3.3 — qty never goes negative (guarded UPDATE + DB CHECK).
 *
 * Runs against the isolated test schema via the app's own db layer, so the
 * `applyMovement` -> `withTransaction` path is exercised exactly as in prod.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock, getQty } from './helpers/fixtures.js';
import { applyMovement } from '../src/services/stockMovement.js';
import { AppError } from '../src/errors/index.js';

let ctx: TestContext;
let warehouse: number;
let store: number;
let product: number;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Fresh locations/product per test keeps cases independent.
  warehouse = await makeLocation(ctx.db, { type: 'central_warehouse' });
  store = await makeLocation(ctx.db, { type: 'store' });
  product = await makeProduct(ctx.db, { type: 'finished' });
});

describe('applyMovement — transfer (AC3.1)', () => {
  it('decrements source, increments destination, writes a ledger row', async () => {
    await setStock(ctx.db, { locationId: warehouse, productId: product, qty: 10 });

    const { movementId } = await applyMovement({
      productId: product,
      fromLocationId: warehouse,
      toLocationId: store,
      qty: 4,
      reason: 'transfer',
      actorUserId: null,
    });

    expect(await getQty(ctx.db, warehouse, product)).toBe(6);
    expect(await getQty(ctx.db, store, product)).toBe(4);

    const ledger = await ctx.db.query<{ qty: string; reason: string }>(
      'SELECT qty, reason FROM stock_movements WHERE id = $1',
      [movementId],
    );
    expect(ledger.rows[0]?.reason).toBe('transfer');
    expect(Number(ledger.rows[0]?.qty)).toBe(4);

    // The audit row is part of the same transaction (invariant 1).
    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
       WHERE action = 'stock_movement.create' AND entity_id = $1`,
      [movementId],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('receipt (no source) increments destination only', async () => {
    await applyMovement({
      productId: product,
      fromLocationId: null,
      toLocationId: warehouse,
      qty: 7,
      reason: 'purchase',
      actorUserId: null,
    });
    expect(await getQty(ctx.db, warehouse, product)).toBe(7);
  });

  it('issue (no destination) decrements source only', async () => {
    await setStock(ctx.db, { locationId: store, productId: product, qty: 5 });
    await applyMovement({
      productId: product,
      fromLocationId: store,
      toLocationId: null,
      qty: 5,
      reason: 'sale',
      actorUserId: null,
    });
    expect(await getQty(ctx.db, store, product)).toBe(0);
  });
});

describe('applyMovement — insufficient stock (AC3.2 & AC3.3)', () => {
  it('rejects with INSUFFICIENT_STOCK and changes NOTHING', async () => {
    await setStock(ctx.db, { locationId: warehouse, productId: product, qty: 3 });

    await expect(
      applyMovement({
        productId: product,
        fromLocationId: warehouse,
        toLocationId: store,
        qty: 10, // more than the 3 on hand
        reason: 'transfer',
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // AC3.2 — source unchanged, destination got nothing, no ledger row.
    expect(await getQty(ctx.db, warehouse, product)).toBe(3);
    expect(await getQty(ctx.db, store, product)).toBe(null);
    const ledger = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock_movements WHERE product_id = $1',
      [product],
    );
    expect(Number(ledger.rows[0]?.n)).toBe(0);
  });

  it('rejects a movement from a location with no stock row at all', async () => {
    await expect(
      applyMovement({
        productId: product,
        fromLocationId: warehouse,
        toLocationId: store,
        qty: 1,
        reason: 'transfer',
        actorUserId: null,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('AC3.3 — qty never goes negative even at the exact boundary', async () => {
    await setStock(ctx.db, { locationId: store, productId: product, qty: 2 });
    // Draining exactly to zero is allowed.
    await applyMovement({
      productId: product,
      fromLocationId: store,
      toLocationId: null,
      qty: 2,
      reason: 'sale',
      actorUserId: null,
    });
    expect(await getQty(ctx.db, store, product)).toBe(0);
    // One more unit must fail — never negative.
    await expect(
      applyMovement({
        productId: product,
        fromLocationId: store,
        toLocationId: null,
        qty: 1,
        reason: 'sale',
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await getQty(ctx.db, store, product)).toBe(0);
  });
});

describe('applyMovement — concurrency (no overselling)', () => {
  it('two parallel movements draining the same row cannot oversell', async () => {
    await setStock(ctx.db, { locationId: warehouse, productId: product, qty: 10 });

    // Both try to take 7; only one can succeed (10 - 7 - 7 would be negative).
    const results = await Promise.allSettled([
      applyMovement({
        productId: product,
        fromLocationId: warehouse,
        toLocationId: store,
        qty: 7,
        reason: 'transfer',
        actorUserId: null,
      }),
      applyMovement({
        productId: product,
        fromLocationId: warehouse,
        toLocationId: store,
        qty: 7,
        reason: 'transfer',
        actorUserId: null,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    // Exactly one movement of 7 applied — the source holds 3, never negative.
    expect(await getQty(ctx.db, warehouse, product)).toBe(3);
  });
});

describe('applyMovement — input validation', () => {
  it('rejects a movement with neither endpoint', async () => {
    await expect(
      applyMovement({
        productId: product,
        fromLocationId: null,
        toLocationId: null,
        qty: 1,
        reason: 'adjust',
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a non-positive qty', async () => {
    await expect(
      applyMovement({
        productId: product,
        fromLocationId: null,
        toLocationId: warehouse,
        qty: 0,
        reason: 'adjust',
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
