/**
 * Integration tests for the leftover (stock) sync (M7, ADR-0002 §2).
 *
 *   - positive diff -> +adjust movement;
 *   - negative diff -> -adjust movement;
 *   - Poster negative qty -> clamp to 0 + negative_stock_detected notification;
 *   - second run with identical Poster payload -> noop (idempotent).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import { syncStockLeftovers } from '../src/integrations/poster/stockSync.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM poster_sync_log');
});

async function seedLocationAndProduct(opts: {
  posterStorageId: number;
  posterIngredientId: number;
  initialQty?: number;
}): Promise<{ locationId: number; productId: number }> {
  const { rows: l } = await ctx.db.query<{ id: number }>(
    `INSERT INTO locations (name, type, poster_storage_id) VALUES ('Test', 'central_warehouse', $1) RETURNING id`,
    [opts.posterStorageId],
  );
  const { rows: p } = await ctx.db.query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_ingredient_id) VALUES ('X','raw','kg',$1) RETURNING id`,
    [opts.posterIngredientId],
  );
  if (opts.initialQty !== undefined) {
    await ctx.db.query(
      `INSERT INTO stock (location_id, product_id, qty) VALUES ($1, $2, $3)`,
      [l[0]!.id, p[0]!.id, opts.initialQty],
    );
  }
  return { locationId: l[0]!.id, productId: p[0]!.id };
}

function clientWithLeftovers(rowsByStorage: Record<number, unknown[]>): PosterClient {
  return new PosterClient({
    token: 'acc:test',
    minIntervalMs: 0,
    fetcher: ((url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      const method = u.pathname.split('/').pop() ?? '';
      if (method === 'storage.getStorageLeftovers') {
        const sid = Number(u.searchParams.get('storage_id'));
        const rows = rowsByStorage[sid] ?? [];
        return Promise.resolve(
          new Response(JSON.stringify({ response: rows }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
      );
    }) as unknown as typeof fetch,
  });
}

describe('Poster stockSync', () => {
  it('writes a +adjust movement when Poster qty > ADIA qty', async () => {
    const { locationId, productId } = await seedLocationAndProduct({
      posterStorageId: 3,
      posterIngredientId: 100,
      initialQty: 2,
    });
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '100',
          ingredient_name: 'X',
          ingredient_left: '5',
          storage_ingredient_left: '5',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    const summary = await syncStockLeftovers(client);
    expect(summary.adjustments).toBe(1);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(
      `SELECT qty FROM stock WHERE location_id=$1 AND product_id=$2`,
      [locationId, productId],
    );
    expect(stock[0]?.qty).toBeCloseTo(5, 4);
    const { rows: moves } = await ctx.db.query<{ qty: number; reason: string; to_location_id: number | null }>(
      `SELECT qty, reason, to_location_id FROM stock_movements`,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]?.reason).toBe('adjust');
    expect(moves[0]?.to_location_id).toBe(locationId);
    expect(moves[0]?.qty).toBeCloseTo(3, 4); // 5 - 2
  });

  it('writes a -adjust movement when Poster qty < ADIA qty', async () => {
    const { locationId, productId } = await seedLocationAndProduct({
      posterStorageId: 3,
      posterIngredientId: 100,
      initialQty: 10,
    });
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '100',
          ingredient_name: 'X',
          ingredient_left: '4',
          storage_ingredient_left: '4',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    await syncStockLeftovers(client);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(
      `SELECT qty FROM stock WHERE location_id=$1 AND product_id=$2`,
      [locationId, productId],
    );
    expect(stock[0]?.qty).toBeCloseTo(4, 4);
    const { rows: moves } = await ctx.db.query<{ qty: number; from_location_id: number | null }>(
      `SELECT qty, from_location_id FROM stock_movements`,
    );
    expect(moves[0]?.from_location_id).toBe(locationId);
    expect(moves[0]?.qty).toBeCloseTo(6, 4);
  });

  it('clamps a negative Poster qty to 0 and notifies', async () => {
    const { locationId } = await seedLocationAndProduct({
      posterStorageId: 3,
      posterIngredientId: 100,
      initialQty: 4,
    });
    // Seed a PM user so notifyNegative has at least one recipient.
    // F4.12 — username constraint requires 3-32 chars; bare "pm" trips it.
    await ctx.db.query(
      `INSERT INTO users (name, username, password_hash, role)
       VALUES ('pm','pm-test','x','pm')`,
    );
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '100',
          ingredient_name: 'X',
          ingredient_left: '-1',
          storage_ingredient_left: '-1.5',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    const summary = await syncStockLeftovers(client);
    expect(summary.negativesClamped).toBe(1);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(
      `SELECT qty FROM stock WHERE location_id=$1`,
      [locationId],
    );
    expect(stock[0]?.qty).toBeCloseTo(0, 4);
    const { rows: notes } = await ctx.db.query<{ type: string }>(
      `SELECT type FROM notifications WHERE type='negative_stock_detected'`,
    );
    expect(notes.length).toBeGreaterThan(0);
  });

  it('is idempotent — re-running with the same payload is a no-op', async () => {
    await seedLocationAndProduct({
      posterStorageId: 3,
      posterIngredientId: 100,
      initialQty: 0,
    });
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '100',
          ingredient_name: 'X',
          ingredient_left: '5',
          storage_ingredient_left: '5',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    const r1 = await syncStockLeftovers(client);
    expect(r1.adjustments).toBe(1);
    const r2 = await syncStockLeftovers(client);
    expect(r2.adjustments).toBe(0);
    const { rows: moves } = await ctx.db.query<{ id: number }>(`SELECT id FROM stock_movements`);
    expect(moves).toHaveLength(1); // still only the first
  });

  it('debounces `negative_stock_detected` to one notification per (location, product) per 24h (C3)', async () => {
    const { locationId } = await seedLocationAndProduct({
      posterStorageId: 3,
      posterIngredientId: 100,
      initialQty: 4,
    });
    // Seed a PM user so notifyNegative has at least one recipient. Use a
    // suite-unique email — other tests in this file seed `pm@t` and the
    // beforeEach hook does NOT wipe `users`.
    await ctx.db.query(
      `INSERT INTO users (name, username, password_hash, role)
       VALUES ('pm-c3','pm-c3','x','pm')
       ON CONFLICT (username) DO NOTHING`,
    );
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '100',
          ingredient_name: 'X',
          ingredient_left: '-1',
          storage_ingredient_left: '-1.5',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    // Two consecutive scans on the same negative leftover => still ONE
    // notification (dedupeKey = `negative_stock_detected:<loc>:<prod>`,
    // 24h window).
    await syncStockLeftovers(client);
    await syncStockLeftovers(client);
    // Assert per-recipient count: each user (PM and/or location manager)
    // gets exactly ONE notification for this (location, product) — the
    // dedupe key is `negative_stock_detected:<loc>:<prod>:user:<uid>`.
    const { rows: perUser } = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM notifications
        WHERE type='negative_stock_detected'
        GROUP BY recipient_user_id`,
    );
    expect(perUser.length).toBeGreaterThan(0);
    for (const r of perUser) expect(Number(r.n)).toBe(1);

    const { rows: keys } = await ctx.db.query<{ dedupe_key: string | null }>(
      `SELECT dedupe_key FROM notifications WHERE type='negative_stock_detected'`,
    );
    for (const r of keys) {
      expect(r.dedupe_key).toMatch(
        new RegExp(`^negative_stock_detected:${locationId}:\\d+:user:\\d+$`),
      );
    }
  });

  it('skips leftover rows that have no matching ADIA product (e.g. not yet seeded)', async () => {
    await ctx.db.query(
      `INSERT INTO locations (name, type, poster_storage_id) VALUES ('A','central_warehouse',3)`,
    );
    const client = clientWithLeftovers({
      3: [
        {
          ingredient_id: '9999',
          ingredient_name: 'unseeded',
          ingredient_left: '5',
          storage_ingredient_left: '5',
          ingredient_unit: 'kg',
          ingredients_type: '1',
        },
      ],
    });
    const summary = await syncStockLeftovers(client);
    expect(summary.skippedNoProduct).toBe(1);
    expect(summary.adjustments).toBe(0);
  });
});
