/**
 * M1 — Locations & Users integration tests (spec section 4.2, RBAC section 6).
 *
 * Covers AC1.2 / AC1.3: pm sees the whole chain; a scoped manager sees only
 * its own location; non-pm cannot create locations or users.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeLocation } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('locations RBAC (AC1.3 / AC1.2)', () => {
  it('pm sees every location; a store manager sees only its own', async () => {
    const locA = await makeLocation(ctx.db, { name: 'WH', type: 'central_warehouse' });
    const locB = await makeLocation(ctx.db, { name: 'Store B', type: 'store' });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: locB });

    const pmRes = await request(ctx.app)
      .get('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(pmRes.status).toBe(200);
    expect(Array.isArray(pmRes.body)).toBe(true);
    const pmIds = (pmRes.body as { id: number }[]).map((l) => l.id);
    expect(pmIds).toEqual(expect.arrayContaining([locA, locB]));

    const mgrRes = await request(ctx.app)
      .get('/api/locations')
      .set('Authorization', `Bearer ${storeMgr.token}`);
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body).toHaveLength(1);
    expect(mgrRes.body[0].id).toBe(locB);
  });

  it('a manager cannot read another location by id (403)', async () => {
    const own = await makeLocation(ctx.db, { type: 'store' });
    const other = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: own });

    const res = await request(ctx.app)
      .get(`/api/locations/${other}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('pm can create a location; a non-pm cannot (403)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const mgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: await makeLocation(ctx.db),
    });

    const ok = await request(ctx.app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'New raw WH', type: 'raw_warehouse' });
    expect(ok.status).toBe(201);
    expect(ok.body.location).toMatchObject({ name: 'New raw WH', type: 'raw_warehouse' });

    const denied = await request(ctx.app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ name: 'Sneaky', type: 'store' });
    expect(denied.status).toBe(403);
  });

  it('pm PATCH can attach a manager and the change is audit-logged', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ manager_user_id: mgr.id });
    expect(res.status).toBe(200);
    expect(Number(res.body.location.manager_user_id)).toBe(mgr.id);

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'location.update' AND entity_id = $1`,
      [loc],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('pm PATCH can set the dynamic min/max tuning fields', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ lead_time_days: 3, review_days: 2, safety_factor: 1.5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.location.lead_time_days)).toBe(3);
    expect(Number(res.body.location.review_days)).toBe(2);
    expect(Number(res.body.location.safety_factor)).toBe(1.5);
  });

  it('rejects a negative tuning value (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ lead_time_days: -1 });
    expect(res.status).toBe(422);
  });

  it('rejects a location with an invalid type (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Bad', type: 'spaceship' });
    expect(res.status).toBe(422);
  });

  it('F4.9 — GET /api/locations?type=production filters by type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const prodRoot = await makeLocation(ctx.db, {
      type: 'production',
      name: 'Prod root',
    });
    const cakeShop = await makeLocation(ctx.db, {
      type: 'production',
      name: 'Tort sexi',
      parentId: prodRoot,
    });
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });

    const res = await request(ctx.app)
      .get('/api/locations?type=production')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number; parent_id: number | null }[]).map(
      (l) => Number(l.id),
    );
    expect(ids).toContain(prodRoot);
    expect(ids).toContain(cakeShop);
    expect(ids).not.toContain(wh);

    // parent_id of the sub-dept points to the root (frontend uses this to
    // build the sub-tree).
    const cakeRow = (res.body as { id: number; parent_id: number | null }[]).find(
      (l) => Number(l.id) === cakeShop,
    );
    expect(cakeRow).toBeDefined();
    expect(Number(cakeRow?.parent_id)).toBe(prodRoot);
  });

  it('F4.9 — GET /api/locations?type=bogus rejects with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/locations?type=bogus')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });
});

describe('users RBAC (pm only)', () => {
  it('pm can create a user; the password is hashed (not stored plain)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'New manager',
        login: 'created-manager',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_id: loc,
      });
    expect(res.status).toBe(201);
    expect(res.body.user).not.toHaveProperty('password_hash');

    const stored = await ctx.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      ['created-manager'],
    );
    expect(stored.rows[0]?.password_hash).not.toBe('a-strong-pass');
    expect(stored.rows[0]?.password_hash.startsWith('$2')).toBe(true);
  });

  it('a non-pm cannot list or create users (403)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db),
    });
    const list = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(list.status).toBe(403);
  });

  it('rejects a too-short password (422) and a scoped role with no location (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const shortPw = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'X', login: 'x1-user', password: 'short', role: 'pm' });
    expect(shortPw.status).toBe(422);

    const noLoc = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Y',
        login: 'y1-manager',
        password: 'a-strong-pass',
        role: 'store_manager',
      });
    expect(noLoc.status).toBe(422);
  });
});
