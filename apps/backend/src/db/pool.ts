/**
 * PostgreSQL connection pool — the single shared `pg.Pool` for the process.
 *
 * Raw SQL only (no ORM, TZ section 10). The pool is created lazily on first
 * use so that importing this module never opens a connection (important for
 * tests and tooling).
 */
import { Pool, types } from 'pg';
import type { PoolConfig } from 'pg';
import { loadConfig } from '../config/index.js';

// By default `pg` returns BIGINT (`int8`, OID 20) as a string to avoid losing
// precision beyond 2^53. Every id in this schema is a sequence-generated
// `BIGINT` that will not approach that limit at bakery-ERP scale, so we parse
// `int8` to a JS number — keeping row types (`id: number`) honest and numeric
// comparisons (e.g. the BOM cycle walk) correct. If a counter ever risked
// 2^53, this single line is where that decision is revisited.
types.setTypeParser(20, (value: string) => Number(value));

// pg returns NUMERIC (OID 1700) as a string too — same precision-safety stance.
// In Faza-1 every NUMERIC column is NUMERIC(14,4) or NUMERIC(14,2): the maximum
// absolute value is 9_999_999_999.9999, far below 2^53 (~9.0072e15), so JS
// `number` is exact for every legal value. Parsing to a number here gives the
// rest of the codebase a single contract — `qty`, `qty_needed`, `qty_per_unit`,
// `min_level`, `max_level` are all numbers in row objects. If a future column
// ever needed precision past 2^53 it would have to opt back into the string
// representation explicitly.
types.setTypeParser(1700, (value: string) => parseFloat(value));

let pool: Pool | undefined;

/**
 * Optional schema to pin `search_path` to on every connection.
 *
 * TEST-ONLY: integration tests run inside an isolated schema (see
 * test/helpers/testDb.ts). Setting this before the first `getPool()` call
 * makes the app's queries land in that schema. Production never sets it, so
 * the default `public` search_path applies.
 */
let searchPathSchema: string | undefined;

/** TEST-ONLY — pin the app pool's `search_path` to `schema`. */
export function setSearchPathSchema(schema: string | undefined): void {
  searchPathSchema = schema;
}

/** Get the process-wide connection pool, creating it on first call. */
export function getPool(): Pool {
  if (pool === undefined) {
    const cfg = loadConfig();
    const poolConfig: PoolConfig = {
      connectionString: cfg.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Phase 1 is a single self-hosted VPS — no SSL on the local connection.
      application_name: 'adia-erp-api',
    };
    if (searchPathSchema !== undefined) {
      // TEST-ONLY: pin every connection to the test schema at connect time
      // via a libpq `options` parameter — set before any query runs, with no
      // extra round-trip and no overlapping client.query() call.
      poolConfig.options = `-c search_path=${searchPathSchema}`;
    }
    pool = new Pool(poolConfig);
    pool.on('error', (err) => {
      // An idle client errored — log; the pool removes it automatically.
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/** Close the pool — call on graceful shutdown and after test suites. */
export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
