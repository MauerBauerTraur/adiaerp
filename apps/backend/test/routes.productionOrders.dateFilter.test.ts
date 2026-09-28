/**
 * GET /api/production-orders?from_date=&to_date= — orders are dated by the
 * Tashkent day they were given, so an order made after local midnight but
 * before 05:00 (still the previous day in UTC) lands on its own day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;
let pmToken: string;
let lateNight: number;
let morning: number;
let dayBefore: number;

beforeAll(async () => {
  ctx = await createTestContext();
  const sex = await makeLocation(ctx.db, { name: 'Оформления отдел', type: 'production' });
  const cake = await makeProduct(ctx.db, { name: 'Г/П СНИКЕРС', type: 'finished', unit: 'pcs' });
  pmToken = (await makeUser(ctx.db, { role: 'pm', locationId: null })).token;

  const insert = async (createdAt: string): Promise<number> => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, status, created_at)
       VALUES ($1, 4, $2, 'new', $3) RETURNING id`,
      [cake, sex, createdAt],
    );
    return Number(rows[0]!.id);
  };
  lateNight = await insert('2026-09-27T19:43:00Z'); // 28 Sep 00:43 Tashkent
  morning = await insert('2026-09-28T05:00:00Z'); // 28 Sep 10:00 Tashkent
  dayBefore = await insert('2026-09-27T10:00:00Z'); // 27 Sep 15:00 Tashkent
});

afterAll(async () => {
  await ctx.dispose();
});

async function list(query: string): Promise<request.Response> {
  return request(ctx.app)
    .get(`/api/production-orders?${query}`)
    .set('Authorization', `Bearer ${pmToken}`);
}

describe('GET /api/production-orders date filter', () => {
  it('dates an order by the Tashkent day it was given', async () => {
    const res = await list('from_date=2026-09-28&to_date=2026-09-28');
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((o) => Number(o.id)).sort((a, b) => a - b);
    expect(ids).toEqual([lateNight, morning].sort((a, b) => a - b));
  });

  it('keeps the previous day separate', async () => {
    const res = await list('from_date=2026-09-27&to_date=2026-09-27');
    expect((res.body as { id: number }[]).map((o) => Number(o.id))).toEqual([dayBefore]);
  });

  it('rejects a reversed range', async () => {
    const res = await list('from_date=2026-09-28&to_date=2026-09-27');
    expect(res.status).toBe(422);
  });
});
