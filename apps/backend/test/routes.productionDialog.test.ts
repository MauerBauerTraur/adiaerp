/**
 * EPIC 5 / ADR-0016 §3.4 — production dialog HTTP route (web channel).
 *
 * Drives the public boundary:
 *   GET  /api/production/dialog          — RBAC list (own sex; pm all)
 *   POST /api/production/dialog/:id/answer
 *   POST /api/production/dialog/:id/cancel
 *
 * RBAC: a production_manager only sees / answers dialogs for its own sex; a
 * foreign manager is 403. PM may list (read) but is blocked from answering
 * (write) by the read-and-recommend rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createDialogForOrder } from '../src/services/productionDialog.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function sexWithDialog(): Promise<{ production: number; dialogId: number; sexUser: { token: string; id: number } }> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id)
       VALUES ($1, 'sex_storage'::location_type, $2) RETURNING id`,
    [`Tort skladi ${Math.random().toString(36).slice(2, 8)}`, production],
  );
  const sexStorage = Number(rows[0]?.id);

  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs' });
  const krem = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1,$2,1,'decoration'::recipe_stage), ($1,$3,2,'decoration'::recipe_stage)`,
    [cake, zagatovka, krem],
  );
  await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
  await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });

  const sexUser = await makeUser(ctx.db, { role: 'production_manager', locationId: production });
  const session = await createDialogForOrder({
    productId: cake,
    locationId: production,
    qtyOrdered: 10,
    assignedUserId: sexUser.id,
    actorUserId: sexUser.id,
  });
  return { production, dialogId: session!.id, sexUser };
}

describe('GET /api/production/dialog', () => {
  it('lists open dialogs for the assigned sex manager', async () => {
    const { dialogId, sexUser } = await sexWithDialog();
    const res = await request(ctx.app)
      .get('/api/production/dialog?status=open')
      .set('Authorization', `Bearer ${sexUser.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { id: number }) => s.id);
    expect(ids).toContain(dialogId);
    const found = res.body.sessions.find((s: { id: number }) => s.id === dialogId);
    expect(found.question.options.map((o: { id: string }) => o.id)).toEqual(['ready', 'zero']);
  });

  it('pm sees all open dialogs', async () => {
    const { dialogId } = await sexWithDialog();
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/production/dialog')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { id: number }) => s.id)).toContain(dialogId);
  });

  it('401 without a token', async () => {
    const res = await request(ctx.app).get('/api/production/dialog');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/production/dialog/:id/answer', () => {
  it('the owning sex manager answers and resolves', async () => {
    const { dialogId, sexUser } = await sexWithDialog();
    const res = await request(ctx.app)
      .post(`/api/production/dialog/${dialogId}/answer`)
      .set('Authorization', `Bearer ${sexUser.token}`)
      .send({ option_id: 'ready' });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.session.state).toBe('RESOLVED');
  });

  it('a foreign production manager is 403', async () => {
    const { dialogId } = await sexWithDialog();
    const otherSex = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, { role: 'production_manager', locationId: otherSex });
    const res = await request(ctx.app)
      .post(`/api/production/dialog/${dialogId}/answer`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ option_id: 'ready' });
    expect(res.status).toBe(403);
  });

  it('pm is blocked from answering (read-and-recommend)', async () => {
    const { dialogId } = await sexWithDialog();
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/production/dialog/${dialogId}/answer`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ option_id: 'ready' });
    expect(res.status).toBe(403);
  });

  it('an invalid option is 422 INVALID_OPTION', async () => {
    const { dialogId, sexUser } = await sexWithDialog();
    const res = await request(ctx.app)
      .post(`/api/production/dialog/${dialogId}/answer`)
      .set('Authorization', `Bearer ${sexUser.token}`)
      .send({ option_id: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_OPTION');
  });

  it('404 for an unknown dialog id', async () => {
    const { sexUser } = await sexWithDialog();
    const res = await request(ctx.app)
      .post(`/api/production/dialog/99999999/answer`)
      .set('Authorization', `Bearer ${sexUser.token}`)
      .send({ option_id: 'ready' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/production/dialog/:id/cancel', () => {
  it('the owning sex manager cancels', async () => {
    const { dialogId, sexUser } = await sexWithDialog();
    const res = await request(ctx.app)
      .post(`/api/production/dialog/${dialogId}/cancel`)
      .set('Authorization', `Bearer ${sexUser.token}`)
      .send({ reason: 'no longer needed' });
    expect(res.status).toBe(200);
    expect(res.body.session.state).toBe('CANCELLED');
  });
});
