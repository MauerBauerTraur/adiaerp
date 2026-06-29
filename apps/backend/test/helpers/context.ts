/**
 * `createTestContext` — one call that prepares everything an integration
 * test suite needs:
 *
 *   1. resolves the test connection string and forces the app's config to
 *      use it (so the app pool and the harness pool hit the same database);
 *   2. creates an isolated schema and applies the migration into it;
 *   3. pins the app's pool `search_path` to that schema;
 *   4. builds the Express app for supertest.
 *
 * `dispose()` tears the schema down and closes both pools. Suites call
 * `createTestContext()` in `beforeAll` and `ctx.dispose()` in `afterAll`.
 */
import type { Express } from 'express';
import { setupTestSchema, teardownTestSchema, type TestDb } from './testDb.js';

export type TestContext = {
  readonly app: Express;
  readonly db: TestDb;
  dispose(): Promise<void>;
};

export async function createTestContext(): Promise<TestContext> {
  // The harness picks TEST_DATABASE_URL, else a host database the dev role
  // can CREATE schemas in (adia_erp_dev is not provisioned yet).
  const connectionString =
    process.env.TEST_DATABASE_URL ?? 'postgres:///personal_ai?host=/var/run/postgresql';

  // Force the app's config + pool onto the same database BEFORE anything
  // imports the db layer's pool.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = connectionString;

  // Fresh config (a previous suite may have cached a different value).
  const { resetConfigCache } = await import('../../src/config/index.js');
  resetConfigCache();

  // Create the isolated schema + migrate into it.
  const db = await setupTestSchema();

  // Pin the app pool to that schema, then (re)create it.
  const { setSearchPathSchema, closePool } = await import('../../src/db/index.js');
  await closePool(); // drop any pool a previous suite created.
  setSearchPathSchema(db.schema);

  const { createApp } = await import('../../src/app.js');
  const app = createApp();

  return {
    app,
    db,
    dispose: async () => {
      await closePool();
      setSearchPathSchema(undefined);
      await teardownTestSchema(db);
    },
  };
}
