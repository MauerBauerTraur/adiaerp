/**
 * EPIC 5 / ADR-0016 (OQ4) — production dialog expiry cron.
 *
 *   - runOneCycle stamps overdue open dialogs EXPIRED.
 *   - the overlap guard skips a cycle while one is already running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { createDialogForOrder, getDialog } from '../src/services/productionDialog.js';
import { cronGuard, runOneCycle } from '../src/workers/productionDialogExpireCron.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function overdueDialog(): Promise<number> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id)
       VALUES ($1, 'sex_storage'::location_type, $2) RETURNING id`,
    [`Tort skladi ${Math.random().toString(36).slice(2, 8)}`, production],
  );
  const sexStorage = Number(rows[0]?.id);
  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const zagatovka = await makeProduct(ctx.db, { type: 'semi', unit: 'pcs' });
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1,$2,1,'decoration'::recipe_stage)`,
    [cake, zagatovka],
  );
  await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
  const session = await createDialogForOrder({
    productId: cake, locationId: production, qtyOrdered: 5, actorUserId: null,
  });
  await ctx.db.query(
    `UPDATE production_dialog_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`,
    [session!.id],
  );
  return session!.id;
}

describe('productionDialogExpireCron.runOneCycle', () => {
  it('stamps overdue open dialogs EXPIRED', async () => {
    const id = await overdueDialog();
    const { expired } = await runOneCycle();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect((await getDialog(id))?.state).toBe('EXPIRED');
  });

  it('skips while a previous cycle is still running (overlap guard)', async () => {
    cronGuard.running = true;
    try {
      const { expired } = await runOneCycle();
      expect(expired).toBe(0);
    } finally {
      cronGuard.running = false;
    }
  });
});
