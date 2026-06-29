/**
 * E2E SCENARIO 3, 4, 5(nakladnoy).
 *
 * SCENARIO 3 — Poster sale -> store stock decrement (EPIC 8.2/8.3):
 *   ingestTransaction drives a store's stock down atomically per check line.
 *   - normal: ost 10 - sotildi 5 -> qoldi 5;
 *   - fors-major: ost 10 - sotildi 11 -> clamp to 0 (invariant 3) + a
 *     "noto'g'ri urilgan" (wrong_keyed_check) alert is emitted;
 *   - idempotency: replaying the same transaction does NOT double-decrement.
 *
 * SCENARIO 4 — admin -> skladchi purchase order (EPIC 6.1):
 *   createAdminPurchaseOrder pre-fills the MANAGER step (admin is orderer) and
 *   stays draft awaiting the KEEPER (two-step approval, invariant 7); on the
 *   keeper approve it flips to approved; receive credits the raw warehouse
 *   atomically (stock up + audit).
 *
 * SCENARIO 5 — zayavka -> nakladnoy (EPIC 8.4):
 *   createNakladnoy for "10 Napoleon sotildi" yields a sectioned document
 *   (hamir/krem) PLUS an ITOGO grand total that sums each raw across sections.
 *   No Poster write, no stock mutation (egasi qarori — ADIA-internal only).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { makeProduct, makeUser, setStock, getQty } from '../helpers/fixtures.js';
import { ingestTransaction } from '../../src/integrations/poster/salesSync.js';
import {
  createAdminPurchaseOrder,
  approvePurchaseOrder,
  receivePurchaseOrder,
} from '../../src/services/purchaseOrder.js';
import { createNakladnoy } from '../../src/services/nakladnoy.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function makeLoc(type: string, posterSpotId: number | null = null): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, parent_id, poster_spot_id)
     VALUES ($1, $2::location_type, NULL, $3) RETURNING id`,
    [`${type} ${Math.random().toString(36).slice(2, 7)}`, type, posterSpotId],
  );
  return Number(rows[0]!.id);
}

/** Seed a product with a poster_product_id so sales-line resolution works. */
async function makeSalesProduct(posterProductId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (name, type, unit, sku, poster_product_id)
     VALUES ($1, 'finished', 'pcs', $2, $3) RETURNING id`,
    [`P${posterProductId}`, `SKU-${posterProductId}`, posterProductId],
  );
  return Number(rows[0]!.id);
}

describe('SCENARIO 3 — Poster sale -> atomic store stock decrement + fors-major clamp', () => {
  it('3a normal: ost 10 - sotildi 5 -> qoldi 5 (atomic, single sale movement)', async () => {
    const spotId = 7001;
    const store = await makeLoc('store', spotId);
    const posterProductId = 50001;
    const product = await makeSalesProduct(posterProductId);
    await setStock(ctx.db, { locationId: store, productId: product, qty: 10 });

    const result = await ingestTransaction({
      transaction_id: '900001',
      spot_id: String(spotId),
      date_close: '2026-05-30 12:00:00',
      products: [{ product_id: String(posterProductId), num: '5', product_price: '10000' }],
    } as never);

    expect(result.storeFound).toBe(true);
    expect(result.linesInserted).toBe(1);
    expect(result.movementsApplied).toBe(1);
    expect(result.wrongKeyedLines).toBe(0);
    // ost 10 - 5 = 5.
    expect(await getQty(ctx.db, store, product)).toBe(5);
  });

  it('3b fors-major: ost 10 - sotildi 11 -> clamp to 0 (never negative) + wrong_keyed alert', async () => {
    const spotId = 7002;
    const store = await makeLoc('store', spotId);
    const posterProductId = 50002;
    const product = await makeSalesProduct(posterProductId);
    // A PM exists so the wrong_keyed alert has a recipient.
    await makeUser(ctx.db, { role: 'pm' });
    await setStock(ctx.db, { locationId: store, productId: product, qty: 10 });

    const result = await ingestTransaction({
      transaction_id: '900002',
      spot_id: String(spotId),
      date_close: '2026-05-30 13:00:00',
      products: [{ product_id: String(posterProductId), num: '11', product_price: '10000' }],
    } as never);

    expect(result.wrongKeyedLines).toBe(1);
    // Invariant 3 — clamped to 0, NOT negative.
    expect(await getQty(ctx.db, store, product)).toBe(0);

    // A wrong_keyed_check notification was created.
    const { rows: alerts } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE type = 'wrong_keyed_check'`,
    );
    expect(Number(alerts[0]!.n)).toBeGreaterThanOrEqual(1);

    // No stock row went negative anywhere.
    const { rows: neg } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM stock WHERE qty < 0');
    expect(Number(neg[0]!.n)).toBe(0);
  });

  it('3c idempotency: replaying the same transaction does NOT double-decrement', async () => {
    const spotId = 7003;
    const store = await makeLoc('store', spotId);
    const posterProductId = 50003;
    const product = await makeSalesProduct(posterProductId);
    await setStock(ctx.db, { locationId: store, productId: product, qty: 20 });

    const txPayload = {
      transaction_id: '900003',
      spot_id: String(spotId),
      date_close: '2026-05-30 14:00:00',
      products: [{ product_id: String(posterProductId), num: '6', product_price: '5000' }],
    } as never;

    await ingestTransaction(txPayload);
    expect(await getQty(ctx.db, store, product)).toBe(14);
    // Replay — must be a no-op on stock (ON CONFLICT DO NOTHING).
    const replay = await ingestTransaction(txPayload);
    expect(replay.linesInserted).toBe(0);
    expect(await getQty(ctx.db, store, product)).toBe(14);
  });

  it('3d empty input: a transaction with no resolvable store is a no-op', async () => {
    const result = await ingestTransaction({
      transaction_id: '900004',
      spot_id: '99999', // no location maps to this spot
      date_close: '2026-05-30 15:00:00',
      products: [{ product_id: '1', num: '1', product_price: '1' }],
    } as never);
    expect(result.storeFound).toBe(false);
    expect(result.linesInserted).toBe(0);
  });
});

describe('SCENARIO 4 — admin -> skladchi purchase order (two-step approval + atomic receive)', () => {
  it('4a admin creates -> manager pre-approved, awaits keeper -> keeper approves -> receive credits raw wh', async () => {
    const rawWh = await makeLoc('raw_warehouse');
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const admin = await makeUser(ctx.db, { role: 'pm' });
    const keeper = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 10 });

    const po = await createAdminPurchaseOrder({
      productId: flour,
      qty: 40,
      supplierId: null,
      targetLocationId: rawWh,
      note: 'admin buyurtmasi',
      adminUserId: admin.id,
    });
    // Admin (orderer) = manager step pre-filled; status stays draft awaiting keeper.
    expect(po.status).toBe('draft');
    expect(po.manager_approved_by).toBe(admin.id);
    expect(po.keeper_approved_by).toBeNull();
    expect(po.initiated_by_admin).toBe(true);

    // Keeper (skladchi) approves — the SECOND step flips it to approved.
    const approved = await approvePurchaseOrder(po.id, 'keeper', keeper.id);
    expect(approved.status).toBe('approved');

    // Receive — flour enters raw warehouse atomically (10 + 40 = 50).
    await receivePurchaseOrder(po.id, keeper.id);
    expect(await getQty(ctx.db, rawWh, flour)).toBe(50);

    // Audit trail: admin_create + approved + received.
    const { rows: audit } = await ctx.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'purchase_orders' AND entity_id = $1 ORDER BY id`,
      [po.id],
    );
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('purchase_order.admin_create');
  });

  it('4b cannot receive before keeper approval (still draft) -> validation error', async () => {
    const rawWh = await makeLoc('raw_warehouse');
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const admin = await makeUser(ctx.db, { role: 'pm' });
    await setStock(ctx.db, { locationId: rawWh, productId: sugar, qty: 0 });

    const po = await createAdminPurchaseOrder({
      productId: sugar,
      qty: 5,
      supplierId: null,
      targetLocationId: rawWh,
      note: null,
      adminUserId: admin.id,
    });
    // Receiving a draft (keeper not yet approved) must throw.
    await expect(receivePurchaseOrder(po.id, admin.id)).rejects.toThrow();
    // Stock untouched.
    expect(await getQty(ctx.db, rawWh, sugar)).toBe(0);
  });
});

describe('SCENARIO 5 — zayavka -> nakladnoy (sectioned hamir/krem + ITOGO total, no stock/Poster write)', () => {
  it('5a "10 Napoleon": hamir + krem sections AND an ITOGO that sums each raw across sections', async () => {
    // Napoleon: base (hamir) = 0.3 kg flour + 0.1 kg sugar per unit.
    //           decoration (krem) = a cream semi (itself flour+sugar) — but to
    //           keep the assertion crisp we use a raw "krem" PLUS shared sugar so
    //           ITOGO must sum sugar from BOTH sections.
    const napoleon = await makeProduct(ctx.db, { type: 'finished', name: 'Napoleon' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar' });

    // hamir (base): 0.3 flour + 0.1 sugar.
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1,$2,0.3,'base'), ($1,$3,0.1,'base')`,
      [napoleon, flour, sugar],
    );
    // krem (decoration): 0.2 flour + 0.05 sugar (cream made of the same raws).
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1,$2,0.2,'decoration'), ($1,$3,0.05,'decoration')`,
      [napoleon, flour, sugar],
    );

    const { header, lines } = await createNakladnoy({
      source: 'sale',
      sourceRef: 'tx-napoleon-10',
      productId: napoleon,
      qty: 10,
      actorUserId: null,
    });

    expect(header.product_id).toBe(napoleon);
    expect(header.qty).toBe(10);

    // Sectioned: hamir + krem present, plus itogo.
    const sections = new Set(lines.map((l) => l.section));
    expect(sections.has('hamir')).toBe(true);
    expect(sections.has('krem')).toBe(true);
    expect(sections.has('itogo')).toBe(true);

    // hamir flour = 10 * 0.3 = 3 kg; hamir sugar = 10 * 0.1 = 1 kg.
    const hamirFlour = lines.find((l) => l.section === 'hamir' && l.component_product_id === flour);
    const hamirSugar = lines.find((l) => l.section === 'hamir' && l.component_product_id === sugar);
    expect(hamirFlour!.qty).toBeCloseTo(3, 4);
    expect(hamirSugar!.qty).toBeCloseTo(1, 4);

    // krem flour = 10 * 0.2 = 2 kg; krem sugar = 10 * 0.05 = 0.5 kg.
    const kremFlour = lines.find((l) => l.section === 'krem' && l.component_product_id === flour);
    const kremSugar = lines.find((l) => l.section === 'krem' && l.component_product_id === sugar);
    expect(kremFlour!.qty).toBeCloseTo(2, 4);
    expect(kremSugar!.qty).toBeCloseTo(0.5, 4);

    // ITOGO: flour = 3 + 2 = 5 kg; sugar = 1 + 0.5 = 1.5 kg (sum across sections).
    const itogoFlour = lines.find((l) => l.section === 'itogo' && l.component_product_id === flour);
    const itogoSugar = lines.find((l) => l.section === 'itogo' && l.component_product_id === sugar);
    expect(itogoFlour!.qty).toBeCloseTo(5, 4);
    expect(itogoSugar!.qty).toBeCloseTo(1.5, 4);
  });

  it('5b nakladnoy mutates NO stock and persists header + lines (ADIA-internal only)', async () => {
    const cake = await makeProduct(ctx.db, { type: 'finished', name: 'Tort2' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un2' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1.5, 'base')`,
      [cake, flour],
    );

    const before = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM stock_movements');
    const { header, lines } = await createNakladnoy({
      source: 'sale',
      productId: cake,
      qty: 4,
      actorUserId: null,
    });
    const after = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM stock_movements');

    // No stock movement created by nakladnoy (no Poster write, no stock change).
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));

    // Header + lines persisted; one audit row.
    const { rows: persistedLines } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM nakladnoy_lines WHERE nakladnoy_id = $1',
      [header.id],
    );
    expect(Number(persistedLines[0]!.n)).toBe(lines.length);

    const { rows: audit } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'nakladnoy' AND entity_id = $1`,
      [header.id],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('5c boundary: qty <= 0 is rejected', async () => {
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await expect(
      createNakladnoy({ source: 'sale', productId: cake, qty: 0, actorUserId: null }),
    ).rejects.toThrow();
  });
});
