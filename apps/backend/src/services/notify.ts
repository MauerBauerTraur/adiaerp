/**
 * M9 — Notifications service (spec §2.9 + §7).
 *
 * Inserts one row into `notifications` for every business event that the
 * Telegram outbox worker will later push to users. The insert participates
 * in the SAME transaction as the change it records, so a domain action and
 * its notification commit together — if the action rolls back, no orphan
 * notification is left behind.
 *
 * Idempotency / debounce (§2.9):
 *   - the caller passes a `dedupeKey` and `dedupeWindowMinutes` to suppress
 *     duplicates (e.g. `stock_below_min`: one Telegram per
 *     (product, location) per 24h). The lookup uses the partial index
 *     `ix_notifications_dedupe` added in migration 0002.
 *
 * Audit (invariant 6) is intentionally NOT written by this helper — the
 * notification IS the audit signal for the event, and double-writing
 * `audit_log` for every nudge would flood it. The outer service that
 * triggered the event already writes its own `audit_log` row.
 */
import type { TxClient } from '../db/index.js';

/** The Telegram notification types Faza-1 emits (spec §7). */
export type NotificationType =
  | 'stock_below_min'
  | 'replenishment_created'
  | 'production_order_created'
  | 'production_order_done'
  | 'shipment_created'
  | 'purchase_request_created'
  | 'purchase_request_approved'
  | 'poster_sync_failed'
  | 'negative_stock_detected'
  // EPIC 8.3 — a Poster sale check rang up MORE units than ADIA had on hand
  // ("noto'g'ri urilgan chek"): POS sold N but stock only had M < N. The sale
  // is clamped (invariant 3 — qty never negative) and this alert is raised so
  // an admin/manager can reconcile the discrepancy.
  | 'wrong_keyed_check'
  // EPIC 8.4 — nakladnoy document created (material requisition).
  | 'nakladnoy_created'
  // EPIC 8.5 — cash shift submitted by store manager.
  | 'cash_shift_submitted';

/**
 * Inline keyboard payload persisted into `notifications.inline_callback`
 * (ADR-0011). The outbox worker translates this into Telegram's
 * `reply_markup.inline_keyboard` 2-D array. Each button's `data` must be
 * the `verb:entity:id` form parsed by `callbackHandler.ts` and must stay
 * within Telegram's 64-byte `callback_data` limit.
 *
 * The wrapping object (`{buttons}`) — rather than a bare 2-D array —
 * leaves room to attach metadata (e.g. {expires_at}) later without
 * another column migration.
 */
export type InlineCallbackButton = {
  readonly text: string;
  readonly data: string;
};

export type InlineCallback = {
  readonly buttons: ReadonlyArray<ReadonlyArray<InlineCallbackButton>>;
};

export type NotificationInput = {
  /** Recipient user id. Use `null` ONLY for broadcasts (the worker skips them). */
  readonly recipientUserId: number;
  readonly type: NotificationType;
  /** Short subject line — shows as the first Telegram bold line. */
  readonly title: string;
  /** Plain-text body (no Markdown / HTML — see §9.5). */
  readonly body: string;
  /** Optional structured payload — kept for forensic debugging. */
  readonly payload?: Record<string, unknown> | null;
  /**
   * Optional debounce key. When present, the helper first looks for a
   * matching `dedupe_key` row created within `dedupeWindowMinutes` and,
   * if found, returns that row's id instead of inserting a new one.
   */
  readonly dedupeKey?: string;
  /** Lookback window in minutes for the dedupe check. Default 24h. */
  readonly dedupeWindowMinutes?: number;
  /**
   * Optional Telegram inline keyboard (F3.3 / ADR-0011). When supplied,
   * the outbox worker attaches the buttons under the message; tapping a
   * button sends a `callback_query` the bot handles.
   *
   * Pass `undefined` (or omit) to send a plain message — the legacy
   * Faza-1 behaviour.
   */
  readonly inlineCallback?: InlineCallback | null;
};

export type CreatedNotification = {
  readonly id: number;
  readonly deduped: boolean;
};

/**
 * Insert one `notifications` row. When `dedupeKey` is supplied and a row
 * with the same key exists within the window, returns that row's id and
 * `deduped: true` — no insert is performed.
 */
export async function createNotification(
  tx: TxClient,
  input: NotificationInput,
): Promise<CreatedNotification> {
  const windowMinutes = input.dedupeWindowMinutes ?? 24 * 60;

  if (input.dedupeKey !== undefined && input.dedupeKey !== '') {
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM notifications
        WHERE dedupe_key = $1
          AND created_at > now() - ($2::int || ' minutes')::interval
        ORDER BY id DESC
        LIMIT 1`,
      [input.dedupeKey, windowMinutes],
    );
    const dup = existing.rows[0];
    if (dup !== undefined) {
      return { id: Number(dup.id), deduped: true };
    }
  }

  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO notifications
       (recipient_user_id, type, title, body, payload, dedupe_key, inline_callback)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.recipientUserId,
      input.type,
      input.title,
      input.body,
      input.payload === undefined || input.payload === null
        ? null
        : (JSON.stringify(input.payload) as unknown as string),
      input.dedupeKey ?? null,
      input.inlineCallback === undefined || input.inlineCallback === null
        ? null
        : (JSON.stringify(input.inlineCallback) as unknown as string),
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('Notification insert returned no row.');
  }
  return { id: Number(id), deduped: false };
}

// -----------------------------------------------------------------------------
// Recipient resolution helpers
// -----------------------------------------------------------------------------

/** Active PM user ids — for global notifications (sync failures, etc.). */
export async function getPmRecipients(tx: TxClient): Promise<number[]> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT id FROM users WHERE role = 'pm' AND is_active = TRUE`,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * The manager user assigned to a location (NULL when the seed never set one).
 * `locations.manager_user_id` is the source of truth (D6, CLAUDE.md §6).
 */
export async function getLocationManager(
  tx: TxClient,
  locationId: number,
): Promise<number | null> {
  const { rows } = await tx.query<{ manager_user_id: number | null }>(
    `SELECT manager_user_id FROM locations WHERE id = $1`,
    [locationId],
  );
  const raw = rows[0]?.manager_user_id;
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * All active users for one role. Used to notify "every supply_manager",
 * "every raw_warehouse_manager", and so on (spec §7).
 */
export async function getUsersByRole(tx: TxClient, role: string): Promise<number[]> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT id FROM users WHERE role = $1 AND is_active = TRUE`,
    [role],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Active users that manage any location of the given type — e.g. every
 * raw warehouse manager (via `users.role`, since a location's manager is
 * typically the role-holder). Used when more than one raw warehouse exists.
 */
export async function getManagersForLocationType(
  tx: TxClient,
  type: string,
): Promise<number[]> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN locations l ON l.manager_user_id = u.id
      WHERE l.type = $1 AND u.is_active = TRUE`,
    [type],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Fan-out helper — insert one `notifications` row per recipient.
 * Returns the ids inserted (or matched, when deduped).
 */
export async function createNotificationsForRecipients(
  tx: TxClient,
  recipients: readonly number[],
  base: Omit<NotificationInput, 'recipientUserId'>,
): Promise<CreatedNotification[]> {
  const seen = new Set<number>();
  const out: CreatedNotification[] = [];
  for (const userId of recipients) {
    if (seen.has(userId)) continue; // unique recipients only
    seen.add(userId);
    const result = await createNotification(tx, { ...base, recipientUserId: userId });
    out.push(result);
  }
  return out;
}
