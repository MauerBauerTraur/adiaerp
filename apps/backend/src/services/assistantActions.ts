/**
 * AI assistant — write-action lifecycle service (Faza-3 F3.2, ADR-0009).
 *
 * The assistant.ts service stages `pending` rows in `assistant_actions`
 * when the model proposes a write tool. This module owns the *second*
 * phase: confirming, rejecting, listing, and expiring those rows.
 *
 * Public entrypoints:
 *   * `confirmAction(actionId, principal)` — atomic confirm; runs the
 *     real DB executor when the row was still `pending`; idempotent.
 *   * `rejectAction(actionId, principal)` — atomic reject.
 *   * `listActionsForUser(principal, opts)` — paginated listing scoped
 *     to the caller.
 *   * `expirePendingActions()` — cron sweep that flips overdue pending
 *     rows to `expired`.
 *
 * Invariants:
 *   1. RBAC — only `assistant_actions.user_id === principal.userId` may
 *      confirm/reject/list their own actions (PM is NOT exempt — actions
 *      are personal; PM has their own actions).
 *   2. Idempotency — confirm and reject are atomic via
 *      `UPDATE … WHERE status='pending' RETURNING *`; second calls
 *      return 409 ACTION_NOT_PENDING (no double execution).
 *   3. RBAC re-check at confirm time — the principal's role may have
 *      changed since intent; `canExecute` runs again before mutation.
 *   4. Audit — every confirm/reject writes an `audit_log` row.
 */
import { withTransaction, query, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import { getWriteTool } from '../integrations/vertex/tools/write.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantActionStatus =
  | 'pending'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'superseded';

export type AssistantActionRow = {
  readonly id: number;
  readonly session_id: number;
  readonly user_id: number;
  readonly tool_name: string;
  readonly args: Record<string, unknown>;
  readonly summary: string;
  readonly status: AssistantActionStatus;
  readonly expires_at: string;
  readonly confirmed_at: string | null;
  readonly executed_at: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error_detail: string | null;
  readonly created_at: string;
};

type DbActionRow = {
  id: string;
  session_id: string;
  user_id: string;
  tool_name: string;
  args: unknown;
  summary: string;
  status: AssistantActionStatus;
  expires_at: Date;
  confirmed_at: Date | null;
  executed_at: Date | null;
  result: unknown;
  error_detail: string | null;
  created_at: Date;
};

function shapeRow(row: DbActionRow): AssistantActionRow {
  return {
    id: Number(row.id),
    session_id: Number(row.session_id),
    user_id: Number(row.user_id),
    tool_name: row.tool_name,
    args: (row.args ?? {}) as Record<string, unknown>,
    summary: row.summary,
    status: row.status,
    expires_at: row.expires_at.toISOString(),
    confirmed_at: row.confirmed_at === null ? null : row.confirmed_at.toISOString(),
    executed_at: row.executed_at === null ? null : row.executed_at.toISOString(),
    result: (row.result ?? null) as Record<string, unknown> | null,
    error_detail: row.error_detail,
    created_at: row.created_at.toISOString(),
  };
}

const COLUMNS = `id, session_id, user_id, tool_name, args, summary, status,
  expires_at, confirmed_at, executed_at, result, error_detail, created_at`;

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/**
 * Confirm a pending assistant action. Atomic — the very first `UPDATE …
 * WHERE status='pending'` is the only authoritative gate; a second confirm
 * sees `rowCount === 0` and raises `ACTION_NOT_PENDING`. Expiry is detected
 * inside the same transaction by comparing `expires_at` to `now()`.
 *
 * Flow:
 *   1. SELECT … FOR UPDATE on the row, check RBAC (user_id matches the
 *      caller) and current status.
 *   2. If expired (expires_at < now()), flip to `expired` and raise 410.
 *   3. Re-run `canExecute` with the current principal — role may have
 *      changed since intent.
 *   4. UPDATE … SET status='executed', confirmed_at=now(), executed_at=now().
 *   5. Run the real executor inside the SAME transaction. The DB mutation
 *      and the status flip commit together.
 *   6. Write audit (`assistant_action.execute`).
 *   7. Append a `role='tool'` row to assistant_messages so the chat view
 *      shows "action bajarildi".
 *
 * On executor failure the WHOLE transaction rolls back — the action stays
 * `pending` (because the UPDATE is rolled back too), so the user can retry
 * the confirm. This is safer than the ADR's "status remains executed"
 * compromise: a rolled-back row is the only honest reflection of "nothing
 * happened".
 */
export async function confirmAction(
  actionId: number,
  principal: AuthPrincipal,
): Promise<{ action: AssistantActionRow; appendedMessageId: number | null }> {
  let lazyExpireRequested = false;
  try {
    return await withTransaction(async (tx: TxClient) => {
    const { rows } = await tx.query<DbActionRow>(
      `SELECT ${COLUMNS} FROM assistant_actions WHERE id = $1 FOR UPDATE`,
      [actionId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Assistant action not found.');
    }
    if (Number(row.user_id) !== principal.userId) {
      throw AppError.forbidden('You may only confirm your own assistant actions.');
    }
    if (row.status !== 'pending') {
      throw new AppError(
        'ACTION_NOT_PENDING',
        `Action ${actionId} is in status "${row.status}".`,
      );
    }
    if (row.expires_at.getTime() <= Date.now()) {
      // Lazy expire — we cannot commit the expire flip inside this same
      // transaction because the AppError below rolls it back. Stash the
      // expiry intent so it is applied outside the failing transaction.
      lazyExpireRequested = true;
      throw new AppError(
        'ACTION_EXPIRED',
        `Action ${actionId} expired at ${row.expires_at.toISOString()}.`,
      );
    }

    const tool = getWriteTool(row.tool_name);
    if (tool === undefined) {
      throw AppError.internal(`Unknown write tool "${row.tool_name}" on action ${actionId}.`);
    }
    // Validate stored args again (defence in depth — the DB row's JSONB is
    // trusted but the executor expects a typed shape).
    const args = tool.validateArgs((row.args ?? {}) as Record<string, unknown>);

    // RBAC re-check at execute time (ADR-0009 §3).
    const decision = await tool.canExecute(args, principal, tx);
    if (decision !== 'allowed') {
      throw new AppError(
        'FORBIDDEN',
        `Action ${actionId} denied by canExecute: ${decision.code} — ${decision.reason}`,
      );
    }

    // Atomic gate — only one caller flips pending→executed.
    const { rowCount } = await tx.query(
      `UPDATE assistant_actions
          SET status = 'executed',
              confirmed_at = now(),
              executed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [actionId],
    );
    if (rowCount === 0) {
      // Concurrent confirm beat us to it (or expired between SELECT and
      // UPDATE in another tx) — keep the contract clean.
      throw new AppError(
        'ACTION_NOT_PENDING',
        `Action ${actionId} is no longer pending.`,
      );
    }

    // Real executor — inside the same transaction. Any throw rolls the
    // status flip back, leaving the action `pending` for a retry.
    const result = await tool.execute(args, principal, principal.userId, tx);

    await tx.query(
      `UPDATE assistant_actions SET result = $2 WHERE id = $1`,
      [actionId, JSON.stringify(result)],
    );

    await writeAudit(tx, {
      actorUserId: principal.userId,
      action: 'assistant_action.execute',
      entity: 'assistant_action',
      entityId: actionId,
      payload: {
        tool: row.tool_name,
        args,
        result,
        session_id: Number(row.session_id),
      },
    });

    // Append a `role='tool'` row to the assistant chat so the UI sees
    // "Bajarildi" inline with the user/assistant turns.
    const sessionId = Number(row.session_id);
    const { rows: appended } = await tx.query<{ id: string }>(
      `INSERT INTO assistant_messages
         (session_id, role, content, tool_name, tool_payload, tool_result)
       VALUES ($1, 'tool', $2, $3, $4, $5)
       RETURNING id`,
      [
        sessionId,
        `${row.tool_name} executed`,
        row.tool_name,
        JSON.stringify(args),
        JSON.stringify(result),
      ],
    );

    // Re-fetch the row in its final shape (status='executed', result, etc.).
    const { rows: finalRows } = await tx.query<DbActionRow>(
      `SELECT ${COLUMNS} FROM assistant_actions WHERE id = $1`,
      [actionId],
    );
    const finalRow = finalRows[0];
    if (finalRow === undefined) {
      throw AppError.internal('assistant_action vanished after update.');
    }

    return {
      action: shapeRow(finalRow),
      appendedMessageId: appended[0]?.id === undefined ? null : Number(appended[0].id),
    };
    });
  } finally {
    // Apply the lazy-expire flip OUTSIDE the failing transaction, so the
    // row's status is durably 'expired' even though the confirm call itself
    // raised ACTION_EXPIRED (the original tx was rolled back).
    if (lazyExpireRequested) {
      try {
        await withTransaction(async (tx) => {
          await tx.query(
            `UPDATE assistant_actions
                SET status = 'expired'
              WHERE id = $1 AND status = 'pending'`,
            [actionId],
          );
          await writeAudit(tx, {
            actorUserId: principal.userId,
            action: 'assistant_action.expire',
            entity: 'assistant_action',
            entityId: actionId,
            payload: { source: 'lazy_confirm' },
          });
        });
      } catch (err) {
        // The expire sweep cron will pick it up on the next pass — log and
        // swallow to avoid masking the original 410 ACTION_EXPIRED error.
        console.error(
          '[assistant-action] lazy expire post-commit failed:',
          (err as Error).message,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

export async function rejectAction(
  actionId: number,
  principal: AuthPrincipal,
): Promise<AssistantActionRow> {
  return withTransaction(async (tx: TxClient) => {
    const { rows } = await tx.query<DbActionRow>(
      `SELECT ${COLUMNS} FROM assistant_actions WHERE id = $1 FOR UPDATE`,
      [actionId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Assistant action not found.');
    }
    if (Number(row.user_id) !== principal.userId) {
      throw AppError.forbidden('You may only reject your own assistant actions.');
    }
    if (row.status !== 'pending') {
      throw new AppError(
        'ACTION_NOT_PENDING',
        `Action ${actionId} is in status "${row.status}".`,
      );
    }
    const { rowCount, rows: updated } = await tx.query<DbActionRow>(
      `UPDATE assistant_actions
          SET status = 'rejected', confirmed_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${COLUMNS}`,
      [actionId],
    );
    if (rowCount === 0 || updated[0] === undefined) {
      throw new AppError(
        'ACTION_NOT_PENDING',
        `Action ${actionId} is no longer pending.`,
      );
    }
    await writeAudit(tx, {
      actorUserId: principal.userId,
      action: 'assistant_action.reject',
      entity: 'assistant_action',
      entityId: actionId,
      payload: { tool: row.tool_name, session_id: Number(row.session_id) },
    });
    return shapeRow(updated[0]);
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type ListActionsOpts = {
  readonly sessionId?: number;
  readonly status?: AssistantActionStatus;
  readonly limit: number;
  readonly offset: number;
};

export async function listActionsForUser(
  principal: AuthPrincipal,
  opts: ListActionsOpts,
): Promise<{ items: AssistantActionRow[]; total: number }> {
  const conditions: string[] = ['user_id = $1'];
  const params: (string | number)[] = [principal.userId];
  if (opts.sessionId !== undefined) {
    params.push(opts.sessionId);
    conditions.push(`session_id = $${params.length}`);
  }
  if (opts.status !== undefined) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const pageParams = [...params, opts.limit, opts.offset];

  const [pageRes, totalRes] = await Promise.all([
    query<DbActionRow>(
      `SELECT ${COLUMNS} FROM assistant_actions
         ${where}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    ),
    query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM assistant_actions ${where}`,
      params,
    ),
  ]);

  return {
    items: pageRes.rows.map(shapeRow),
    total: Number(totalRes.rows[0]?.cnt ?? '0'),
  };
}

// ---------------------------------------------------------------------------
// Expire (cron entry-point)
// ---------------------------------------------------------------------------

/**
 * Sweep — flip every `pending` row whose `expires_at` is in the past to
 * `expired`. One bulk UPDATE per call, no row-by-row locking required.
 * Returns the number of rows flipped (for logging).
 *
 * Called by `workers/actionExpireCron.ts` every minute. Safe to call
 * concurrently — the WHERE clause guarantees idempotency.
 */
export async function expirePendingActions(): Promise<{ expired: number }> {
  const { rowCount } = await query(
    `UPDATE assistant_actions
        SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()`,
  );
  return { expired: rowCount ?? 0 };
}
