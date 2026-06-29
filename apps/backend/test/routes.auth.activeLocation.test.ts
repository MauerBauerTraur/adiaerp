/**
 * F4.1 — Active location switching (ADR-0012).
 *
 *   GET   /api/auth/me                  — returns `locations[]` + `active_location_id`.
 *   PATCH /api/auth/active-location     — validates the new id is assigned.
 *   `X-Active-Location` header          — overrides primary; invalid id -> 403.
 *
 * Covers the principal-level branches in `authenticate` middleware:
 *   header valid + in set       -> activeLocationId = header value
 *   header valid + NOT in set   -> 403 FORBIDDEN (scoped user)
 *   header valid + chain-wide   -> 200 (pm may pick any)
 *   no header                   -> activeLocationId = primary
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

describe('GET /api/auth/me — extended with locations[]', () => {
  it('returns the user, all assigned locations, and the active location id', async () => {
    const store1 = await makeLocation(ctx.db, { name: 'Filial-1', type: 'store' });
    const store2 = await makeLocation(ctx.db, { name: 'Filial-2', type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });
    await ctx.db.query(
      `INSERT INTO user_locations (user_id, location_id, is_primary) VALUES ($1, $2, FALSE)`,
      [mgr.id, store2],
    );

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(mgr.id);
    expect(res.body.locations).toHaveLength(2);
    // Primary comes first.
    expect(res.body.locations[0].is_primary).toBe(true);
    expect(res.body.locations[0].id).toBe(store1);
    // Without header, active location is primary.
    expect(res.body.active_location_id).toBe(store1);
  });

  it('reflects the X-Active-Location header in the active_location_id field', async () => {
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });
    await ctx.db.query(
      `INSERT INTO user_locations (user_id, location_id, is_primary) VALUES ($1, $2, FALSE)`,
      [mgr.id, store2],
    );

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${mgr.token}`)
      .set('X-Active-Location', String(store2));
    expect(res.status).toBe(200);
    expect(res.body.active_location_id).toBe(store2);
  });

  it('PM (chain-wide) sees an empty locations[] and a null active_location_id without a header', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual([]);
    expect(res.body.active_location_id).toBeNull();
  });
});

describe('X-Active-Location header — middleware-level validation', () => {
  it('rejects an id not in the user assignment set with 403', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${mgr.token}`)
      .set('X-Active-Location', String(otherStore));
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects a non-integer header with 422 VALIDATION_ERROR', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${mgr.token}`)
      .set('X-Active-Location', 'not-a-number');
    expect(res.status).toBe(422);
  });

  it('PM may pick any location id via the header (chain-wide bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const anywhere = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${pm.token}`)
      .set('X-Active-Location', String(anywhere));
    expect(res.status).toBe(200);
    expect(res.body.active_location_id).toBe(anywhere);
  });
});

describe('PATCH /api/auth/active-location', () => {
  it('accepts an assigned location and writes an audit row', async () => {
    const store1 = await makeLocation(ctx.db, { type: 'store' });
    const store2 = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store1 });
    await ctx.db.query(
      `INSERT INTO user_locations (user_id, location_id, is_primary) VALUES ($1, $2, FALSE)`,
      [mgr.id, store2],
    );

    const res = await request(ctx.app)
      .patch('/api/auth/active-location')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: store2 });
    expect(res.status).toBe(200);
    expect(res.body.active_location_id).toBe(store2);

    const { rows } = await ctx.db.query<{ n: string; aloc: string | null }>(
      `SELECT count(*) AS n, max(active_location_id) AS aloc FROM audit_log
        WHERE action = 'auth.active_location.set' AND entity_id = $1`,
      [mgr.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    // Audit log records the new active location (0014 migration column).
    expect(Number(rows[0]?.aloc)).toBe(store2);
  });

  it('rejects an unassigned location with 403', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const elsewhere = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .patch('/api/auth/active-location')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: elsewhere });
    expect(res.status).toBe(403);
  });

  it('PM with a non-existent location id returns 404 NOT_FOUND', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .patch('/api/auth/active-location')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: 999_999_999 });
    expect(res.status).toBe(404);
  });
});
