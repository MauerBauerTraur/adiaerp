/**
 * Forecast refresh cron — Faza-3 Sprint 4 (F3.4, ADR-0010).
 *
 * Schedule: `30 4 * * *` (every day at 04:30 UTC = 09:30 Toshkent), one hour
 * after `sales-aggregate` (03:00) and 30 min after `minmax-recalc` (04:00)
 * so the rolling sales window is already up to date.
 *
 * Flow per cycle:
 *
 *   1. SELECT every (location_id, product_id) pair that has at least
 *      MIN_HISTORY_DAYS rows in `sales_stats_daily` over the last 90 days.
 *      Also pull the current `stock.qty` so the sidecar can compute
 *      `expected_stockout_date` in one round-trip.
 *
 *   2. Read each pair's 90-day daily series — one query per pair would be
 *      1500 round trips; instead a single GROUP BY pulls every series in
 *      one statement and `groupBy()` slices it client-side.
 *
 *   3. Slice into BATCH_SIZE chunks (default 50) and `POST /predict` each
 *      one. The shared secret travels in the JSON body, never the URL.
 *
 *   4. Upsert every returned forecast into `forecasts`. Items with
 *      `insufficient_data` or `failed` are skipped (no row touched — the
 *      previous good row, if any, survives).
 *
 *   5. One audit row per cycle (system actor) with the summary; one
 *      `import_warnings` row for each sidecar batch error.
 *
 * Re-entrancy guard: a 10-minute Prophet run is realistic on a 1500-item
 * batch; the next 04:30 tick would never overlap in practice, but the guard
 * keeps the engine sane if something is stuck.
 *
 * Disabled mode: when `config.forecaster.enabled === false`, the cycle is
 * a no-op and logs one info line. The cron itself does not start.
 */
import cron from 'node-cron';
import { loadConfig } from '../config/index.js';
import { query, withTransaction, type TxClient } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { recordImportWarning } from '../services/importWarnings.js';

/** node-cron expression — every day at 04:30. */
export const FORECAST_REFRESH_SCHEDULE = '30 4 * * *';

/** Minimum history a pair must have before the sidecar tries to fit. */
const MIN_HISTORY_DAYS = 30;

/** Look-back window — Prophet learns weekly seasonality on this. */
const LOOKBACK_DAYS = 90;

let task: cron.ScheduledTask | undefined;

export const cronGuard: { running: boolean } = { running: false };

export type ForecastRefreshSummary = {
  /** Pairs considered (had ≥ MIN_HISTORY_DAYS rows). */
  readonly scanned: number;
  /** Forecast rows upserted (sidecar returned a real prediction). */
  readonly updated: number;
  /** Items the sidecar marked `insufficient_data` or `failed`. */
  readonly skipped: number;
  /** HTTP / parse errors across all batches (not per-item failures). */
  readonly errors: number;
};

export function startForecastRefreshWorker(): cron.ScheduledTask | undefined {
  const cfg = loadConfig();
  if (!cfg.forecaster.enabled) {
    console.log('[forecast-refresh] sidecar disabled — worker not started');
    return undefined;
  }
  if (task !== undefined) return task;
  task = cron.schedule(FORECAST_REFRESH_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

export function stopForecastRefreshWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/** Cron entry point — overlap guard + unfiltered run. */
export async function runOneCycle(): Promise<void> {
  if (cronGuard.running) {
    console.log('[forecast-refresh] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const summary = await runForecastRefreshCycle();
    console.log(
      `[forecast-refresh] scanned=${summary.scanned} updated=${summary.updated} ` +
        `skipped=${summary.skipped} errors=${summary.errors}`,
    );
  } catch (err) {
    console.error('[forecast-refresh] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}

// ---------------------------------------------------------------------------
// Wire types — keep aligned with apps/forecaster/app/main.py
// ---------------------------------------------------------------------------

type ForecastInputItem = {
  readonly location_id: number;
  readonly product_id: number;
  readonly current_qty: number | null;
  readonly sales_daily: ReadonlyArray<{ date: string; qty: number }>;
};

type SidecarPrediction = {
  readonly location_id: number;
  readonly product_id: number;
  readonly daily_predictions: ReadonlyArray<{
    date: string;
    yhat: number;
    yhat_lower: number;
    yhat_upper: number;
  }>;
  readonly expected_stockout_date: string | null;
  readonly insufficient_data?: boolean;
  readonly failed?: boolean;
  readonly error?: string;
};

type SidecarResponse = { forecasts: SidecarPrediction[] };

/**
 * Test seam — production calls the real sidecar over HTTP. Tests inject
 * a stub via `setSidecarCaller`. The default uses the global `fetch` with
 * a hard timeout (Node 20+).
 */
export type SidecarCaller = (
  url: string,
  body: { secret: string; items: ForecastInputItem[]; horizon_days: number },
  timeoutMs: number,
) => Promise<SidecarResponse>;

let sidecarCaller: SidecarCaller = defaultSidecarCaller;

export function setSidecarCaller(c: SidecarCaller | null): void {
  sidecarCaller = c ?? defaultSidecarCaller;
}

async function defaultSidecarCaller(
  url: string,
  body: { secret: string; items: ForecastInputItem[]; horizon_days: number },
  timeoutMs: number,
): Promise<SidecarResponse> {
  const ctrl = new AbortController();
  const t = globalThis.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(`${url.replace(/\/+$/, '')}/predict`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Read & throw — never bubble the secret back even if Prophet echoed it.
      const detail = await res.text().catch(() => '');
      throw new Error(`forecaster HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as SidecarResponse;
  } finally {
    globalThis.clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Cycle implementation
// ---------------------------------------------------------------------------

type PairCandidate = {
  location_id: number;
  product_id: number;
  current_qty: number | null;
  history_days: number;
};

/**
 * Execute one refresh pass. Exported so tests + the admin trigger
 * (`POST /api/admin/forecasts/recalc`) can drive it synchronously.
 *
 * Sidecar errors are isolated per batch — a 500 on batch 3 logs one
 * `import_warnings` row and the cron moves on to batch 4. The previous
 * `forecasts` rows for the failed batch survive (graceful degradation,
 * ADR-0010 §"Edge case'lar").
 */
export async function runForecastRefreshCycle(
  actorUserId: number | null = null,
): Promise<ForecastRefreshSummary> {
  const cfg = loadConfig();
  if (!cfg.forecaster.enabled) {
    return { scanned: 0, updated: 0, skipped: 0, errors: 0 };
  }

  // Step 1 — pairs eligible for a forecast. The HAVING clause filters out
  // brand-new products / locations under the MIN_HISTORY_DAYS threshold so
  // we never even send them to the sidecar (cheaper than a 401 round-trip).
  const { rows: pairs } = await query<{
    location_id: string;
    product_id: string;
    current_qty: string | null;
    history_days: string;
  }>(
    `SELECT ssd.location_id::text       AS location_id,
            ssd.product_id::text        AS product_id,
            s.qty::text                 AS current_qty,
            count(*)::text              AS history_days
       FROM sales_stats_daily ssd
       LEFT JOIN stock s
         ON s.location_id = ssd.location_id
        AND s.product_id  = ssd.product_id
      WHERE ssd.stat_date >= current_date - $1::int
      GROUP BY ssd.location_id, ssd.product_id, s.qty
     HAVING count(*) >= $2::int
      ORDER BY ssd.location_id, ssd.product_id`,
    [LOOKBACK_DAYS, MIN_HISTORY_DAYS],
  );

  const candidates: PairCandidate[] = pairs.map((r) => ({
    location_id: Number(r.location_id),
    product_id: Number(r.product_id),
    current_qty: r.current_qty === null ? null : Number(r.current_qty),
    history_days: Number(r.history_days),
  }));

  if (candidates.length === 0) {
    await writeAuditRow(actorUserId, {
      scanned: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    });
    return { scanned: 0, updated: 0, skipped: 0, errors: 0 };
  }

  // Step 2 — bulk-load the daily series for every candidate in one query.
  // 1500 pairs * 90 days = 135k rows worst case; pg handles it comfortably.
  const { rows: seriesRows } = await query<{
    location_id: string;
    product_id: string;
    stat_date: Date;
    qty_sold: string;
  }>(
    `SELECT location_id::text AS location_id,
            product_id::text  AS product_id,
            stat_date,
            qty_sold::text    AS qty_sold
       FROM sales_stats_daily
      WHERE stat_date >= current_date - $1::int
      ORDER BY location_id, product_id, stat_date`,
    [LOOKBACK_DAYS],
  );
  const seriesByPair = new Map<string, Array<{ date: string; qty: number }>>();
  for (const r of seriesRows) {
    const key = `${r.location_id}:${r.product_id}`;
    let arr = seriesByPair.get(key);
    if (arr === undefined) {
      arr = [];
      seriesByPair.set(key, arr);
    }
    const iso =
      r.stat_date instanceof Date
        ? r.stat_date.toISOString().slice(0, 10)
        : String(r.stat_date).slice(0, 10);
    arr.push({ date: iso, qty: Number(r.qty_sold) });
  }

  // Step 3 — build the input batch, chunk by batchSize, call the sidecar.
  const inputs: ForecastInputItem[] = candidates.map((c) => ({
    location_id: c.location_id,
    product_id: c.product_id,
    current_qty: c.current_qty,
    sales_daily: seriesByPair.get(`${c.location_id}:${c.product_id}`) ?? [],
  }));

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < inputs.length; i += cfg.forecaster.batchSize) {
    const batch = inputs.slice(i, i + cfg.forecaster.batchSize);
    let response: SidecarResponse;
    try {
      response = await sidecarCaller(
        cfg.forecaster.url,
        {
          secret: cfg.forecaster.sharedSecret,
          items: batch,
          horizon_days: cfg.forecaster.horizonDays,
        },
        cfg.forecaster.requestTimeoutMs,
      );
    } catch (err) {
      errors += 1;
      console.error(
        `[forecast-refresh] batch ${i / cfg.forecaster.batchSize} failed:`,
        (err as Error).message,
      );
      await recordImportWarning({
        source: 'forecast.refresh',
        entity: `batch:${i}`,
        severity: 'error',
        message: 'Forecaster sidecar batch failed',
        payload: {
          batch_index: i / cfg.forecaster.batchSize,
          batch_size: batch.length,
          error: (err as Error).message.slice(0, 500),
        },
      });
      continue;
    }

    const outcomes = await upsertForecasts(response.forecasts);
    updated += outcomes.updated;
    skipped += outcomes.skipped;
  }

  const summary = { scanned: candidates.length, updated, skipped, errors };
  await writeAuditRow(actorUserId, summary);
  return summary;
}

async function upsertForecasts(
  forecasts: ReadonlyArray<SidecarPrediction>,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const f of forecasts) {
    if (f.insufficient_data === true || f.failed === true) {
      skipped += 1;
      continue;
    }
    if (!Array.isArray(f.daily_predictions) || f.daily_predictions.length === 0) {
      // Nothing useful to cache — treat as a skip rather than write empty JSON.
      skipped += 1;
      continue;
    }

    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO forecasts
             (location_id, product_id, daily_predictions, expected_stockout_date,
              generated_at, source)
           VALUES ($1, $2, $3::jsonb, $4, now(), 'prophet')
           ON CONFLICT (location_id, product_id) DO UPDATE
             SET daily_predictions      = EXCLUDED.daily_predictions,
                 expected_stockout_date = EXCLUDED.expected_stockout_date,
                 generated_at           = now(),
                 source                 = EXCLUDED.source`,
          [
            f.location_id,
            f.product_id,
            JSON.stringify(f.daily_predictions),
            f.expected_stockout_date,
          ],
        );
      });
      updated += 1;
    } catch (err) {
      skipped += 1;
      console.error(
        `[forecast-refresh] upsert failed for loc=${f.location_id} prod=${f.product_id}:`,
        (err as Error).message,
      );
    }
  }
  return { updated, skipped };
}

async function writeAuditRow(
  actorUserId: number | null,
  summary: ForecastRefreshSummary,
): Promise<void> {
  await withTransaction(async (tx: TxClient) => {
    await writeAudit(tx, {
      actorUserId,
      action: 'forecasts.refresh',
      entity: 'forecasts',
      entityId: null,
      payload: summary,
    });
  });
}
