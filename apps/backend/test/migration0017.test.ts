/**
 * F4.11 Bug-MIN-02 — migration 0017 idempotency + correctness.
 *
 * The migration runner already ran 0017 against this suite's schema as part
 * of setup, so we cannot observe it on its own there. Instead, this test
 * loads the SQL file and re-applies it against a hand-rolled "broken"
 * fixture inside the same schema, which exercises every branch:
 *
 *   1. Production root + three orphan sub-departments -> all three are
 *      adopted (parent_id set to the root).
 *   2. Re-running the SQL is a no-op -> the rows do not change (idempotent).
 *   3. With no production root present, the SQL is a no-op -> orphan rows
 *      stay orphan (safe in fresh test databases).
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, type TestContext } from './helpers/context.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(
  HERE,
  '../migrations/0017_fix_production_subdept_parent.sql',
);

let ctx: TestContext;
let sql: string;

beforeAll(async () => {
  ctx = await createTestContext();
  sql = await readFile(SQL_PATH, 'utf8');
});

afterAll(async () => {
  await ctx.dispose();
});

async function freshFixture(): Promise<void> {
  // Wipe locations that the test cares about. Other rows from earlier tests
  // (if any) are ignored — we only check the rows we insert below.
  await ctx.db.query(
    `DELETE FROM locations
      WHERE name IN ('Ishlab chiqarish sexi','Tort sexi','Perojniy sexi','Yarim Fabrika sexi')`,
  );
}

describe('Migration 0017 — production sub-department parent fix', () => {
  it('adopts orphan sub-departments under the production root', async () => {
    await freshFixture();
    const { rows: rootRows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type, parent_id)
       VALUES ('Ishlab chiqarish sexi','production', NULL)
       RETURNING id`,
    );
    const rootId = Number(rootRows[0]?.id);
    await ctx.db.query(
      `INSERT INTO locations (name, type, parent_id) VALUES
         ('Tort sexi','production', NULL),
         ('Perojniy sexi','production', NULL),
         ('Yarim Fabrika sexi','production', NULL)`,
    );

    await ctx.db.query(sql);

    const { rows } = await ctx.db.query<{ name: string; parent_id: string | null }>(
      `SELECT name, parent_id FROM locations
        WHERE name IN ('Tort sexi','Perojniy sexi','Yarim Fabrika sexi')
        ORDER BY name`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(Number(r.parent_id)).toBe(rootId);
    }
  });

  it('is idempotent — re-applying does not change parent_id', async () => {
    // Re-use the state left by the previous test (parents already set).
    const before = await ctx.db.query<{ name: string; parent_id: string | null }>(
      `SELECT name, parent_id FROM locations
        WHERE name IN ('Tort sexi','Perojniy sexi','Yarim Fabrika sexi')
        ORDER BY name`,
    );
    await ctx.db.query(sql);
    const after = await ctx.db.query<{ name: string; parent_id: string | null }>(
      `SELECT name, parent_id FROM locations
        WHERE name IN ('Tort sexi','Perojniy sexi','Yarim Fabrika sexi')
        ORDER BY name`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('is a no-op when the production root is absent', async () => {
    await freshFixture();
    await ctx.db.query(
      `INSERT INTO locations (name, type, parent_id) VALUES
         ('Tort sexi','production', NULL),
         ('Perojniy sexi','production', NULL),
         ('Yarim Fabrika sexi','production', NULL)`,
    );
    await ctx.db.query(sql);
    const { rows } = await ctx.db.query<{ name: string; parent_id: string | null }>(
      `SELECT name, parent_id FROM locations
        WHERE name IN ('Tort sexi','Perojniy sexi','Yarim Fabrika sexi')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.parent_id).toBeNull();
    }
  });
});
