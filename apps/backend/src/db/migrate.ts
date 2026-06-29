/**
 * Minimal SQL migration runner.
 *
 * Migrations are plain `.sql` files in `apps/backend/migrations/`, named
 * `NNNN_description.sql` (e.g. `0001_init.sql`). They apply in lexical
 * (numeric) order. A `schema_migrations` table records which files have
 * already run, so re-running is a no-op for applied migrations.
 *
 * The runner wraps each migration file in a single transaction (`BEGIN` /
 * `COMMIT`) and records it in `schema_migrations` inside that SAME
 * transaction. Schema changes and the bookkeeping INSERT therefore commit
 * atomically — all or nothing. Migration `.sql` files MUST NOT contain
 * their own `BEGIN;` / `COMMIT;` (that would close the runner's
 * transaction early and leave the bookkeeping INSERT outside it).
 *
 * Usage:  npm run migrate            (from apps/backend)
 *         tsx src/db/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION_FILE_RE = /^\d{4}_[\w-]+\.sql$/;

/** Ensure the bookkeeping table exists. */
async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/** Names of migrations already applied. */
async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await getPool().query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.filename));
}

/** All migration files on disk, sorted in apply order. */
async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => MIGRATION_FILE_RE.test(f)).sort((a, b) => a.localeCompare(b));
}

/** Run all pending migrations. Returns the list of files applied this run. */
export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const done = await appliedMigrations();
  const files = await migrationFiles();
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await getPool().connect();
    try {
      // The runner owns the transaction: schema + bookkeeping commit together.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`[migrate] FAILED on ${file}: ${(err as Error).message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  if (applied.length === 0) {
    console.log('[migrate] nothing to apply — schema is up to date.');
  } else {
    console.log(`[migrate] done — ${applied.length} migration(s) applied.`);
  }
  return applied;
}

// Run directly when invoked as a script (`tsx src/db/migrate.ts`).
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('migrate.ts');
if (invokedDirectly) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[migrate] migration run aborted.');
      console.error(err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
