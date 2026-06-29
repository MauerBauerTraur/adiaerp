/**
 * EPIC 8.4 — nakladnoy HTTP route tests.
 *
 *   - POST generates a sectioned document for the operator's own location;
 *   - GET /:id returns header + lines, scoped to the operator's location;
 *   - PM (read-only) is blocked from POST (write) but may read;
 *   - a foreign-location operator is 403 on read of someone else's doc.
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

async function recipe(p: number, c: number, q: number, stage: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, $4::recipe_stage)`,
    [p, c, q, stage],
  );
}

describe('POST /api/nakladnoy', () => {
  it('generates a sectioned nakladnoy for the operator location', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const op = await makeUser(ctx.db, { role: 'production_manager', locationId: loc });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un-r' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort-r' });
    await recipe(cake, flour, 0.5, 'base');

    const res = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${op.token}`)
      .send({ product_id: cake, qty: 4, location_id: loc, source: 'sale' });

    expect(res.status).toBe(201);
    expect(res.body.header.qty).toBe(4);
    expect(res.body.header.source).toBe('sale');
    const hamir = res.body.lines.find(
      (l: { section: string; component_product_id: number }) =>
        l.section === 'hamir' && l.component_product_id === flour,
    );
    expect(hamir.qty).toBe(2);
  });

  it('blocks PM from generating (write = read-and-recommend)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const cake = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: cake, qty: 1, location_id: loc });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/nakladnoy/:id', () => {
  it('forbids reading another location nakladnoy', async () => {
    const locA = await makeLocation(ctx.db, { type: 'production' });
    const locB = await makeLocation(ctx.db, { type: 'production' });
    const opA = await makeUser(ctx.db, { role: 'production_manager', locationId: locA });
    const opB = await makeUser(ctx.db, { role: 'production_manager', locationId: locB });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await recipe(cake, flour, 1, 'base');

    const created = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${opA.token}`)
      .send({ product_id: cake, qty: 1, location_id: locA });
    expect(created.status).toBe(201);
    const id = created.body.header.id;

    const own = await request(ctx.app)
      .get(`/api/nakladnoy/${id}`)
      .set('Authorization', `Bearer ${opA.token}`);
    expect(own.status).toBe(200);

    const foreign = await request(ctx.app)
      .get(`/api/nakladnoy/${id}`)
      .set('Authorization', `Bearer ${opB.token}`);
    expect(foreign.status).toBe(403);
  });

  it('serializes into the frontend Nakladnoy contract (sections + totals)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production', name: 'Sex C' });
    const op = await makeUser(ctx.db, { role: 'production_manager', locationId: loc });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un-c' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar-c' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort-c' });
    // base (hamir) uses flour; decoration (krem) uses sugar.
    await recipe(cake, flour, 0.5, 'base');
    await recipe(cake, sugar, 0.2, 'decoration');

    const created = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${op.token}`)
      .send({ product_id: cake, qty: 10, location_id: loc, source: 'sale' });
    expect(created.status).toBe(201);
    const id = created.body.header.id;

    // GET /:id — DTO shape.
    const detail = await request(ctx.app)
      .get(`/api/nakladnoy/${id}`)
      .set('Authorization', `Bearer ${op.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(id);
    expect(detail.body.product_name).toBe('Tort-c');
    expect(detail.body.order_qty).toBe(10);
    expect(detail.body.store_name).toBe('Sex C');
    const stages = detail.body.sections.map((s: { stage: string }) => s.stage);
    expect(stages).toContain('dough');
    expect(stages).toContain('cream');
    const dough = detail.body.sections.find((s: { stage: string }) => s.stage === 'dough');
    expect(dough.lines[0].qty).toBe(5); // 0.5 * 10
    expect(Array.isArray(detail.body.totals)).toBe(true);
    expect(detail.body.totals.length).toBeGreaterThan(0);

    // GET / list — envelope { items: [...] } with the same per-item shape.
    const list = await request(ctx.app)
      .get('/api/nakladnoy?limit=200')
      .set('Authorization', `Bearer ${op.token}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    const mine = list.body.items.find((n: { id: number }) => n.id === id);
    expect(mine).toBeDefined();
    expect(mine.sections.length).toBeGreaterThan(0);
    expect(mine.totals.length).toBeGreaterThan(0);
  });
});
