/**
 * Import warnings (Phase-2 F2.3 — `import_warnings` table, ADR-0007 §7).
 *
 * A thin write helper for every place in the codebase that detects an
 * import-side anomaly (Poster sync per-item failure, BOM mismatch, dynamic
 * recalc skip / would-zero guard, ...). The PM dashboard reads from the
 * `import_warnings` table via `GET /api/admin/import-warnings`.
 *
 * `severity` is one of `info` / `warning` / `error` (DB CHECK constraint).
 * `info`    — expected anomaly, no action ("no sales history yet");
 * `warning` — anomaly that should be inspected ("would zero out min/max");
 * `error`   — anomaly that blocked work ("Poster API 503 on stock sync").
 *
 * Every helper accepts an optional `TxClient` so the warning insert can
 * share the transaction of the operation that detected it (rollback-safe).
 */
import { query as poolQuery, type TxClient } from '../db/index.js';

export type ImportWarningSeverity = 'info' | 'warning' | 'error';

export type ImportWarningInput = {
  readonly source: string;
  readonly entity?: string | null;
  readonly severity?: ImportWarningSeverity;
  readonly message: string;
  readonly payload?: unknown;
};

/** Insert one `import_warnings` row. `tx` is optional. */
export async function recordImportWarning(
  input: ImportWarningInput,
  tx?: TxClient,
): Promise<void> {
  const runner: TxClient['query'] = tx === undefined ? poolQuery : tx.query.bind(tx);
  await runner(
    `INSERT INTO import_warnings (source, entity, severity, message, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.source,
      input.entity ?? null,
      input.severity ?? 'warning',
      input.message,
      input.payload === undefined ? null : (JSON.stringify(input.payload) as unknown as string),
    ],
  );
}
