/**
 * Manual minmax recalc — run the dynamic-min/max engine once and print a
 * summary. Useful right after migration 0020 (which flips many rows to
 * `minmax_mode='dynamic'`) so the canvas reflects the new numbers without
 * waiting for the 04:00 cron.
 *
 * Usage:  npx tsx scripts/recalc-minmax.ts
 */
import { closePool } from '../src/db/index.js';
import { runMinmaxRecalcCycle } from '../src/workers/minmaxRecalcCron.js';

async function main(): Promise<void> {
  console.log('[recalc-minmax] running one cycle (unfiltered)...');
  const summary = await runMinmaxRecalcCycle();
  console.log(`[recalc-minmax] scanned=${summary.scanned} updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors}`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[recalc-minmax] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
