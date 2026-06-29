/**
 * Audit-log helper (invariant 6 — every change is audit-logged: who/when/what).
 *
 * `writeAudit` inserts one `audit_log` row. It accepts a `TxClient` so the
 * audit insert participates in the SAME transaction as the change it records
 * — for a stock movement the decrement, increment, ledger row and audit row
 * commit or roll back together (invariant 1).
 */
import { query as poolQuery, type TxClient } from '../db/index.js';

/**
 * A pool-backed runner with the same `.query()` shape as `TxClient`, so
 * `writeAudit` takes one runner type whether it runs on the pool or inside a
 * transaction. Pass this for a standalone (non-transactional) audit write.
 */
export const poolRunner: TxClient = {
  query: poolQuery,
};

export type AuditEntry = {
  /** The acting user id, or `null` for system/cron actions. */
  readonly actorUserId: number | null;
  /** Dotted action name, e.g. `stock_movement.create`. */
  readonly action: string;
  /** Table / aggregate name, e.g. `stock_movements`. */
  readonly entity: string;
  /** The affected row id, when applicable. */
  readonly entityId: number | null;
  /** Arbitrary JSON detail (the changed values). */
  readonly payload?: unknown;
  /**
   * F4.1 / ADR-0012 — request-scoped active location. Optional: cron and
   * system writes leave this null. Routes pass `principal.activeLocationId`
   * so the audit log records which store the user was acting as.
   */
  readonly activeLocationId?: number | null;
};

/**
 * Insert one audit-log row. Pass a `TxClient` to keep the audit write inside
 * the transaction that performs the change.
 */
export async function writeAudit(runner: TxClient, entry: AuditEntry): Promise<void> {
  await runner.query(
    `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, payload, active_location_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorUserId,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.payload === undefined ? null : (JSON.stringify(entry.payload) as unknown as string),
      entry.activeLocationId ?? null,
    ],
  );
}
