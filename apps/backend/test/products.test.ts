/**
 * M2 — Products & Recipes integration tests (spec section 4.3).
 *
 * Covers: product create/list with RBAC, the BOM full-replace endpoint, and
 * AC2.2 — a BOM must not create a cycle (direct self-reference or a deep
 * A -> B -> A loop).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeProduct, makeLocation } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('products', () => {
  it('pm can create a product and filter the list by type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const created = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Flour', type: 'raw', unit: 'kg', sku: 'P-FLOUR' });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ name: 'Flour', type: 'raw' });

    await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Cake', type: 'finished', unit: 'pcs', sku: 'P-CAKE' });

    const rawOnly = await request(ctx.app)
      .get('/api/products?type=raw')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(rawOnly.status).toBe(200);
    expect(Array.isArray(rawOnly.body)).toBe(true);
    expect((rawOnly.body as { type: string }[]).every((p) => p.type === 'raw')).toBe(true);
  });

  it('EPIC 1.2 — ?search= matches translit (Latin query finds Cyrillic name)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const sku = `SRCH-${Math.random().toString(36).slice(2, 8)}`;
    await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Шоколад тёмный', type: 'raw', unit: 'kg', sku });

    const latin = await request(ctx.app)
      .get('/api/products?search=shokolad')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(latin.status).toBe(200);
    expect(
      (latin.body as { name: string }[]).some((p) => p.name === 'Шоколад тёмный'),
    ).toBe(true);

    // A non-matching query excludes it.
    const miss = await request(ctx.app)
      .get('/api/products?search=napoleon')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(
      (miss.body as { name: string }[]).some((p) => p.name === 'Шоколад тёмный'),
    ).toBe(false);
  });

  it('EPIC 1.3 — list rows carry smart category + effective_type', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const created = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ name: 'Г/П Торт Медовик', type: 'semi', unit: 'pcs' });
    expect(created.status).toBe(201);
    // Even on create the smart fields are present.
    expect(created.body.product.category).toBe('cake');
    expect(created.body.product.effective_type).toBe('finished');

    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    const row = (list.body as { name: string; category: string; effective_type: string }[]).find(
      (p) => p.name === 'Г/П Торт Медовик',
    );
    expect(row).toBeDefined();
    expect(row?.category).toBe('cake');
    expect(row?.effective_type).toBe('finished');
  });

  it('a store manager cannot create a product (403)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db),
    });
    const res = await request(ctx.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ name: 'X', type: 'raw', unit: 'kg' });
    expect(res.status).toBe(403);
  });
});

describe('recipes / BOM', () => {
  it('PUT replaces the BOM with valid components', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });
    const sugar = await makeProduct(ctx.db, { type: 'raw' });

    const res = await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        recipe: [
          { component_product_id: flour, qty_per_unit: 0.5 },
          { component_product_id: sugar, qty_per_unit: 0.25 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(2);

    // A second PUT fully replaces (not appends).
    const replaced = await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 1 }] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.recipe).toHaveLength(1);
  });

  it('AC2.2 — rejects a direct self-reference (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: product, qty_per_unit: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('AC2.2 — rejects a deep cycle A -> B -> A (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeProduct(ctx.db, { type: 'semi' });
    const b = await makeProduct(ctx.db, { type: 'semi' });

    // B's BOM contains A.
    const setB = await request(ctx.app)
      .put(`/api/products/${b}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: a, qty_per_unit: 1 }] });
    expect(setB.status).toBe(200);

    // Now A's BOM contains B -> would close the cycle A -> B -> A.
    const setA = await request(ctx.app)
      .put(`/api/products/${a}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: b, qty_per_unit: 1 }] });
    expect(setA.status).toBe(422);
    expect(setA.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a recipe with a non-existent component (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .put(`/api/products/${product}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: 999999, qty_per_unit: 1 }] });
    expect(res.status).toBe(422);
  });

  it('GET recipe returns the stored BOM', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw' });
    await request(ctx.app)
      .put(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ recipe: [{ component_product_id: flour, qty_per_unit: 2 }] });

    const res = await request(ctx.app)
      .get(`/api/products/${cake}/recipe`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(1);
    expect(Number(res.body.recipe[0].component_product_id)).toBe(flour);
  });
});
