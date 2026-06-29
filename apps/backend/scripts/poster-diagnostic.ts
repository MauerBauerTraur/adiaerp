/**
 * ONE-OFF read-only Poster diagnostic (EPIC 0 / EPIC 0+ — 2026-05-29).
 *
 * Answers four blocker questions WITHOUT writing anything anywhere:
 *   1. Live storage list (id|name) — authoritative mapping source.
 *   2. Payment unit (tiyin ÷100 vs already-so'm) via dash.getPaymentsReport.
 *   3. 30-day revenue series via dash.getAnalytics (chart backfill question).
 *   4. poster_webhook_events table state (is the webhook delivering?).
 *
 * READ-ONLY: only GET. No createWriteOff / createTransaction / etc.
 * The token is NEVER printed — every URL is redacted before logging.
 *
 * Run: `npm run poster:diagnostic -w @adia/backend`
 */
import dns from 'node:dns';
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';
import { query, closePool } from '../src/db/index.js';

// LOCAL-DEV-ONLY workaround: this sandbox resolves joinposter.com to IPv6
// addresses whose route times out (ETIMEDOUT), while IPv4 works. Force Node's
// fetch (undici) to use IPv4 here so the diagnostic can reach Poster. This is
// confined to the script — the production client is untouched (the VPS routes
// IPv6 normally).
{
  const orig = dns.lookup.bind(dns);
  // @ts-expect-error — overriding the lookup signature for the v4 default.
  dns.lookup = (host: string, opts: unknown, cb: unknown): unknown => {
    if (typeof opts === 'function') {
      return orig(host, { family: 4 }, opts as never);
    }
    return orig(host, { ...(opts as object), family: 4 }, cb as never);
  };
}

const BASE = 'https://joinposter.com/api';

/** Redact the token query param so it never reaches a log line. */
function redact(url: string): string {
  return url.replace(/(token=)[^&]+/i, '$1<redacted>');
}

/** Minimal read-only GET for endpoints the typed client does not wrap yet. */
async function rawGet<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE}/${method}`);
  url.searchParams.set('token', token);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`[${method}] HTTP ${res.status} (${redact(url.toString())})`);
  }
  const body = (await res.json()) as
    | { response: T }
    | { error: { code: number; message: string } };
  if ('error' in body) {
    throw new Error(`[${method}] poster error ${body.error.code}: ${body.error.message}`);
  }
  return body.response;
}

function yyyymmdd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = cfg.poster.token;
  if (token === '') throw new Error('POSTER_TOKEN missing in apps/backend/.env');
  const client = createPosterClientFromConfig();

  // ---------------------------------------------------------------------------
  console.log('\n=== 1. storage.getStorages (LIVE) ===');
  const storages = await client.getStorages();
  console.log(`count=${storages.length}`);
  console.log('id | name | deleted');
  for (const s of storages) {
    console.log(`${s.storage_id} | ${s.storage_name} | ${s.delete ?? '0'}`);
  }

  console.log('\n=== access.getSpots (LIVE) ===');
  const spots = await client.getSpots();
  for (const s of spots) {
    console.log(`spot_id=${s.spot_id} name=${(s.spot_name ?? s.name).trim()}`);
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. dash.getPaymentsReport — TODAY ===');
  const today = new Date();
  const todayStr = yyyymmdd(today);
  const payToday = await rawGet<unknown>(token, 'dash.getPaymentsReport', {
    dateFrom: todayStr,
    dateTo: todayStr,
  });
  console.log(JSON.stringify(payToday, null, 2).slice(0, 4000));

  console.log('\n=== dash.getPaymentsReport — LAST 7 DAYS ===');
  const sevenAgo = new Date(today.getTime() - 6 * 86_400_000);
  const pay7 = await rawGet<unknown>(token, 'dash.getPaymentsReport', {
    dateFrom: yyyymmdd(sevenAgo),
    dateTo: todayStr,
  });
  console.log(JSON.stringify(pay7, null, 2).slice(0, 6000));

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. dash.getAnalytics revenue (interpolate=day, last 30d) ===');
  const thirtyAgo = new Date(today.getTime() - 29 * 86_400_000);
  const analytics = await rawGet<{
    data?: unknown[];
    counters?: Record<string, unknown>;
  }>(token, 'dash.getAnalytics', {
    dateFrom: yyyymmdd(thirtyAgo),
    dateTo: todayStr,
    interpolate: 'day',
    select: 'revenue',
  });
  console.log('counters:', JSON.stringify(analytics.counters ?? {}, null, 2));
  console.log('data (daily revenue series):');
  console.log(JSON.stringify(analytics.data ?? [], null, 2).slice(0, 4000));

  // ---------------------------------------------------------------------------
  console.log('\n=== Local DB cross-checks ===');
  try {
    const salesAgg = await query<{ cnt: string; days: string; total: string | null; mn: Date | null; mx: Date | null }>(
      `SELECT count(*) AS cnt,
              count(DISTINCT sold_at::date) AS days,
              coalesce(sum(qty * price), 0) AS total,
              min(sold_at) AS mn, max(sold_at) AS mx
         FROM sales`,
    );
    const r = salesAgg.rows[0]!;
    console.log(
      `sales rows=${r.cnt} distinct_days=${r.days} sum(qty*price)=${r.total} ` +
        `range=${r.mn?.toISOString() ?? 'n/a'} .. ${r.mx?.toISOString() ?? 'n/a'}`,
    );

    const perDay = await query<{ d: Date; cnt: string; total: string }>(
      `SELECT sold_at::date AS d, count(*) AS cnt, sum(qty * price) AS total
         FROM sales
        WHERE sold_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
    );
    console.log('local sales per day (last 30d):');
    for (const d of perDay.rows) {
      console.log(`  ${d.d.toISOString().slice(0, 10)} cnt=${d.cnt} sum=${d.total}`);
    }

    console.log('\n=== 4. poster_webhook_events ===');
    const wh = await query<{ cnt: string; processed: string; mn: Date | null; mx: Date | null }>(
      `SELECT count(*) AS cnt,
              count(*) FILTER (WHERE processed) AS processed,
              min(received_at) AS mn, max(received_at) AS mx
         FROM poster_webhook_events`,
    );
    const w = wh.rows[0]!;
    console.log(
      `events=${w.cnt} processed=${w.processed} ` +
        `range=${w.mn?.toISOString() ?? 'n/a'} .. ${w.mx?.toISOString() ?? 'n/a'}`,
    );
    const recent = await query<{ id: string; event_type: string; received_at: Date; processed: boolean }>(
      `SELECT id, event_type, received_at, processed
         FROM poster_webhook_events ORDER BY received_at DESC LIMIT 10`,
    );
    for (const e of recent.rows) {
      console.log(`  #${e.id} ${e.event_type} ${e.received_at.toISOString()} processed=${e.processed}`);
    }

    console.log('\n=== poster_sync_log (last 10) ===');
    const sl = await query<{ entity: string; trigger: string; status: string; started_at: Date; records_in: string | null }>(
      `SELECT entity, trigger, status::text AS status, started_at, records_in
         FROM poster_sync_log ORDER BY started_at DESC LIMIT 10`,
    );
    for (const s of sl.rows) {
      console.log(`  ${s.started_at.toISOString()} ${s.entity}/${s.trigger} ${s.status} in=${s.records_in ?? '-'}`);
    }
  } catch (err) {
    console.error('DB cross-check skipped (DB unreachable?):', (err as Error).message);
  } finally {
    await closePool().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[poster:diagnostic] failed:', redact((err as Error).message ?? String(err)));
  process.exit(1);
});
