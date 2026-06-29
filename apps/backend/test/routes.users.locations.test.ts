/**
 * F4.1 — Users <-> locations (M:N) endpoints (ADR-0012).
 *
 * Drives the public HTTP boundary so middleware + handler branches are
 * exercised end-to-end:
 *
 *   POST   /api/users                            — `location_ids` shape, M:N rows
 *   GET    /api/users/:id/locations              — pm vs self
 *   POST   /api/users/:id/locations              — assign, atomic primary swap
 *   DELETE /api/users/:id/locations/:lid         — refuse to drop primary
 *   PUT    /api/users/:id/locations/:lid/primary — atomic primary flip
 *
 * Invariants covered: only one primary per user (partial unique); users.
 * location_id stays mirrored to the M:N is_primary row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('POST /api/users — `location_ids` (M:N create)', () => {
  it('creates a user assigned to three locations with one primary', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const store3 = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Multi Keeper',
        login: 'multi-keeper',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_ids: [store1, store2, store3],
        primary_location_id: store2,
      });
    expect(res.status).toBe(201);
    const userId = res.body.user.id;

    // users.location_id mirrors the chosen primary.
    expect(res.body.user.location_id).toBe(store2);

    // user_locations holds three rows, exactly one is primary.
    const { rows } = await ctx.db.query<{ location_id: string; is_primary: boolean }>(
      `SELECT location_id, is_primary FROM user_locations WHERE user_id = $1
        ORDER BY location_id`,
      [userId],
    );
    expect(rows).toHaveLength(3);
    const primaries = rows.filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(Number(primaries[0]!.location_id)).toBe(store2);
  });

  it('rejects `primary_location_id` outside `location_ids` with a 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });
    const b = await makeLocation(ctx.db, { type: 'store' });
    const elsewhere = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Bad Primary',
        login: 'bad-primary',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_ids: [a, b],
        primary_location_id: elsewhere,
      });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate id inside `location_ids`', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Dup',
        login: 'dup-loc',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_ids: [a, a],
      });
    expect(res.status).toBe(422);
  });

  it('rejects a non-existent location id inside `location_ids` with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Ghost',
        login: 'ghost-loc',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_ids: [a, 999_999_999],
      });
    expect(res.status).toBe(422);
  });

  it('legacy `location_id` (single) still works and back-fills user_locations', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Legacy',
        login: 'legacy-user',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_id: store,
      });
    expect(res.status).toBe(201);
    expect(res.body.user.location_id).toBe(store);

    const { rows } = await ctx.db.query(
      `SELECT location_id, is_primary FROM user_locations WHERE user_id = $1`,
      [res.body.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_primary).toBe(true);
  });
});

describe('GET /api/users/:id/locations — pm or self', () => {
  it('PM can read any user', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get(`/api/users/${mgr.id}/locations`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].location_id).toBe(store);
    expect(res.body[0].is_primary).toBe(true);
  });

  it('a non-PM cannot read another user', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr1 = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const mgr2 = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get(`/api/users/${mgr2.id}/locations`)
      .set('Authorization', `Bearer ${mgr1.token}`);
    expect(res.status).toBe(403);
  });

  it('a user can read its own location list (self)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get(`/api/users/${mgr.id}/locations`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('POST /api/users/:id/locations — assign + atomic primary swap', () => {
  it('assigns a secondary location without touching the primary', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });

    const res = await request(ctx.app)
      .post(`/api/users/${mgr.id}/locations`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: store2 });
    expect(res.status).toBe(201);

    const { rows } = await ctx.db.query<{ location_id: string; is_primary: boolean }>(
      `SELECT location_id, is_primary FROM user_locations
        WHERE user_id = $1 ORDER BY location_id`,
      [mgr.id],
    );
    expect(rows).toHaveLength(2);
    const primaries = rows.filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(Number(primaries[0]!.location_id)).toBe(store1);
  });

  it('promoting a new location to primary atomically demotes the old', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });

    // Assign+promote in one call.
    const res = await request(ctx.app)
      .post(`/api/users/${mgr.id}/locations`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: store2, is_primary: true });
    expect(res.status).toBe(201);

    const { rows } = await ctx.db.query<{ location_id: string; is_primary: boolean }>(
      `SELECT location_id, is_primary FROM user_locations
        WHERE user_id = $1 ORDER BY location_id`,
      [mgr.id],
    );
    const primaries = rows.filter((r) => r.is_primary);
    expect(primaries).toHaveLength(1);
    expect(Number(primaries[0]!.location_id)).toBe(store2);

    // users.location_id is mirrored.
    const { rows: userRows } = await ctx.db.query<{ location_id: string }>(
      `SELECT location_id FROM users WHERE id = $1`,
      [mgr.id],
    );
    expect(Number(userRows[0]!.location_id)).toBe(store2);
  });

  it('non-pm cannot assign — 403', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .post(`/api/users/${mgr.id}/locations`)
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: otherStore });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/users/:id/locations/:location_id — guard primary', () => {
  it('refuses to remove a primary location with a 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .delete(`/api/users/${mgr.id}/locations/${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });

  it('removes a secondary location with 204', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });
    // Add secondary.
    await ctx.db.query(
      `INSERT INTO user_locations (user_id, location_id, is_primary) VALUES ($1, $2, FALSE)`,
      [mgr.id, store2],
    );

    const res = await request(ctx.app)
      .delete(`/api/users/${mgr.id}/locations/${store2}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(204);

    const { rows } = await ctx.db.query(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [mgr.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('PUT /api/users/:id/locations/:lid/primary — atomic primary flip', () => {
  it('flips primary and updates users.location_id', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });
    const b = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: a });
    await ctx.db.query(
      `INSERT INTO user_locations (user_id, location_id, is_primary) VALUES ($1, $2, FALSE)`,
      [mgr.id, b],
    );

    const res = await request(ctx.app)
      .put(`/api/users/${mgr.id}/locations/${b}/primary`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(204);

    const { rows } = await ctx.db.query<{ location_id: string; is_primary: boolean }>(
      `SELECT location_id, is_primary FROM user_locations
        WHERE user_id = $1 AND is_primary = TRUE`,
      [mgr.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.location_id)).toBe(b);

    const { rows: u } = await ctx.db.query<{ location_id: string }>(
      `SELECT location_id FROM users WHERE id = $1`,
      [mgr.id],
    );
    expect(Number(u[0]!.location_id)).toBe(b);
  });

  it('is idempotent — promoting the already-primary returns 204 with no-op', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: a });

    const res = await request(ctx.app)
      .put(`/api/users/${mgr.id}/locations/${a}/primary`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(204);
  });

  it('404 when the user is not assigned to that location', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'store' });
    const b = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: a });

    const res = await request(ctx.app)
      .put(`/api/users/${mgr.id}/locations/${b}/primary`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
  });
});
