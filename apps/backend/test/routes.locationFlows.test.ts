/**
 * EPIC 2.1 — location_flows CRUD (admin connection management).
 *
 *   GET    /api/locations/flows       — list (pm only)
 *   POST   /api/locations/flows       — create (pm only)
 *   DELETE /api/locations/flows/:id   — delete (pm only)
 *
 * Covers: pm-only RBAC, validation (from≠to, both endpoints exist, duplicate),
 * the audit log, and that the literal `/flows` path is not swallowed by the
 * `/:id` param matcher.
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

describe('location_flows CRUD (EPIC 2.1)', () => {
  it('pm can create, list and delete a flow; each write is audit-logged', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const from = await makeLocation(ctx.db, { type: 'production', name: 'Sex A' });
    const to = await makeLocation(ctx.db, { type: 'central_warehouse', name: 'Central A' });

    const created = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: from, to_location_id: to, flow_type: 'forward', note: 'hi' });
    expect(created.status).toBe(201);
    expect(created.body.flow).toMatchObject({
      from_location_id: from,
      to_location_id: to,
      flow_type: 'forward',
      note: 'hi',
    });
    const flowId = Number(created.body.flow.id);

    const list = await request(ctx.app)
      .get('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect((list.body as { id: number }[]).some((f) => Number(f.id) === flowId)).toBe(true);

    const createdAudit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'location_flow.create' AND entity_id = $1`,
      [flowId],
    );
    expect(Number(createdAudit.rows[0]?.n)).toBe(1);

    const del = await request(ctx.app)
      .delete(`/api/locations/flows/${flowId}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(del.status).toBe(204);

    const gone = await ctx.db.query<{ id: number }>(
      'SELECT id FROM location_flows WHERE id = $1',
      [flowId],
    );
    expect(gone.rows).toHaveLength(0);

    const deleteAudit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'location_flow.delete' AND entity_id = $1`,
      [flowId],
    );
    expect(Number(deleteAudit.rows[0]?.n)).toBe(1);
  });

  it('rejects a self-loop (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const res = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: loc, to_location_id: loc, flow_type: 'forward' });
    expect(res.status).toBe(422);
  });

  it('rejects a non-existent endpoint (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const res = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: loc, to_location_id: 9_999_999, flow_type: 'forward' });
    expect(res.status).toBe(422);
  });

  it('rejects an invalid flow_type (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'production' });
    const b = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const res = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: a, to_location_id: b, flow_type: 'teleport' });
    expect(res.status).toBe(422);
  });

  it('rejects a duplicate (from,to,flow_type) (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, { type: 'production' });
    const b = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const first = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: a, to_location_id: b, flow_type: 'forward' });
    expect(first.status).toBe(201);
    const dup = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ from_location_id: a, to_location_id: b, flow_type: 'forward' });
    expect(dup.status).toBe(422);
  });

  it('a non-pm cannot list, create or delete flows (403)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db, { type: 'store' }),
    });
    const a = await makeLocation(ctx.db, { type: 'production' });
    const b = await makeLocation(ctx.db, { type: 'central_warehouse' });

    const list = await request(ctx.app)
      .get('/api/locations/flows')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(list.status).toBe(403);

    const create = await request(ctx.app)
      .post('/api/locations/flows')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ from_location_id: a, to_location_id: b, flow_type: 'forward' });
    expect(create.status).toBe(403);

    const del = await request(ctx.app)
      .delete('/api/locations/flows/1')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(del.status).toBe(403);
  });

  it('deleting a non-existent flow returns 404', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .delete('/api/locations/flows/9999999')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
  });
});
