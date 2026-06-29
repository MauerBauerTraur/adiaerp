import { runSalesAggregateCycle } from '../src/workers/salesAggregateCron.js';
import { closePool } from '../src/db/pool.js';
(async () => {
  const r = await runSalesAggregateCycle();
  console.log('sales aggregate done:', r);
  await closePool();
})();
