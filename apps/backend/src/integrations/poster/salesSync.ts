/**
 * Sales sync — primary path: Poster `transaction.close` webhook;
 *              fallback:     30-minute poll of `dash.getTransactions`.
 *
 * The webhook endpoint inserts the raw event into `poster_webhook_events` and
 * returns 200 within a single round-trip — the actual ingestion happens here,
 * out-of-band, so the webhook can never time out a Poster retry.
 *
 * Idempotency:
 *   - `sales` UNIQUE `(poster_transaction_id, product_id, poster_line_id)` —
 *     a re-played event inserts zero new lines (ON CONFLICT DO NOTHING).
 *   - `stock_movements` partial UNIQUE `(poster_transaction_id, product_id,
 *     from_location_id)` keyed on `reason='sale'` rows — a re-played event
 *     never decrements stock twice.
 *
 * The line product_id is resolved via `products.poster_product_id` (NOT
 * `poster_ingredient_id`) — sales come from the menu side, leftovers come
 * from the storage side. See ADR-0002 §1.
 */
import { query, withTransaction, type TxClient } from '../../db/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  createNotification,
  getLocationManager,
  getPmRecipients,
} from '../../services/notify.js';
import type { PosterClient, PosterTransactionFull } from './client.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
} from './syncLog.js';

export type SalesIngestResult = {
  /** Number of events scanned (== `poster_webhook_events` rows examined). */
  readonly eventsScanned: number;
  /** Events that produced at least one new `sales` line. */
  readonly eventsApplied: number;
  /** New `sales` lines inserted in total. */
  readonly linesInserted: number;
  /** Movements applied (stock decrements). */
  readonly movementsApplied: number;
  /** Events skipped because the store could not be resolved. */
  readonly storeMisses: number;
  /**
   * Lines that raised an exception while being ingested (C7 — Sprint 3 audit).
   * Drives the run-status flip to `partial` when one or more lines failed
   * even though the wrapping fetch / scan loop succeeded.
   */
  readonly failedLines: number;
  /** EPIC 8.3 — chek-level shortfalls detected (sold > on-hand). */
  readonly wrongKeyedLines: number;
};

/** Locate an ADIA store (`type='store'`) by Poster spot_id. */
async function resolveStoreId(posterSpotId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM locations
      WHERE poster_spot_id = $1 AND type = 'store' AND is_active = TRUE`,
    [posterSpotId],
  );
  return rows[0]?.id ?? null;
}

/** Locate an ADIA product by Poster menu product_id (sales side). */
async function resolveSalesProductId(posterProductId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_product_id = $1`,
    [posterProductId],
  );
  return rows[0]?.id ?? null;
}

/** Parse Poster `date_close`. Accepts both ms-unix-string and "YYYY-MM-DD HH:mm:ss". */
function parseCloseDate(raw: string | undefined): Date {
  if (raw === undefined || raw === '') return new Date();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    // Poster gives milliseconds; values smaller than 1e12 are seconds.
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Ingest one full transaction (sale check). Idempotent — re-running with the
 * same payload inserts zero new lines and applies zero new movements.
 */
export async function ingestTransaction(
  tx: PosterTransactionFull,
): Promise<{
  linesInserted: number;
  movementsApplied: number;
  storeFound: boolean;
  failedLines: number;
  /** EPIC 8.3 — lines whose sold qty exceeded on-hand ("noto'g'ri urilgan"). */
  wrongKeyedLines: number;
}> {
  const transactionId = Number(tx.transaction_id);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return { linesInserted: 0, movementsApplied: 0, storeFound: false, failedLines: 0, wrongKeyedLines: 0 };
  }
  const spotId = Number(tx.spot_id);
  const storeId = Number.isInteger(spotId) && spotId > 0 ? await resolveStoreId(spotId) : null;
  if (storeId === null) {
    return { linesInserted: 0, movementsApplied: 0, storeFound: false, failedLines: 0, wrongKeyedLines: 0 };
  }
  const closedAt = parseCloseDate(tx.date_close);
  const lines = Array.isArray(tx.products) ? tx.products : [];

  let linesInserted = 0;
  let movementsApplied = 0;
  // C7 — per-line failure counter. The whole check used to swallow a thrown
  // SQL error silently (only console.error). Now we expose a counter so the
  // sync log can flip to `partial` when any line of any event failed.
  let failedLines = 0;
  // EPIC 8.3 — count chek-level shortfalls (sold > on-hand).
  let wrongKeyedLines = 0;

  // Each line is its own transaction — a single bad line must not abort the
  // whole check (and the UNIQUE indexes give us idempotency line-by-line).
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const posterProductId = Number(line.product_id);
    const num = Number(line.num);
    const price = Number(line.product_price ?? 0);
    if (!Number.isInteger(posterProductId) || posterProductId <= 0) continue;
    if (!Number.isFinite(num) || num <= 0) continue;

    const productId = await resolveSalesProductId(posterProductId);
    if (productId === null) continue; // menu item not yet seeded — skip silently

    // 0-based positional id within the check — Poster does not surface a stable
    // line id, so we synthesise one. Combined with (tx_id, product_id) it makes
    // the `uq_sales_poster_line` UNIQUE work even for two lines of the same
    // product within one check.
    const lineId = i;
    try {
      const result = await withTransaction(async (txc) => {
        const inserted = await txc.query(
          `INSERT INTO sales
             (store_id, product_id, qty, price, sold_at,
              poster_transaction_id, poster_line_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (poster_transaction_id, product_id, poster_line_id) DO NOTHING
           RETURNING id`,
          [storeId, productId, num, price, closedAt, transactionId, lineId],
        );
        // Only decrement stock when the sale row is brand-new — a replay of
        // the same line must NOT double-decrement (the movements partial
        // UNIQUE is a second-line-of-defence below).
        if (inserted.rowCount === 0) return { applied: false };

        // Insert the `sale` movement DIRECTLY (not via `applyMovement`) so we
        // can set `poster_transaction_id` for idempotency, accept zero stock
        // (sales can drive a store negative according to Poster — but we
        // protect ADIA by clamping to current qty via the guarded decrement,
        // never going below 0; mismatch is reconciled by the leftover sync).
        const current = await txc.query<{ qty: number }>(
          `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
          [storeId, productId],
        );
        const have = Number(current.rows[0]?.qty ?? 0);
        const decrement = Math.min(have, num);
        // EPIC 8.3 — fors major: the check rang up MORE than ADIA had on hand.
        // Stock is clamped to 0 (invariant 3 — never negative); we surface a
        // chek-level "noto'g'ri urilgan" alert so a human reconciles it.
        const shortfall = num > have ? num - have : 0;
        if (shortfall > 0) {
          await notifyWrongKeyedCheck(txc, {
            storeId,
            productId,
            transactionId,
            lineId,
            sold: num,
            had: have,
            shortfall,
          });
        }
        if (decrement > 0) {
          await txc.query(
            `UPDATE stock SET qty = qty - $1
              WHERE location_id = $2 AND product_id = $3 AND qty >= $1`,
            [decrement, storeId, productId],
          );
          await txc.query(
            `INSERT INTO stock_movements
               (product_id, from_location_id, to_location_id, qty, reason,
                poster_transaction_id, note, created_by)
             VALUES ($1, $2, NULL, $3, 'sale', $4, $5, NULL)
             ON CONFLICT (poster_transaction_id, product_id, from_location_id)
               WHERE poster_transaction_id IS NOT NULL
             DO NOTHING`,
            [productId, storeId, decrement, transactionId, `line ${lineId}`],
          );
        }
        await writeAudit(txc, {
          actorUserId: null,
          action: 'poster.sale.ingest',
          entity: 'sales',
          entityId: null,
          payload: {
            poster_transaction_id: transactionId,
            product_id: productId,
            store_id: storeId,
            qty: num,
            decrement,
          },
        });
        return { applied: true, decrement, shortfall };
      });
      if (result.applied) {
        linesInserted += 1;
        if ((result.decrement ?? 0) > 0) movementsApplied += 1;
        if ((result.shortfall ?? 0) > 0) wrongKeyedLines += 1;
      }
    } catch (err) {
      failedLines += 1;
      console.error(
        `[poster] sale line ${lineId} of tx ${transactionId} failed:`,
        redactUrl((err as Error).message),
      );
    }
  }

  return { linesInserted, movementsApplied, storeFound: true, failedLines, wrongKeyedLines };
}

/**
 * EPIC 8.3 — emit a chek-level "noto'g'ri urilgan" alert when a sale check rang
 * up more units than ADIA tracked on hand. Runs inside the line's own
 * transaction so the alert commits with the (clamped) sale. Recipients: PMs +
 * the store's manager. Debounced one-per-(store,product) per 6h so a busy POS
 * that keeps over-ringing the same item does not flood the admins.
 */
async function notifyWrongKeyedCheck(
  txc: TxClient,
  info: {
    storeId: number;
    productId: number;
    transactionId: number;
    lineId: number;
    sold: number;
    had: number;
    shortfall: number;
  },
): Promise<void> {
  const pmIds = await getPmRecipients(txc);
  const managerId = await getLocationManager(txc, info.storeId);
  const recipients = new Set<number>(pmIds);
  if (managerId !== null) recipients.add(managerId);
  for (const userId of recipients) {
    await createNotification(txc, {
      recipientUserId: userId,
      type: 'wrong_keyed_check',
      title: 'Kassa: noto\'g\'ri urilgan chek',
      body:
        `Chek #${info.transactionId}: sotildi ${info.sold}, ostatka ${info.had} edi — ` +
        `${info.shortfall} ortiqcha (do'kon ${info.storeId}, mahsulot ${info.productId}). ` +
        `Ostatka 0 ga tushirildi.`,
      payload: {
        store_id: info.storeId,
        product_id: info.productId,
        poster_transaction_id: info.transactionId,
        line_id: info.lineId,
        sold: info.sold,
        had: info.had,
        shortfall: info.shortfall,
      },
      dedupeKey: `wrong_keyed_check:${info.storeId}:${info.productId}:user:${userId}`,
      dedupeWindowMinutes: 6 * 60,
    });
  }
}

/**
 * Process pending `poster_webhook_events` rows: fetch the full transaction
 * for each, ingest, mark processed. Returns a summary for the worker log.
 */
export async function processPendingWebhookEvents(
  client: PosterClient,
  limit = 50,
): Promise<SalesIngestResult> {
  const runId = await startSyncRun('transactions', 'webhook');
  const summary = {
    eventsScanned: 0,
    eventsApplied: 0,
    linesInserted: 0,
    movementsApplied: 0,
    storeMisses: 0,
    failedLines: 0,
    wrongKeyedLines: 0,
  };
  try {
    const { rows } = await query<{ id: number; event_type: string; poster_object_id: number | null }>(
      `SELECT id, event_type, poster_object_id
         FROM poster_webhook_events
        WHERE processed = FALSE
          AND event_type IN ('transaction.close', 'transaction.update', 'transaction.add')
        ORDER BY received_at
        LIMIT $1`,
      [limit],
    );
    for (const ev of rows) {
      summary.eventsScanned += 1;
      const txId = ev.poster_object_id;
      if (txId === null) {
        await query(
          `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
          [ev.id],
        );
        continue;
      }
      let full: PosterTransactionFull | null = null;
      try {
        full = await client.getTransaction(txId);
      } catch (err) {
        console.error(`[poster] getTransaction(${txId}) failed:`, redactUrl((err as Error).message));
        // leave the event un-processed so the next tick retries
        continue;
      }
      if (full === null) {
        await query(
          `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
          [ev.id],
        );
        continue;
      }
      const result = await ingestTransaction(full);
      if (!result.storeFound) summary.storeMisses += 1;
      if (result.linesInserted > 0) summary.eventsApplied += 1;
      summary.linesInserted += result.linesInserted;
      summary.movementsApplied += result.movementsApplied;
      summary.failedLines += result.failedLines;
      summary.wrongKeyedLines += result.wrongKeyedLines;
      await query(
        `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
        [ev.id],
      );
    }
    // C7 — flip to `partial` (with a per-run stats string) when any line of
    // any event raised an exception, even though every other event succeeded.
    if (summary.failedLines > 0) {
      const detail =
        `partial: ${summary.failedLines} failed line(s) across ${summary.eventsScanned} event(s); ` +
        `${summary.linesInserted} line(s) ingested.`;
      await finishSyncRun(
        runId,
        'partial',
        { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
        detail,
      );
    } else {
      await finishSyncRun(runId, 'ok', {
        recordsIn: summary.eventsScanned,
        recordsApplied: summary.eventsApplied,
      });
    }
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(
      runId,
      'failed',
      { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
      detail,
    );
    await notifyPosterSyncFailed('transactions', detail);
    throw err;
  }
}

/**
 * Fallback poll — fetch transactions in the last `windowMinutes` and ingest
 * any line that was missed (idempotent — the same UNIQUE index protects us).
 */
export async function fallbackPollTransactions(
  client: PosterClient,
  windowMinutes = 30,
): Promise<SalesIngestResult> {
  const runId = await startSyncRun('transactions', 'poll');
  const summary = {
    eventsScanned: 0,
    eventsApplied: 0,
    linesInserted: 0,
    movementsApplied: 0,
    storeMisses: 0,
    failedLines: 0,
    wrongKeyedLines: 0,
  };
  try {
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * 60_000);
    const dateFrom = formatPosterDateTime(from);
    const dateTo = formatPosterDateTime(to);
    const list = await client.getTransactions({ dateFrom, dateTo, num: 1000 });
    for (const t of list) {
      summary.eventsScanned += 1;
      const txId = Number(t.transaction_id);
      if (!Number.isInteger(txId) || txId <= 0) continue;
      let full: PosterTransactionFull | null;
      try {
        full = await client.getTransaction(txId);
      } catch (err) {
        console.error(`[poster] fallback getTransaction(${txId}) failed:`, redactUrl((err as Error).message));
        continue;
      }
      if (full === null) continue;
      const result = await ingestTransaction(full);
      if (!result.storeFound) summary.storeMisses += 1;
      if (result.linesInserted > 0) summary.eventsApplied += 1;
      summary.linesInserted += result.linesInserted;
      summary.movementsApplied += result.movementsApplied;
      summary.failedLines += result.failedLines;
      summary.wrongKeyedLines += result.wrongKeyedLines;
    }
    if (summary.failedLines > 0) {
      const detail =
        `partial: ${summary.failedLines} failed line(s) across ${summary.eventsScanned} event(s); ` +
        `${summary.linesInserted} line(s) ingested.`;
      await finishSyncRun(
        runId,
        'partial',
        { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
        detail,
      );
    } else {
      await finishSyncRun(runId, 'ok', {
        recordsIn: summary.eventsScanned,
        recordsApplied: summary.eventsApplied,
      });
    }
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(
      runId,
      'failed',
      { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
      detail,
    );
    await notifyPosterSyncFailed('transactions', detail);
    throw err;
  }
}

function formatPosterDateTime(d: Date): string {
  // Empirical (2026-05-24): dash.getTransactions accepts "YYYY-MM-DD" but
  // returns ZERO rows when a time component is appended. The old
  // "YYYY-MM-DD HH:mm:ss" form silently dropped every poll. Keep it
  // date-only — the 30-min poll window therefore widens to whole days on
  // each tick, but ingestTransaction is idempotent on
  // (poster_transaction_id, product_id, poster_line_id) so re-runs are
  // free.
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
