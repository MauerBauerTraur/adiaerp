/**
 * One-shot backfill for historical Poster transactions.
 *
 * `posterSalesSync` only polls a 30-minute window in production. After the
 * very first deploy (or whenever the dev DB has been seeded fresh) we need
 * to walk back several days so the dashboard shows real sales. Run via:
 *
 *   npm run poster:backfill -w @adia/backend -- --days 7
 *
 * Idempotent: ingestTransaction relies on the UNIQUE indices
 * (sales.uq_sales_poster_line, stock_movements partial UNIQUE on
 * poster_transaction_id) so re-runs are no-ops for already-imported rows.
 */
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';
import {
  fallbackPollTransactions,
} from '../src/integrations/poster/salesSync.js';
import { closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.poster.token) {
    console.error('[backfill] POSTER_TOKEN is empty — aborting.');
    process.exit(1);
  }

  const days = parseDaysArg(process.argv);
  console.log(`[backfill] starting — last ${days} day(s)`);

  const client = createPosterClientFromConfig();
  const windowMinutes = days * 24 * 60;

  const summary = await fallbackPollTransactions(client, windowMinutes);
  console.log('[backfill] done:', summary);
  await closePool();
}

function parseDaysArg(argv: readonly string[]): number {
  const i = argv.findIndex((a) => a === '--days');
  if (i >= 0 && i + 1 < argv.length) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0 && n <= 90) return Math.floor(n);
  }
  return 7;
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
