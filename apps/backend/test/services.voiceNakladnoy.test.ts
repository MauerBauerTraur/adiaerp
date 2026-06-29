/**
 * EPIC 8.6 — generateNakladnoyFromVoice tests.
 *
 *   - a resolved voice demand (product + qty + location) creates a
 *     source='voice' nakladnoy with source_ref = voice_message_id, reusing the
 *     8.4 BOM expansion;
 *   - a non-positive qty is rejected (must clarify first), never a document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { generateNakladnoyFromVoice } from '../src/services/voiceNakladnoy.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function recipe(p: number, c: number, q: number, stage: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, $4::recipe_stage)`,
    [p, c, q, stage],
  );
}

describe('generateNakladnoyFromVoice', () => {
  it('creates a source=voice nakladnoy from a resolved demand', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Voice Store' });
    const user = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un-v' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Napoleon-v' });
    await recipe(cake, flour, 0.3, 'base');

    const result = await generateNakladnoyFromVoice({
      voiceMessageId: 12345,
      productId: cake,
      qty: 10,
      locationId: store,
      actorUserId: user.id,
      note: 'Filial-2 ga 10 ta Napoleon keldi',
    });

    expect(result.header.source).toBe('voice');
    expect(result.header.source_ref).toBe('12345');
    expect(result.header.qty).toBe(10);
    expect(result.header.location_id).toBe(store);
    const hamir = result.lines.find(
      (l) => l.section === 'hamir' && l.component_product_id === flour,
    );
    expect(hamir?.qty).toBe(3); // 0.3 * 10

    // Persisted with source_ref for the forensic chain.
    const { rows } = await ctx.db.query<{ source: string; source_ref: string | null }>(
      `SELECT source::text AS source, source_ref FROM nakladnoy WHERE id = $1`,
      [result.header.id],
    );
    expect(rows[0]?.source).toBe('voice');
    expect(rows[0]?.source_ref).toBe('12345');
  });

  it('rejects a non-positive qty (clarify first)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await expect(
      generateNakladnoyFromVoice({
        voiceMessageId: 1,
        productId: cake,
        qty: 0,
        locationId: store,
        actorUserId: null,
      }),
    ).rejects.toThrow(/qty must be > 0/);
  });
});
