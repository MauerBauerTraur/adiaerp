/**
 * Integration tests for the sales sync (M7, ADR-0002 §3).
 *
 *   - `ingestTransaction` writes one `sales` row per check line, decrements
 *     the store stock, and is idempotent on re-run;
 *   - `processPendingWebhookEvents` drains `poster_webhook_events` rows;
 *   - line product_id is resolved via `products.poster_product_id`
 *     (the menu side — NOT `poster_ingredient_id`, ADR-0002 §1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import {
  ingestTransaction,
  processPendingWebhookEvents,
} from '../src/integrations/poster/salesSync.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM sales');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM poster_webhook_events');
  await ctx.db.query('DELETE FROM poster_sync_log');
  await ctx.db.query('DELETE FROM audit_log');
});

async function seedStoreAndMenuProduct(): Promise<{ storeId: number; productId: number }> {
  const { rows: s } = await ctx.db.query<{ id: number }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2) RETURNING id`,
  );
  const { rows: p } = await ctx.db.query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id) VALUES ('Cake','finished','pcs',440) RETURNING id`,
  );
  return { storeId: s[0]!.id, productId: p[0]!.id };
}

describe('ingestTransaction', () => {
  it('writes a sales row, decrements stock, and is idempotent on re-run', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    const payload = {
      transaction_id: '12345',
      spot_id: '2',
      date_close: '1779521920864',
      products: [{ product_id: '440', modification_id: '0', num: '2', product_price: '19200000' }],
    };
    const r1 = await ingestTransaction(payload);
    expect(r1.linesInserted).toBe(1);
    expect(r1.movementsApplied).toBe(1);
    const { rows: sales } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    expect(sales).toHaveLength(1);
    expect(sales[0]?.qty).toBeCloseTo(2, 4);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock[0]?.qty).toBeCloseTo(3, 4);

    // Replay — UNIQUE indexes must protect us.
    const r2 = await ingestTransaction(payload);
    expect(r2.linesInserted).toBe(0);
    expect(r2.movementsApplied).toBe(0);
    const { rows: stock2 } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock2[0]?.qty).toBeCloseTo(3, 4); // unchanged
    const { rows: moves } = await ctx.db.query<{ id: number }>(`SELECT id FROM stock_movements`);
    expect(moves).toHaveLength(1);
  });

  it('skips a line whose product is not seeded (menu-only items)', async () => {
    // Seed only the store; no product mapping.
    await ctx.db.query(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2)`,
    );
    const r = await ingestTransaction({
      transaction_id: '7',
      spot_id: '2',
      products: [{ product_id: '404', modification_id: '0', num: '1', product_price: '0' }],
    });
    expect(r.linesInserted).toBe(0);
    expect(r.storeFound).toBe(true);
  });

  it('reports storeFound=false when the spot has no ADIA location', async () => {
    const r = await ingestTransaction({
      transaction_id: '8',
      spot_id: '999',
      products: [{ product_id: '440', num: '1', product_price: '0' }],
    });
    expect(r.storeFound).toBe(false);
    expect(r.linesInserted).toBe(0);
  });

  it('clamps the decrement when ADIA has less stock than the sale qty (never goes negative)', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,1)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '9',
      spot_id: '2',
      products: [{ product_id: '440', num: '3', product_price: '100' }], // sells more than stock
    });
    expect(r.linesInserted).toBe(1);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock[0]?.qty).toBeCloseTo(0, 4); // clamped
  });
});

describe('processPendingWebhookEvents', () => {
  it('drains queued events, fetches the full check, and marks processed', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    await ctx.db.query(
      `INSERT INTO poster_webhook_events (event_type, poster_object_id, payload)
       VALUES ('transaction.close', $1, $2)`,
      [101, JSON.stringify({ raw: true })],
    );

    const client = new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        if (u.pathname.endsWith('dash.getTransaction')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: {
                  transaction_id: '101',
                  spot_id: '2',
                  date_close: '1779521920864',
                  products: [{ product_id: '440', num: '1', product_price: '500' }],
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });

    const summary = await processPendingWebhookEvents(client, 50);
    expect(summary.eventsScanned).toBe(1);
    expect(summary.eventsApplied).toBe(1);
    expect(summary.linesInserted).toBe(1);
    const { rows: events } = await ctx.db.query<{ processed: boolean }>(
      `SELECT processed FROM poster_webhook_events`,
    );
    expect(events[0]?.processed).toBe(true);
  });
});
