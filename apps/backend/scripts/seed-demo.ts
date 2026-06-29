/**
 * Demo seed — fabricates "today's operational story" so the executive
 * dashboard renders non-zero cards for every supply-chain link.
 *
 * The base `seed-dev.ts` lays down locations, users, products, BOM and the
 * starting stock. Poster sync continues to keep `sales` and central-warehouse
 * `stock` alive. The cards that stay flat are the operational ones:
 *   - raw warehouse below-min + open purchases + today's receipts;
 *   - production: active / overdue / done-today orders + I/O movements;
 *   - supply: open replenishment requests + today's shipments;
 *   - central warehouse: below-min positions (sync errors come from Poster);
 *   - stores: open replenishment requests + transit transfers.
 *
 * This script writes only those operational rows and is fully idempotent:
 * every fabricated row is tagged with a `'demo-seed:*'` marker (in `note`
 * for orders/movements/requests) so a second run no-ops.
 *
 * Usage:  npm run seed:demo -w @adia/backend
 *
 * Constraints honoured:
 *   - one open replenishment_request per (product, requester_location);
 *   - stock.qty stays >= 0 (no negative writes anywhere);
 *   - every stock_movement happens inside a single transaction together
 *     with the source decrement, the destination upsert and an audit row;
 *   - we never invent new locations / products / users.
 */
import { query, withTransaction, closePool } from '../src/db/index.js';
import type { TxClient } from '../src/db/index.js';

const PM_USER_ID = 1;

// Every fabricated row carries this prefix in `note` so we can re-find it
// on a re-run and skip duplicating.
const MARKER = 'demo-seed';

type Location = { id: number; name: string; type: string };
type Product = { id: number; name: string; sku: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findLocations(): Promise<{
  rawWh: Location | null;
  productionMain: Location | null;
  productionSecondary: Location[];
  supply: Location | null;
  centralWarehouses: Location[];
  stores: Location[];
}> {
  const { rows } = await query<Location>(
    `SELECT id, name, type FROM locations ORDER BY id ASC`,
  );
  const by = (t: string) => rows.filter((r) => r.type === t);
  const prod = by('production');
  return {
    rawWh: by('raw_warehouse')[0] ?? null,
    productionMain: prod[0] ?? null,
    productionSecondary: prod.slice(1),
    supply: by('supply')[0] ?? null,
    centralWarehouses: by('central_warehouse'),
    stores: by('store'),
  };
}

async function findProductBySku(sku: string): Promise<Product | null> {
  const { rows } = await query<Product>(
    `SELECT id, name, sku FROM products WHERE sku = $1 LIMIT 1`,
    [sku],
  );
  return rows[0] ?? null;
}

async function findAnyProductByExactName(name: string): Promise<Product | null> {
  const { rows } = await query<Product>(
    `SELECT id, name, sku FROM products WHERE name = $1 LIMIT 1`,
    [name],
  );
  return rows[0] ?? null;
}

/** Pull a few finished/semi products that already have some stock somewhere — the */
/** kind of thing a supply / store would actually re-order. */
async function findReorderableProducts(limit: number): Promise<Product[]> {
  const { rows } = await query<Product>(
    `SELECT p.id, p.name, p.sku
       FROM products p
       JOIN stock s ON s.product_id = p.id
      WHERE p.type IN ('finished','semi') AND s.qty > 0
      GROUP BY p.id, p.name, p.sku
      ORDER BY MAX(s.qty) DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Atomic transfer: decrement source (if any), upsert destination, write the */
/** movement and an audit row. Throws if source qty is insufficient. */
async function transferAtomic(
  tx: TxClient,
  args: {
    productId: number;
    fromLocationId: number | null;
    toLocationId: number | null;
    qty: number;
    reason: 'sale' | 'production_input' | 'production_output' | 'transfer' | 'purchase' | 'adjust';
    note: string;
    minutesAgo: number;
    replenishmentId?: number | null;
    productionOrderId?: number | null;
    purchaseOrderId?: number | null;
  },
): Promise<number> {
  const createdAtExpr = `now() - interval '${Math.max(0, args.minutesAgo)} minutes'`;

  // 1. Decrement source — guarded by `qty >= :qty` so we never go negative.
  if (args.fromLocationId !== null) {
    const dec = await tx.query<{ qty: string }>(
      `UPDATE stock
          SET qty = qty - $3
        WHERE location_id = $1 AND product_id = $2 AND qty >= $3
        RETURNING qty`,
      [args.fromLocationId, args.productId, args.qty],
    );
    if (dec.rowCount === 0) {
      // Top up source just enough to satisfy this movement — demo only.
      await tx.query(
        `INSERT INTO stock (location_id, product_id, qty)
              VALUES ($1, $2, $3)
         ON CONFLICT (location_id, product_id)
         DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
        [args.fromLocationId, args.productId, args.qty],
      );
      await tx.query(
        `UPDATE stock SET qty = qty - $3
          WHERE location_id = $1 AND product_id = $2`,
        [args.fromLocationId, args.productId, args.qty],
      );
    }
  }

  // 2. Increment destination via upsert.
  if (args.toLocationId !== null) {
    await tx.query(
      `INSERT INTO stock (location_id, product_id, qty)
            VALUES ($1, $2, $3)
       ON CONFLICT (location_id, product_id)
       DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
      [args.toLocationId, args.productId, args.qty],
    );
  }

  // 3. Append the movement ledger row.
  const movement = await tx.query<{ id: number }>(
    `INSERT INTO stock_movements
       (product_id, from_location_id, to_location_id, qty, reason,
        replenishment_id, production_order_id, purchase_order_id,
        note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${createdAtExpr})
     RETURNING id`,
    [
      args.productId,
      args.fromLocationId,
      args.toLocationId,
      args.qty,
      args.reason,
      args.replenishmentId ?? null,
      args.productionOrderId ?? null,
      args.purchaseOrderId ?? null,
      args.note,
      PM_USER_ID,
    ],
  );

  // 4. Audit log.
  const movementId = movement.rows[0]?.id;
  if (movementId === undefined) {
    throw new Error('Failed to insert stock_movement');
  }
  await tx.query(
    `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      PM_USER_ID,
      'stock_movement.create',
      'stock_movements',
      movementId,
      JSON.stringify({
        reason: args.reason,
        qty: args.qty,
        from: args.fromLocationId,
        to: args.toLocationId,
        note: args.note,
      }),
    ],
  );

  return movementId;
}

/** Return true if any row already matches `note = $1` in `table`. */
async function noteExists(table: string, note: string): Promise<boolean> {
  // Table name is hard-coded in callers — safe (no user input).
  const { rowCount } = await query(`SELECT 1 FROM ${table} WHERE note = $1 LIMIT 1`, [note]);
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// 1. Raw warehouse: 3 below-min raw products + 2 open POs + today's purchase
// ---------------------------------------------------------------------------

async function seedRawWarehouse(rawWh: Location): Promise<void> {
  console.log('[seed-demo] raw warehouse: pulling 3 raw products below min...');

  const rawSkus = ['RAW-FLOUR', 'RAW-SUGAR', 'RAW-EGG'];
  const rawProducts: Product[] = [];
  for (const sku of rawSkus) {
    const p = await findProductBySku(sku);
    if (p) rawProducts.push(p);
  }
  if (rawProducts.length === 0) {
    console.warn('[seed-demo] raw warehouse: no canonical raw products found, skipping');
    return;
  }

  // Force qty below min_level so the dashboard "below min" KPI lights up.
  // We don't touch min/max thresholds beyond making sure they're set; we drop
  // qty to (min - 1) clamped at zero.
  for (const p of rawProducts) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
            VALUES ($1, $2, 0, 100, 500)
       ON CONFLICT (location_id, product_id) DO UPDATE
         SET min_level = GREATEST(stock.min_level, 100),
             max_level = GREATEST(stock.max_level, 500),
             qty = GREATEST(stock.min_level - 1, 0)`,
      [rawWh.id, p.id],
    );
  }
  console.log(`[seed-demo]   ${rawProducts.length} raw products now below min at ${rawWh.name}`);

  // 2 approved purchase orders awaiting receipt (received_movement_id IS NULL).
  for (let i = 0; i < Math.min(2, rawProducts.length); i++) {
    const note = `${MARKER}:po:raw:${i + 1}`;
    if (await noteExists('purchase_orders', note)) continue;
    const product = rawProducts[i]!;
    await query(
      `INSERT INTO purchase_orders
         (product_id, qty, target_location_id, status,
          manager_approved_by, manager_approved_at,
          keeper_approved_by, keeper_approved_at,
          note, created_by, created_at)
       VALUES ($1, $2, $3, 'approved',
               $4, now() - interval '6 hours',
               $4, now() - interval '4 hours',
               $5, $4, now() - interval '1 day')`,
      [product.id, 250, rawWh.id, PM_USER_ID, note],
    );
  }
  console.log('[seed-demo]   2 approved purchase orders awaiting delivery');

  // Today's 2 `purchase` movements into raw warehouse (received goods).
  for (let i = 0; i < 2; i++) {
    const note = `${MARKER}:mov:raw-purchase:${i + 1}`;
    if (await noteExists('stock_movements', note)) continue;
    const product = rawProducts[i % rawProducts.length]!;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: product.id,
        fromLocationId: null,
        toLocationId: rawWh.id,
        qty: 80,
        reason: 'purchase',
        note,
        minutesAgo: 60 * (2 + i),
      }),
    );
  }
  console.log('[seed-demo]   2 purchase movements posted (today)');
}

// ---------------------------------------------------------------------------
// 2. Production: orders in various states + I/O movements
// ---------------------------------------------------------------------------

async function seedProduction(
  rawWh: Location,
  productionMain: Location,
  supply: Location | null,
): Promise<void> {
  console.log('[seed-demo] production: 3 in-progress + 1 overdue + 2 done-today...');

  // Pick a finished product the BOM already covers — Shokoladli tort by default,
  // else fall back to any finished product.
  let finished = await findProductBySku('FIN-CHOCO-CAKE');
  if (!finished) {
    const { rows } = await query<Product>(
      `SELECT id, name, sku FROM products WHERE type='finished' LIMIT 1`,
    );
    finished = rows[0] ?? null;
  }
  if (!finished) {
    console.warn('[seed-demo] production: no finished product, skipping');
    return;
  }

  const targetLocId = supply?.id ?? null;
  const tomorrow = `now()::date + interval '1 day'`;
  const yesterday = `now()::date - interval '1 day'`;

  // 3 in_progress, deadline = tomorrow.
  for (let i = 0; i < 3; i++) {
    const note = `${MARKER}:prod:in-progress:${i + 1}`;
    if (await noteExists('production_orders', note)) continue;
    await query(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, deadline, status, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, (${tomorrow})::date, 'in_progress', $5, $6, now() - interval '4 hours')`,
      [finished.id, 10 + i * 2, productionMain.id, targetLocId, note, PM_USER_ID],
    );
  }

  // 1 in_progress, deadline = yesterday (overdue).
  {
    const note = `${MARKER}:prod:overdue:1`;
    if (!(await noteExists('production_orders', note))) {
      await query(
        `INSERT INTO production_orders
           (product_id, qty, location_id, target_location_id, deadline, status, note, created_by, created_at)
         VALUES ($1, 15, $2, $3, (${yesterday})::date, 'in_progress', $4, $5, now() - interval '2 days')`,
        [finished.id, productionMain.id, targetLocId, note, PM_USER_ID],
      );
    }
  }

  // 2 done today.
  const doneIds: number[] = [];
  for (let i = 0; i < 2; i++) {
    const note = `${MARKER}:prod:done:${i + 1}`;
    const existing = await query<{ id: number }>(
      `SELECT id FROM production_orders WHERE note = $1 LIMIT 1`,
      [note],
    );
    if (existing.rows[0]) {
      doneIds.push(existing.rows[0].id);
      continue;
    }
    const ins = await query<{ id: number }>(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, deadline, status, note, created_by, created_at, done_at)
       VALUES ($1, $2, $3, $4, now()::date, 'done', $5, $6, now() - interval '6 hours', now() - interval '1 hour')
       RETURNING id`,
      [finished.id, 8 + i, productionMain.id, targetLocId, note, PM_USER_ID],
    );
    if (ins.rows[0]) doneIds.push(ins.rows[0].id);
  }
  console.log(`[seed-demo]   production orders: 3 active + 1 overdue + ${doneIds.length} done-today`);

  // Today's 2 production_input movements (raw -> production_main).
  const flour = await findProductBySku('RAW-FLOUR');
  const sugar = await findProductBySku('RAW-SUGAR');
  const rawInputs: Product[] = [flour, sugar].filter((p): p is Product => p !== null);
  for (let i = 0; i < rawInputs.length; i++) {
    const note = `${MARKER}:mov:prod-input:${i + 1}`;
    if (await noteExists('stock_movements', note)) continue;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: rawInputs[i]!.id,
        fromLocationId: rawWh.id,
        toLocationId: productionMain.id,
        qty: 5,
        reason: 'production_input',
        note,
        minutesAgo: 90 + i * 20,
      }),
    );
  }

  // 2 production_output movements (production -> supply, if supply exists,
  // else stays in production location which is also fine for the KPI count).
  const outputTo = supply?.id ?? null;
  for (let i = 0; i < doneIds.length; i++) {
    const note = `${MARKER}:mov:prod-output:${i + 1}`;
    if (await noteExists('stock_movements', note)) continue;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: finished.id,
        fromLocationId: productionMain.id,
        toLocationId: outputTo,
        qty: 8,
        reason: 'production_output',
        note,
        minutesAgo: 30 + i * 15,
        productionOrderId: doneIds[i] ?? null,
      }),
    );
  }
  console.log('[seed-demo]   production movements posted (input + output)');
}

// ---------------------------------------------------------------------------
// 3. Supply: open replenishment requests + today's shipment & receive
// ---------------------------------------------------------------------------

async function seedSupply(
  supply: Location,
  productionMain: Location,
  stores: Location[],
): Promise<void> {
  console.log('[seed-demo] supply: open replenishment requests + shipments...');

  // Pull 3 reorderable products to attach to requests.
  const products = await findReorderableProducts(3);
  if (products.length === 0) {
    console.warn('[seed-demo] supply: no reorderable products available, skipping');
    return;
  }

  // 3 open replenishment_requests routed THROUGH supply (target = supply).
  // Statuses we use must exist in the enum: NEW, CHECK_PRODUCTION_INPUT,
  // CREATE_PRODUCTION_ORDER, PRODUCING, DONE_TO_WAREHOUSE. We pick three
  // diverse open ones. The unique partial index forbids two open requests
  // for the same (product, requester_location), so each request uses a
  // distinct requester store.
  const statuses: Array<'NEW' | 'CHECK_PRODUCTION_INPUT' | 'PRODUCING'> = [
    'NEW',
    'CHECK_PRODUCTION_INPUT',
    'PRODUCING',
  ];
  for (let i = 0; i < Math.min(3, products.length, stores.length); i++) {
    const note = `${MARKER}:rep:supply:${i + 1}`;
    if (await noteExists('replenishment_requests', note)) continue;
    const requester = stores[i % stores.length]!;
    await query(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, target_location_id, qty_needed,
          status, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5::replenishment_status, $6, $7, now() - interval '3 hours')
       ON CONFLICT DO NOTHING`,
      [products[i]!.id, requester.id, supply.id, 10, statuses[i]!, note, PM_USER_ID],
    );
  }
  console.log('[seed-demo]   3 open replenishment_requests created (supply target)');

  // 2 production_output movements (production -> supply) — today.
  for (let i = 0; i < Math.min(2, products.length); i++) {
    const note = `${MARKER}:mov:supply-in:${i + 1}`;
    if (await noteExists('stock_movements', note)) continue;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: products[i]!.id,
        fromLocationId: productionMain.id,
        toLocationId: supply.id,
        qty: 12,
        reason: 'production_output',
        note,
        minutesAgo: 75 + i * 30,
      }),
    );
  }

  // 1-2 transfer movements (supply -> store) — today.
  for (let i = 0; i < Math.min(2, products.length, stores.length); i++) {
    const note = `${MARKER}:mov:supply-out:${i + 1}`;
    if (await noteExists('stock_movements', note)) continue;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: products[i]!.id,
        fromLocationId: supply.id,
        toLocationId: stores[i]!.id,
        qty: 4,
        reason: 'transfer',
        note,
        minutesAgo: 25 + i * 15,
      }),
    );
  }
  console.log('[seed-demo]   supply movements posted (in from production + out to stores)');
}

// ---------------------------------------------------------------------------
// 4. Central warehouse: 2 below-min positions
// ---------------------------------------------------------------------------

async function seedCentralWarehouseBelowMin(centrals: Location[]): Promise<void> {
  console.log('[seed-demo] central warehouse: forcing 2 below-min positions...');

  if (centrals.length === 0) {
    console.warn('[seed-demo] central warehouse: none exist, skipping');
    return;
  }

  // Find 2 existing stock rows in any central warehouse that currently HAS
  // qty > 0 — we'll raise their min_level above qty (without touching qty)
  // so the "below min" KPI lights up without inventing negative stock.
  // We tag the affected stock with a sentinel via a separate audit row.
  const { rows } = await query<{ location_id: number; product_id: number; qty: string }>(
    `SELECT s.location_id, s.product_id, s.qty
       FROM stock s
       JOIN locations l ON l.id = s.location_id
      WHERE l.type = 'central_warehouse'
        AND s.qty > 0
        AND s.qty < 1000
        AND s.min_level = 0
      ORDER BY s.qty ASC
      LIMIT 2`,
  );
  if (rows.length === 0) {
    console.warn('[seed-demo] central warehouse: no candidate stock rows, skipping');
    return;
  }
  for (const r of rows) {
    const qtyNum = Number(r.qty);
    const newMin = Math.ceil(qtyNum + 10);
    const newMax = Math.max(newMin * 2, 50);
    await query(
      `UPDATE stock
          SET min_level = $3,
              max_level = $4
        WHERE location_id = $1 AND product_id = $2
          AND min_level = 0`,
      [r.location_id, r.product_id, newMin, newMax],
    );
    await query(
      `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, payload)
       VALUES ($1, 'stock.minmax_demo_seed', 'stock', NULL, $2::jsonb)`,
      [
        PM_USER_ID,
        JSON.stringify({
          marker: MARKER,
          location_id: r.location_id,
          product_id: r.product_id,
          new_min: newMin,
          new_max: newMax,
        }),
      ],
    );
  }
  console.log(`[seed-demo]   ${rows.length} central-warehouse stock rows now below min`);
}

// ---------------------------------------------------------------------------
// 5. Stores: 1-2 open replenishment requests + 1-2 transit transfers
// ---------------------------------------------------------------------------

async function seedStores(
  stores: Location[],
  supply: Location | null,
  centrals: Location[],
): Promise<void> {
  console.log('[seed-demo] stores: open replenishments + transit transfers...');

  if (stores.length === 0) {
    console.warn('[seed-demo] stores: none exist, skipping');
    return;
  }
  const fromLoc = supply ?? centrals[0] ?? null;
  if (!fromLoc) {
    console.warn('[seed-demo] stores: no source location for transfers, skipping');
    return;
  }

  // Pick 2 reorderable products distinct from the supply set if possible.
  const products = await findReorderableProducts(8);
  // Use the LAST 2 in the list — `seedSupply` used the first 3.
  const storeProducts = products.slice(3, 5).length >= 2
    ? products.slice(3, 5)
    : products.slice(0, 2);
  if (storeProducts.length === 0) {
    console.warn('[seed-demo] stores: no reorderable products, skipping');
    return;
  }

  // Open replenishment requests originating from stores (requester = store).
  // The partial unique index allows only one open per (product, requester),
  // so we pair distinct products with distinct stores.
  for (let i = 0; i < Math.min(2, storeProducts.length, stores.length); i++) {
    const note = `${MARKER}:rep:store:${i + 1}`;
    if (await noteExists('replenishment_requests', note)) continue;
    const requester = stores[i]!;
    await query(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, target_location_id, qty_needed,
          status, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'NEW'::replenishment_status, $5, $6, now() - interval '2 hours')
       ON CONFLICT DO NOTHING`,
      [storeProducts[i]!.id, requester.id, fromLoc.id, 6, note, PM_USER_ID],
    );
  }
  console.log('[seed-demo]   store open replenishment_requests created');

  // Transit transfers (to_location IN stores, replenishment_id linked) — today.
  // Re-find the request IDs we just created (or that already existed).
  for (let i = 0; i < Math.min(2, storeProducts.length, stores.length); i++) {
    const repNote = `${MARKER}:rep:store:${i + 1}`;
    const movNote = `${MARKER}:mov:store-transit:${i + 1}`;
    if (await noteExists('stock_movements', movNote)) continue;
    const { rows: repRows } = await query<{ id: number }>(
      `SELECT id FROM replenishment_requests WHERE note = $1 LIMIT 1`,
      [repNote],
    );
    const repId = repRows[0]?.id ?? null;
    await withTransaction((tx) =>
      transferAtomic(tx, {
        productId: storeProducts[i]!.id,
        fromLocationId: fromLoc.id,
        toLocationId: stores[i]!.id,
        qty: 3,
        reason: 'transfer',
        note: movNote,
        minutesAgo: 45 + i * 10,
        replenishmentId: repId,
      }),
    );
  }
  console.log('[seed-demo]   store transit transfers posted');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[seed-demo] starting idempotent demo seed...');

  const locs = await findLocations();
  if (!locs.rawWh) {
    throw new Error('No raw_warehouse location. Run `npm run seed:dev` first.');
  }
  if (!locs.productionMain) {
    throw new Error('No production location. Run `npm run seed:dev` first.');
  }

  // PM user must exist.
  const pm = await query<{ id: number }>(`SELECT id FROM users WHERE id = $1`, [PM_USER_ID]);
  if (pm.rowCount === 0) {
    throw new Error(`Expected PM user id=${PM_USER_ID}. Run \`npm run seed:dev\` first.`);
  }

  await seedRawWarehouse(locs.rawWh);
  await seedProduction(locs.rawWh, locs.productionMain, locs.supply);
  if (locs.supply) {
    await seedSupply(locs.supply, locs.productionMain, locs.stores);
  } else {
    console.warn('[seed-demo] no supply location — supply block skipped');
  }
  await seedCentralWarehouseBelowMin(locs.centralWarehouses);
  await seedStores(locs.stores, locs.supply, locs.centralWarehouses);

  console.log('[seed-demo] done.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[seed-demo] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
