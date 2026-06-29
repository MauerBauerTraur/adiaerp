/**
 * Phase-2 admin endpoints — integration tests.
 *
 *   PATCH /api/stock/minmax-mode               — mode toggle + RBAC + audit
 *   POST  /api/admin/recalc-minmax             — PM-only manual trigger
 *   GET   /api/admin/import-warnings           — list, filters, pagination
 *   POST  /api/admin/import-warnings/:id/resolve
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeLocation, makeProduct, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('PATCH /api/stock/minmax-mode', () => {
  it('PM may flip any (location, product) row between manual and dynamic', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: storeId, productId, qty: 0, minLevel: 0, maxLevel: 0 });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const res = await request(ctx.app)
      .patch('/api/stock/minmax-mode')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: storeId, product_id: productId, mode: 'dynamic' });
    expect(res.status).toBe(200);
    expect(res.body.stock.minmax_mode).toBe('dynamic');

    // Audit row exists.
    const { rows } = await ctx.db.query<{ payload: { mode: string } }>(
      `SELECT payload FROM audit_log
        WHERE action = 'stock.minmax_mode.update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.payload.mode).toBe('dynamic');
  });

  it('a scoped manager may flip only its own location', async () => {
    const myStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db);
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });

    const ok = await request(ctx.app)
      .patch('/api/stock/minmax-mode')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: myStore, product_id: product, mode: 'dynamic' });
    expect(ok.status).toBe(200);

    const forbidden = await request(ctx.app)
      .patch('/api/stock/minmax-mode')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: otherStore, product_id: product, mode: 'dynamic' });
    expect(forbidden.status).toBe(403);
  });

  it('rejects an invalid mode value (422)', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const productId = await makeProduct(ctx.db);
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const res = await request(ctx.app)
      .patch('/api/stock/minmax-mode')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: storeId, product_id: productId, mode: 'foo' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/admin/recalc-minmax', () => {
  it('PM-only — a store manager is 403', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
    const res = await request(ctx.app)
      .post('/api/admin/recalc-minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('PM runs the recalc; an empty chain returns zero counts', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    // Run with a filter that matches no rows — exercises the empty path.
    const res = await request(ctx.app)
      .post('/api/admin/recalc-minmax')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: 9999999, product_id: 9999999 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 0, updated: 0, skipped: 0, errors: 0 });

    // Audit row was written for the human trigger.
    const { rows } = await ctx.db.query<{ payload: unknown }>(
      `SELECT payload FROM audit_log
        WHERE action = 'admin.recalc_minmax.trigger'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.payload).toBeDefined();
  });
});

describe('GET /api/admin/import-warnings', () => {
  it('PM-only; a scoped manager is 403', async () => {
    const storeId = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
    const res = await request(ctx.app)
      .get('/api/admin/import-warnings')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('returns warnings with pagination + filters', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    await ctx.db.query(
      `INSERT INTO import_warnings (source, entity, severity, message)
       VALUES ('poster.prepack', 'product:1', 'warning', 'bad recipe'),
              ('minmax.recalc',  'stock:1:1', 'info',    'no sales'),
              ('minmax.recalc',  'stock:1:2', 'warning', 'would zero')`,
    );
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const all = await request(ctx.app)
      .get('/api/admin/import-warnings')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(3);

    const filtered = await request(ctx.app)
      .get('/api/admin/import-warnings?source=minmax.recalc&severity=info')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0]!.severity).toBe('info');
  });

  it('POST /:id/resolve marks the row resolved exactly once', async () => {
    await ctx.db.query('DELETE FROM import_warnings');
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO import_warnings (source, severity, message)
       VALUES ('poster.prepack', 'warning', 'test')
       RETURNING id`,
    );
    const id = Number(rows[0]!.id);
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const first = await request(ctx.app)
      .post(`/api/admin/import-warnings/${id}/resolve`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(first.status).toBe(200);
    expect(first.body.warning.resolved).toBe(true);

    // A second call is a 404 because the row is already resolved.
    const second = await request(ctx.app)
      .post(`/api/admin/import-warnings/${id}/resolve`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(second.status).toBe(404);
  });
});
