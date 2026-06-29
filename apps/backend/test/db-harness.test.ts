/**
 * Sanity check for the integration-test harness itself: an isolated schema is
 * created, the migration applies into it, and basic DML works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestSchema, teardownTestSchema, type TestDb } from './helpers/testDb.js';

let db: TestDb;

beforeAll(async () => {
  db = await setupTestSchema();
});

afterAll(async () => {
  await teardownTestSchema(db);
});

describe('test schema harness', () => {
  it('applies the migration into an isolated schema', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [db.schema],
    );
    // The migration creates well over a dozen tables.
    expect(rows[0]?.n ?? 0).toBeGreaterThan(10);
  });

  it('supports basic DML in the schema', async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO locations (name, type) VALUES ('Harness', 'store') RETURNING id`,
    );
    expect(Number(ins.rows[0]?.id)).toBeGreaterThan(0);
  });
});
