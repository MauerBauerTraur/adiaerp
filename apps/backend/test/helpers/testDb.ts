/**
 * Integration-test database harness.
 *
 * The dedicated `adia_erp_dev` database is not provisioned yet (the owner
 * still has to grant CREATEDB). To keep integration tests runnable TODAY and
 * isolated from one another, each test suite gets its own PostgreSQL SCHEMA
 * inside whatever database `TEST_DATABASE_URL` (or `DATABASE_URL`) points at:
 *
 *   1. `setupTestSchema()` connects, creates a unique `test_<random>` schema,
 *      sets `search_path` to it, and runs `migrations/0001_init.sql` inside it
 *      — so every type/table lives in that schema only.
 *   2. tests run against that schema via the harness pool.
 *   3. `teardownTestSchema()` drops the schema (CASCADE) and closes the pool.
 *
 * This design is forward-compatible: when `adia_erp_dev` exists, point
 * `TEST_DATABASE_URL` at it and nothing else changes — the per-suite schema
 * keeps suites isolated regardless of the database.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { QueryResultRow } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../../migrations');
const MIGRATION_FILE_RE = /^\d{4}_[\w-]+\.sql$/;

/**
 * Resolve the test connection string. `TEST_DATABASE_URL` wins.
 *
 * The dedicated `adia_erp_dev` database is not provisioned yet (the dev role
 * lacks CREATEDB). The fallback therefore points at a host database where the
 * role *does* hold CREATE — each suite still gets its own isolated schema, so
 * the choice of host database does not affect test behaviour. When
 * `adia_erp_dev` exists, set `TEST_DATABASE_URL` to it and nothing changes.
 */
function testConnectionString(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres:///personal_ai?host=/var/run/postgresql'
  );
}

export type TestDb = {
  /** Run a parameterized query inside the suite's schema. */
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** The schema name this suite owns. */
  readonly schema: string;
  /** The underlying pool (used to wire the app's db layer in tests). */
  readonly pool: Pool;
};

let active: { pool: Pool; schema: string } | undefined;

/**
 * Create a fresh, isolated schema, apply the migration into it, and return a
 * query interface. The pool's every connection pins `search_path` to the
 * schema, so unqualified DDL/DML from the migration and the app land there.
 */
export async function setupTestSchema(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const connectionString = testConnectionString();

  // A bootstrap client (default search_path) creates the schema.
  const bootstrap = new Pool({ connectionString, max: 1 });
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await bootstrap.end();
  }

  // The suite pool pins search_path to the new schema via the libpq `options`
  // parameter — applied at connect time, before any query, no extra round-trip.
  const pool = new Pool({
    connectionString,
    max: 5,
    options: `-c search_path=${schema}`,
  });

  // Apply every migration file inside the schema, in lexical order, each in
  // its own transaction. Mirrors the production runner so suites see the same
  // schema state the deployed API sees.
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => MIGRATION_FILE_RE.test(f)).sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  active = { pool, schema };
  return {
    schema,
    pool,
    query: async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const result = await pool.query<T>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

/** Drop the suite's schema and close its pool. */
export async function teardownTestSchema(db: TestDb): Promise<void> {
  await db.pool.end();
  active = undefined;
  // A fresh client drops the schema (the suite pool is already closed).
  const cleanup = new Pool({ connectionString: testConnectionString(), max: 1 });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}

/** The currently-active test schema, if a suite has set one up. */
export function activeSchema(): string | undefined {
  return active?.schema;
}
