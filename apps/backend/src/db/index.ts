/**
 * Raw SQL query layer.
 *
 * Two primitives back every database access in the codebase:
 *   - `query()`           — a single parameterized statement on the pool.
 *   - `withTransaction()` — an atomic BEGIN / COMMIT / ROLLBACK unit of work.
 *
 * `withTransaction()` is the foundation of domain invariant 1: every
 * `stock_movement` (source decrement, destination increment, audit-log
 * insert) must succeed or fail as one indivisible unit.
 *
 * SQL injection is prevented by ALWAYS using parameterized queries
 * (`$1, $2, ...`) — never string-concatenate user input into SQL.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from './pool.js';

/** Accepted SQL parameter value types. */
export type SqlParam = string | number | boolean | null | Date | Buffer | readonly SqlParam[];

/**
 * Run a single parameterized query on the shared pool.
 *
 * @param text   SQL with `$1, $2, ...` placeholders.
 * @param params Positional parameter values.
 * @returns The result rows, typed as `T`.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly SqlParam[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await getPool().query<T>(text, params as SqlParam[]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/**
 * A transaction-scoped query interface. The same `query()` signature, but
 * bound to a single client inside an open transaction.
 */
export type TxClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly SqlParam[],
  ): Promise<{ rows: T[]; rowCount: number }>;
};

/**
 * Execute `work` inside a single atomic transaction.
 *
 * The flow is BEGIN -> run `work` -> COMMIT. If `work` throws (or any
 * statement fails), the transaction is rolled back and the error is
 * re-thrown — partial writes are impossible.
 *
 * @example
 *   await withTransaction(async (tx) => {
 *     await tx.query('UPDATE stock SET qty = qty - $1 WHERE ... AND qty >= $1', [n]);
 *     await tx.query('INSERT INTO stock_movements ...');
 *     await tx.query('INSERT INTO audit_log ...');
 *   });
 */
export async function withTransaction<R>(work: (tx: TxClient) => Promise<R>): Promise<R> {
  const client: PoolClient = await getPool().connect();
  const tx: TxClient = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly SqlParam[] = [],
    ) => {
      const result = await client.query<T>(text, params as SqlParam[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };

  try {
    await client.query('BEGIN');
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A failed ROLLBACK means the connection is unusable; log and move on.
      console.error('[db] ROLLBACK failed:', (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight connectivity probe used by the /health endpoint. */
export async function ping(): Promise<boolean> {
  const { rows } = await query<{ ok: number }>('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export { closePool, setSearchPathSchema } from './pool.js';
