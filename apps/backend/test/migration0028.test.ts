/**
 * ADR-0017 — migration 0028 (Poster storage classification) idempotency +
 * correctness.
 *
 * The runner already applied 0028 against this suite's schema at setup, so we
 * cannot observe it on a clean slate there. Instead this test re-applies the
 * SQL file against a hand-rolled pre-0028 fixture (the buggy state where every
 * storage was `central_warehouse` and store-backing storages were standalone
 * rows), then re-runs it to prove idempotency.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, type TestContext } from './helpers/context.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(HERE, '../migrations/0028_poster_storage_classification.sql');

let ctx: TestContext;
let sql: string;

beforeAll(async () => {
  ctx = await createTestContext();
  sql = await readFile(SQL_PATH, 'utf8');
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * Recreate the pre-0028 buggy state:
 *   - 3 POS spot rows (Кукча/Рабочий/Чигатай) with no storage id;
 *   - 3 store-backing storage-only rows (3/4/5), all `central_warehouse`;
 *   - the singletons (2/8/20) all wrongly `central_warehouse`;
 *   - a handful of product storages all wrongly `central_warehouse`.
 */
async function seedBuggyState(): Promise<void> {
  await ctx.db.query('DELETE FROM location_flows');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES
       ('Кукча',   'store', 1),
       ('Рабочий', 'store', 2),
       ('Чигатай', 'store', 3)`,
  );
  await ctx.db.query(
    `INSERT INTO locations (name, type, poster_storage_id) VALUES
       ('Склад Кукча',          'central_warehouse', 3),
       ('Склад Рабочий',        'central_warehouse', 4),
       ('Склад Чигатай',        'central_warehouse', 5),
       ('Основной склад',       'central_warehouse', 2),
       ('Склад Центральный',    'central_warehouse', 8),
       ('Производственный Цех', 'central_warehouse', 20),
       ('Склад Тортов',         'central_warehouse', 19),
       ('Склад Эклеров',        'central_warehouse', 34)`,
  );
}

describe('Migration 0028 — Poster storage classification', () => {
  it('classifies the singletons and merges store-backing storages into spots', async () => {
    await seedBuggyState();
    await ctx.db.query(sql);

    const { rows } = await ctx.db.query<{
      type: string;
      poster_spot_id: number | null;
      poster_storage_id: number | null;
      is_active: boolean;
    }>(
      `SELECT type, poster_spot_id, poster_storage_id, is_active
         FROM locations ORDER BY poster_spot_id NULLS LAST, poster_storage_id`,
    );

    // Singletons reclassified.
    expect(rows.find((r) => r.poster_storage_id === 2)?.type).toBe('raw_warehouse');
    expect(rows.find((r) => r.poster_storage_id === 8)?.type).toBe('central_warehouse');
    expect(rows.find((r) => r.poster_storage_id === 20)?.type).toBe('production');
    // Product storages -> sex_storage.
    expect(rows.find((r) => r.poster_storage_id === 19)?.type).toBe('sex_storage');
    expect(rows.find((r) => r.poster_storage_id === 34)?.type).toBe('sex_storage');

    // Exactly ONE central_warehouse remains (the dashboard fix).
    expect(rows.filter((r) => r.type === 'central_warehouse' && r.is_active)).toHaveLength(1);

    // Store-backing merged: each spot row now carries its storage id.
    const kukcha = rows.find((r) => r.poster_spot_id === 1);
    expect(kukcha?.type).toBe('store');
    expect(kukcha?.poster_storage_id).toBe(3);
    expect(rows.find((r) => r.poster_spot_id === 2)?.poster_storage_id).toBe(4);
    expect(rows.find((r) => r.poster_spot_id === 3)?.poster_storage_id).toBe(5);

    // The standalone storage-only rows were deactivated, not deleted, and
    // released their UNIQUE key (poster_storage_id -> NULL).
    const deactivated = rows.filter((r) => !r.is_active);
    expect(deactivated).toHaveLength(3);
    expect(deactivated.every((r) => r.poster_storage_id === null)).toBe(true);
    expect(deactivated.every((r) => r.poster_spot_id === null)).toBe(true);
  });

  it('seeds forward flows from every active sex_storage to the central warehouse', async () => {
    // Re-uses the post-migration state from the previous test.
    const { rows: central } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM locations WHERE poster_storage_id = 8 AND type = 'central_warehouse'`,
    );
    const centralId = Number(central[0]?.id);
    const { rows: flows } = await ctx.db.query<{ from_location_id: number; to_location_id: number }>(
      `SELECT from_location_id, to_location_id FROM location_flows WHERE flow_type = 'forward'`,
    );
    // Two active sex_storages (19, 34) -> central.
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => Number(f.to_location_id) === centralId)).toBe(true);
  });

  it('is idempotent — a second run produces identical rows and no new flows', async () => {
    const before = await ctx.db.query<{
      id: string;
      type: string;
      poster_storage_id: number | null;
      is_active: boolean;
      name: string;
    }>(
      `SELECT id, type, poster_storage_id, is_active, name
         FROM locations ORDER BY id`,
    );
    const flowsBefore = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM location_flows`,
    );

    await ctx.db.query(sql);

    const after = await ctx.db.query<{
      id: string;
      type: string;
      poster_storage_id: number | null;
      is_active: boolean;
      name: string;
    }>(
      `SELECT id, type, poster_storage_id, is_active, name
         FROM locations ORDER BY id`,
    );
    const flowsAfter = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM location_flows`,
    );

    expect(after.rows).toEqual(before.rows);
    expect(flowsAfter.rows[0]?.n).toBe(flowsBefore.rows[0]?.n);
  });

  it('is a no-op when no Poster storages are present (greenfield)', async () => {
    await ctx.db.query('DELETE FROM location_flows');
    await ctx.db.query('DELETE FROM locations');
    await ctx.db.query(sql); // must not throw
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM locations`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});
