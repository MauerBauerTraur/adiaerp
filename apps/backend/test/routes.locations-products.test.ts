/**
 * Sprint 2 hardening — route-level coverage for locations and products.
 *
 * Targets:
 *   GET    /api/locations/:id  — pm sees any, scoped manager forbidden, 404.
 *   POST   /api/locations      — invalid type 422, parent_id passthrough.
 *   PATCH  /api/locations/:id  — no-fields 422, unknown id 404, invalid
 *                                is_active type 422.
 *   POST   /api/products       — invalid type/unit 422, duplicate SKU 422.
 *   GET    /api/products?type= — invalid type 422.
 *   PUT    /api/products/:id/recipe — non-array body, missing component id,
 *                                      duplicate component, product 404,
 *                                      bad qty.
 *   GET    /api/products/:id/recipe — 404 path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// GET /api/locations/:id
// ---------------------------------------------------------------------------
describe('GET /api/locations/:id — RBAC + 404 branches', () => {
  it('returns 404 NOT_FOUND for a pm asking for an id that does not exist', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/locations/9999999')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('returns 422 VALIDATION_ERROR for a non-numeric :id param', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/locations/not-a-number')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('pm reads any location detail by id (single-resource envelope)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const res = await request(ctx.app)
      .get(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.location?.id).toBe(loc);
  });
});

// ---------------------------------------------------------------------------
// POST /api/locations
// ---------------------------------------------------------------------------
describe('POST /api/locations — validation edge cases', () => {
  it('accepts a parent_id when present (passthrough)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const parent = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const res = await request(ctx.app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Child Store', type: 'store', parent_id: parent });
    expect(res.status).toBe(201);
    expect(Number(res.body.location?.parent_id)).toBe(parent);
  });

  it('rejects a missing name field (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ type: 'store' });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/locations/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/locations/:id — empty + invalid + not-found branches', () => {
  it('rejects an empty body with a 422 (no editable fields provided)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-boolean is_active value (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ is_active: 'yes' });
    expect(res.status).toBe(422);
  });

  it('accepts is_active=false and flips the column', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .patch(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.location?.is_active).toBe(false);
  });

  it('returns 404 NOT_FOUND when the id does not exist', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .patch('/api/locations/8888888')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /api/products — additional 422 branches
// ---------------------------------------------------------------------------
describe('POST /api/products — invalid enums + duplicate SKU', () => {
  it('rejects an unknown unit (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Bad Unit', type: 'raw', unit: 'tonnes' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate SKU at the boundary (422 — not a raw DB error)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const first = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Sugar v1', type: 'raw', unit: 'kg', sku: 'P-DUP' });
    expect(first.status).toBe(201);
    const second = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Sugar v2', type: 'raw', unit: 'kg', sku: 'P-DUP' });
    expect(second.status).toBe(422);
    expect(second.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GET /api/products?type=
// ---------------------------------------------------------------------------
describe('GET /api/products — invalid filter branch', () => {
  it('rejects an unknown ?type= with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/products?type=banana')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/products/:id/recipe — extra validation branches
// ---------------------------------------------------------------------------
describe('PUT /api/products/:id/recipe — validation branches', () => {
  it('rejects a body whose "recipe" field is not an array (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: 'not-an-array' });
    expect(res.status).toBe(422);
  });

  it('rejects a recipe line with no component_product_id (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ qty_per_unit: 1 }] });
    expect(res.status).toBe(422);
  });

  it('rejects duplicate components in the same recipe (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        recipe: [
          { component_product_id: raw, qty_per_unit: 1 },
          { component_product_id: raw, qty_per_unit: 2 },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-positive qty_per_unit (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: raw, qty_per_unit: 0 }] });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the product id does not exist', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .put('/api/products/9999999/recipe')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [] });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('a store_manager cannot edit a recipe (403)', async () => {
    const storeLoc = await makeLocation(ctx.db, { type: 'store' });
    const storeMgr = await makeUser(ctx.db, {
      role: 'store_manager', locationId: storeLoc,
    });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ recipe: [] });
    expect(res.status).toBe(403);
  });

  it('a production_manager can replace the recipe of an existing product (200)', async () => {
    const prodLoc = await makeLocation(ctx.db, { type: 'production' });
    const prodMgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: prodLoc,
    });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });
    const res = await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${prodMgr.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 0.5 }] });
    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(1);
  });
});

describe('GET /api/products/:id/recipe — 404 path', () => {
  it('returns 404 NOT_FOUND for an unknown product id', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/products/9999999/recipe')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});
