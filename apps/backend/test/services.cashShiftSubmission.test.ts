/**
 * EPIC 8.5 — cash shift submission (kassir topshirig'i) tests.
 *
 *   - parseCashShiftSubmission: o'zbek/rus matnidan rasxod/qoldiq/karta summalar.
 *   - createCashShiftNakladnoy: money-only `cash_shift` nakladnoy + audit + notify.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';
import {
  parseCashShiftSubmission,
  createCashShiftNakladnoy,
} from '../src/services/cashShiftSubmission.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('parseCashShiftSubmission', () => {
  it('parses the owner example "rasxod 5M, qoldim 3M (kartadan 2M)"', () => {
    const r = parseCashShiftSubmission(
      'rasxod 5 000 000, qoldim 3 000 000 (kartadan 2 000 000), itogo savdo',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.figures.expense).toBe(5_000_000);
    expect(r.figures.remainder).toBe(3_000_000);
    expect(r.figures.card).toBe(2_000_000);
  });

  it('supports kk/mln shorthand and Russian keywords', () => {
    const r = parseCashShiftSubmission('расход 5kk, остаток 3 млн, карта 1kk');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.figures.expense).toBe(5_000_000);
    expect(r.figures.remainder).toBe(3_000_000);
    expect(r.figures.card).toBe(1_000_000);
  });

  it('defaults expense and card to 0 when only remainder is given', () => {
    const r = parseCashShiftSubmission('qoldim 4 000 000');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.figures.expense).toBe(0);
    expect(r.figures.card).toBe(0);
    expect(r.figures.remainder).toBe(4_000_000);
  });

  it('fails when no remainder keyword is present', () => {
    const r = parseCashShiftSubmission('rasxod 5 000 000');
    expect(r.ok).toBe(false);
  });

  it('rejects card greater than remainder', () => {
    const r = parseCashShiftSubmission('qoldim 1 000 000 kartadan 2 000 000');
    expect(r.ok).toBe(false);
  });
});

describe('createCashShiftNakladnoy', () => {
  it('creates a cash_shift money nakladnoy + audit + notifications', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Cash Store' });
    const manager = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    // Make the store's assigned manager the seeded manager.
    await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
      manager.id,
      store,
    ]);

    const result = await createCashShiftNakladnoy({
      locationId: store,
      actorUserId: manager.id,
      figures: { expense: 5_000_000, remainder: 3_000_000, card: 2_000_000 },
      note: 'kun oxiri',
    });

    // itogo savdo = qoldiq + rasxod = 3M + 5M = 8M; naqd qoldiq = 3M - 2M = 1M.
    expect(result.totalSales).toBe(8_000_000);
    expect(result.cashRemainder).toBe(1_000_000);

    const { rows: header } = await ctx.db.query<{
      source: string;
      product_id: string | null;
      total_amount: string;
      location_id: string;
    }>(
      `SELECT source::text AS source, product_id, total_amount, location_id
         FROM nakladnoy WHERE id = $1`,
      [result.nakladnoyId],
    );
    expect(header[0]?.source).toBe('cash_shift');
    expect(header[0]?.product_id).toBeNull();
    expect(Number(header[0]?.total_amount)).toBe(8_000_000);
    expect(Number(header[0]?.location_id)).toBe(store);

    const { rows: lines } = await ctx.db.query<{ section: string; label: string; unit: string }>(
      `SELECT section::text AS section, label, unit FROM nakladnoy_lines
        WHERE nakladnoy_id = $1 ORDER BY id`,
      [result.nakladnoyId],
    );
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.section === 'itogo')).toBe(true);
    expect(lines.every((l) => l.unit === 'som')).toBe(true);

    // Audit row.
    const { rows: audit } = await ctx.db.query<{ count: string }>(
      `SELECT count(*) FROM audit_log
        WHERE action = 'nakladnoy.create' AND entity_id = $1`,
      [result.nakladnoyId],
    );
    expect(Number(audit[0]?.count)).toBe(1);

    // Notifications: cashier + PM + store manager (cashier==manager here, so PM + manager).
    const { rows: notifs } = await ctx.db.query<{ recipient_user_id: string }>(
      `SELECT recipient_user_id FROM notifications
        WHERE type = 'cash_shift_submitted'
          AND (payload->>'nakladnoy_id')::bigint = $1`,
      [result.nakladnoyId],
    );
    const recipients = notifs.map((n) => Number(n.recipient_user_id)).sort((a, b) => a - b);
    expect(recipients).toContain(pm.id);
    expect(recipients).toContain(manager.id);
  });

  it('rejects negative amounts', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const u = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    await expect(
      createCashShiftNakladnoy({
        locationId: store,
        actorUserId: u.id,
        figures: { expense: -1, remainder: 1000, card: 0 },
      }),
    ).rejects.toThrow(/manfiy/);
  });
});
