/**
 * Per-user page (bo'lim) access — migration 0061.
 *
 *   GET /api/users/:id/pages — pm or self, 403 for anyone else
 *   PUT /api/users/:id/pages — pm only; replace-all; rejects unknown paths
 *
 * Also pins the role-derived default location on `POST /api/users`, since the
 * Foydalanuvchilar form stopped sending `location_ids` when this feature
 * replaced the bo'g'in picker.
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

describe('GET/PUT /api/users/:id/pages', () => {
  it('starts empty — no rows means "no override", i.e. the role default', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    const res = await request(ctx.app)
      .get(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual([]);
  });

  it('replaces the whole whitelist on PUT', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    const first = await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: ['/dashboard', '/sotuvlar', '/cashier/receipts'] });
    expect(first.status).toBe(200);

    // A second PUT is a replace, not a merge — the dropped paths are gone.
    const second = await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: ['/dashboard'] });
    expect(second.status).toBe(200);

    const res = await request(ctx.app)
      .get(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.body.paths).toEqual(['/dashboard']);
  });

  it('clears the override when given an empty array', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: ['/dashboard'] });
    await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: [] });

    const res = await request(ctx.app)
      .get(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.body.paths).toEqual([]);
  });

  it('rejects a path outside the navigation model', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    const res = await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: ['/dashboard', '/etc/passwd'] });
    expect(res.status).toBe(422);

    // Nothing was written — the whole PUT is rejected at the boundary.
    const { rows } = await ctx.db.query(
      `SELECT 1 FROM user_page_access WHERE user_id = $1`,
      [keeper.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a user read their own access but not write it', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    const read = await request(ctx.app)
      .get(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${keeper.token}`);
    expect(read.status).toBe(200);

    const write = await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${keeper.token}`)
      .send({ paths: ['/dashboard'] });
    expect(write.status).toBe(403);
  });

  it('lets a super_admin read anyone — it may write, so it must read', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    // Chain-wide since migration 0062 — no location needed.
    const owner = await makeUser(ctx.db, { role: 'super_admin' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ paths: ['/dashboard'] })
      .expect(200);

    const res = await request(ctx.app)
      .get(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual(['/dashboard']);
  });

  it("refuses another user's access", async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const a = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const b = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get(`/api/users/${b.id}/pages`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(403);
  });

  it('surfaces the whitelist on GET /api/auth/me', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const keeper = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    await request(ctx.app)
      .put(`/api/users/${keeper.id}/pages`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ paths: ['/dashboard', '/sotuvlar'] });

    const me = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${keeper.token}`);
    expect(me.status).toBe(200);
    expect(me.body.allowed_paths).toEqual(['/dashboard', '/sotuvlar']);
  });
});

describe('POST /api/users — role-derived default location', () => {
  it('attaches the location matching the role when none is supplied', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeLocation(ctx.db, { type: 'store' });
    // The schema may already carry seeded stores, so derive the expectation
    // the same way the handler does: the lowest-id location of the role's type.
    const { rows: expected } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM locations WHERE type::text = 'store' ORDER BY id LIMIT 1`,
    );
    const store = Number(expected[0]!.id);

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Auto Keeper',
        login: `auto-keeper-${Date.now()}`,
        password: 'a-strong-pass',
        role: 'store_manager',
      });
    expect(res.status).toBe(201);

    // The form no longer picks a bo'g'in, but a scoped user still needs one:
    // every RBAC-scoped endpoint reads users.location_id.
    expect(res.body.user.location_id).not.toBeNull();

    const { rows } = await ctx.db.query<{ location_id: string; is_primary: boolean }>(
      `SELECT location_id, is_primary FROM user_locations WHERE user_id = $1`,
      [res.body.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_primary).toBe(true);
    expect(Number(rows[0]!.location_id)).toBe(store);
  });

  it('still honours an explicit location_ids payload', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeLocation(ctx.db, { type: 'store' });
    const chosen = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Explicit Keeper',
        login: `explicit-keeper-${Date.now()}`,
        password: 'a-strong-pass',
        role: 'store_manager',
        location_ids: [chosen],
      });
    expect(res.status).toBe(201);
    expect(res.body.user.location_id).toBe(chosen);
  });

  it('creates a chain-wide super_admin with no location (migration 0062)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // `CHAIN_WIDE_ROLES` in the handler has always included `super_admin`,
    // but `chk_users_location_required` did not — so this used to pass the
    // boundary check and then blow up as a raw 500 from the DB.
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Owner',
        login: `owner-${Date.now()}`,
        password: 'a-strong-pass',
        role: 'super_admin',
      });
    expect(res.status).toBe(201);
    expect(res.body.user.location_id).toBeNull();
  });
});
