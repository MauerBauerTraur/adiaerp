/**
 * Route-level tests for `/api/integrations/poster/*` (spec section 4.9).
 *
 *   - webhook: 401 without secret, 401 with wrong secret, 200 + payload row
 *     with correct secret; form-encoded payloads supported;
 *   - sync: 403 for non-pm, 422 for bad `entity`, 200 (with mocked client)
 *     for pm; (we install a stub via setPosterClientForTests);
 *   - status: 403 for non-pm, 200 returns recent rows for pm.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';
import {
  PosterClient,
  setPosterClientForTests,
} from '../src/integrations/poster/client.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  setPosterClientForTests(undefined);
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM poster_webhook_events');
  await ctx.db.query('DELETE FROM poster_sync_log');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM products');
  // Users reference locations.manager_user_id and locations reference user via
  // location_id — delete users first to drop the user->location FK, then drop
  // the manager_user_id link from locations before dropping locations.
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
});

describe('POST /api/integrations/poster/webhook', () => {
  beforeEach(() => {
    // Set the webhook secret via env then force a config reload — `loadConfig`
    // memoises, so the change only takes effect after a reset.
    process.env.POSTER_WEBHOOK_SECRET = 'topsecret-abc-xyz-9876';
  });

  it('rejects calls without a secret', async () => {
    // Re-import config to force a fresh read after setting env.
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const res = await request(ctx.app).post('/api/integrations/poster/webhook').send({});
    expect(res.status).toBe(401);
  });

  it('rejects calls with a wrong secret', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const res = await request(ctx.app)
      .post('/api/integrations/poster/webhook/not-the-secret')
      .send({});
    expect(res.status).toBe(401);
  });

  it('accepts a correct path secret and stores the raw payload (form-encoded)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const res = await request(ctx.app)
      .post('/api/integrations/poster/webhook/topsecret-abc-xyz-9876')
      .type('form')
      .send('action=transaction.close&object_id=42&account=adia');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const { rows } = await ctx.db.query<{ event_type: string; poster_object_id: number | null; processed: boolean }>(
      `SELECT event_type, poster_object_id, processed FROM poster_webhook_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('transaction.close');
    expect(rows[0]?.poster_object_id).toBe(42);
    expect(rows[0]?.processed).toBe(false);
  });

  it('accepts a correct query-string secret', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const res = await request(ctx.app)
      .post('/api/integrations/poster/webhook?secret=topsecret-abc-xyz-9876')
      .send({ event_type: 'transaction.close', object_id: 7 });
    expect(res.status).toBe(200);
    const { rows } = await ctx.db.query<{ id: number }>(`SELECT id FROM poster_webhook_events`);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent at the row level — duplicate webhooks land as separate event rows but processing dedupes downstream', async () => {
    // The endpoint always inserts a new event row; the downstream worker uses
    // the sales UNIQUE indexes for true idempotency. This test verifies that
    // the endpoint itself is fast/simple — duplicates are queued, not rejected.
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    for (let i = 0; i < 3; i += 1) {
      await request(ctx.app)
        .post('/api/integrations/poster/webhook/topsecret-abc-xyz-9876')
        .send({ event_type: 'transaction.close', object_id: 99 });
    }
    const { rows } = await ctx.db.query<{ id: number }>(`SELECT id FROM poster_webhook_events`);
    expect(rows).toHaveLength(3);
  });
});

describe('POST /api/integrations/poster/sync (pm)', () => {
  it('refuses non-pm callers', async () => {
    const store = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type) VALUES ('S','store') RETURNING id`,
    );
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: store.rows[0]!.id });
    const res = await request(ctx.app)
      .post('/api/integrations/poster/sync')
      .set('Authorization', `Bearer ${user.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('validates the `entity` query parameter', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .post('/api/integrations/poster/sync?entity=garbage')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('runs the locations sync using the injected Poster client', async () => {
    // Install a stub client that returns a fixed `access.getSpots` payload.
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'access.getSpots') {
            return Promise.resolve(
              new Response(
                JSON.stringify({ response: [{ spot_id: '1', name: 'Кукча', spot_name: 'Кукча' }] }),
                { status: 200 },
              ),
            );
          }
          if (m === 'storage.getStorages') {
            return Promise.resolve(
              new Response(
                JSON.stringify({ response: [{ storage_id: '3', storage_name: 'C' }] }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
          );
        }) as unknown as typeof fetch,
      }),
    );
    // The route checks config.poster.token != ''; set a non-empty value.
    process.env.POSTER_TOKEN = 'acc:test';
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .post('/api/integrations/poster/sync?entity=locations')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    const { rows } = await ctx.db.query<{ poster_spot_id: number | null; poster_storage_id: number | null }>(
      `SELECT poster_spot_id, poster_storage_id FROM locations`,
    );
    // ADR-0017 §4 (P2): storage 3 is store-backing — it does NOT create a
    // standalone location, it merges onto spot 1's row. So a single store
    // location carries BOTH the spot id and the storage id.
    expect(rows.length).toBe(1);
    expect(rows[0]?.poster_spot_id).toBe(1);
    expect(rows[0]?.poster_storage_id).toBe(3);
  });
});

describe('GET /api/integrations/poster/status (pm)', () => {
  it('refuses non-pm', async () => {
    const store = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type) VALUES ('S','store') RETURNING id`,
    );
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: store.rows[0]!.id });
    const res = await request(ctx.app)
      .get('/api/integrations/poster/status')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

  it('returns the recent sync log rows for a pm', async () => {
    await ctx.db.query(
      `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied)
       VALUES ('spots','ok','manual',5,5)`,
    );
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/integrations/poster/status')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].entity).toBe('spots');
  });
});
