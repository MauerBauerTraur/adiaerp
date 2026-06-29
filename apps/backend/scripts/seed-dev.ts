/**
 * Dev seed — minimal data so the frontend can log in and exercise M1-M3.
 *
 * LOCAL DEV ONLY. Idempotent: re-running upserts by natural keys (username,
 * name) and never duplicates rows.
 *
 * Seeds:
 *   - a `pm` super-admin user (login: pm / changeme123);
 *   - one location per chain link (raw_warehouse -> store) with a parent chain;
 *   - a manager user per non-pm location;
 *   - a handful of sample products (raw / semi / finished);
 *   - a starting stock row with min/max for the store, so the replenishment
 *     scan in M4 has data to act on;
 *   - a BOM for the finished product (Shokoladli tort = un + shakar + tuxum)
 *     so the engine can transition past CHECK_PRODUCTION_INPUT;
 *   - a starting raw-warehouse stock for every raw ingredient so the engine
 *     finds enough input to issue a production order.
 *
 * Usage:  npm run seed:dev    (from apps/backend)
 */
import bcrypt from 'bcryptjs';
import { query, closePool } from '../src/db/index.js';

/** Default password for every seeded account — CHANGE in any real environment. */
const SEED_PASSWORD = 'changeme123';
const BCRYPT_ROUNDS = 10;

type LocationType =
  | 'raw_warehouse'
  | 'production'
  | 'sex_storage'
  | 'supply' // deprecated synonym for sex_storage — kept for legacy fixtures
  | 'central_warehouse'
  | 'store';

type LocationSeed = {
  name: string;
  type: LocationType;
  parentName: string | null;
  managerRole:
    | 'raw_warehouse_manager'
    | 'production_manager'
    | 'supply_manager'
    | 'central_warehouse_manager'
    | 'store_manager';
};

// Chain (D7, 2026-05-28): raw warehouse -> production root -> 3 sex floors
// (Tort, Perojniy, Yarim Fabrika) -> 3 sex skladi (one per sex, type
// `sex_storage`) -> central warehouse -> store. Every sex has its own ready-
// batch buffer (`sex_storage`); the central warehouse parents to the Tort
// skladi so the M4 replenishment engine has an end-to-end path. The
// `supply_manager` role is reused as the manager of the sex_storage layer.
const LOCATIONS: LocationSeed[] = [
  { name: 'Mahsulotlar Ombori', type: 'raw_warehouse', parentName: null, managerRole: 'raw_warehouse_manager' },
  { name: 'Ishlab chiqarish sexi', type: 'production', parentName: 'Mahsulotlar Ombori', managerRole: 'production_manager' },
  { name: 'Tort sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Perojniy sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Yarim Fabrika sexi', type: 'production', parentName: 'Ishlab chiqarish sexi', managerRole: 'production_manager' },
  { name: 'Tort skladi', type: 'sex_storage', parentName: 'Tort sexi', managerRole: 'supply_manager' },
  { name: 'Perojniy skladi', type: 'sex_storage', parentName: 'Perojniy sexi', managerRole: 'supply_manager' },
  { name: 'Yarim Fabrika skladi', type: 'sex_storage', parentName: 'Yarim Fabrika sexi', managerRole: 'supply_manager' },
  { name: 'Markaziy Sklad', type: 'central_warehouse', parentName: 'Tort skladi', managerRole: 'central_warehouse_manager' },
  { name: 'Do\'kon 1', type: 'store', parentName: 'Markaziy Sklad', managerRole: 'store_manager' },
];

type ProductSeed = {
  name: string;
  type: 'raw' | 'semi' | 'finished';
  unit: 'kg' | 'l' | 'pcs';
  sku: string;
};

const PRODUCTS: ProductSeed[] = [
  { name: 'Un (oliy nav)', type: 'raw', unit: 'kg', sku: 'RAW-FLOUR' },
  { name: 'Shakar', type: 'raw', unit: 'kg', sku: 'RAW-SUGAR' },
  { name: 'Tuxum', type: 'raw', unit: 'pcs', sku: 'RAW-EGG' },
  { name: 'Biskvit zagotovka', type: 'semi', unit: 'pcs', sku: 'SEMI-SPONGE' },
  { name: 'Shokoladli tort', type: 'finished', unit: 'pcs', sku: 'FIN-CHOCO-CAKE' },
];

/** Insert a user if the username is free; return the user id either way. */
async function upsertUser(
  name: string,
  username: string,
  role: string,
  locationId: number | null,
): Promise<number> {
  // `username` is the sole login handle (email was removed entirely). It must
  // satisfy chk_users_username_format (`^[a-z0-9._-]{3,32}$`).
  const existing = await query<{ id: number }>('SELECT id FROM users WHERE username = $1', [
    username,
  ]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (name, username, password_hash, role, location_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, username, hash, role, locationId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert user ${username}.`);
  }
  return row.id;
}

/** Insert a location if its name is free; return the location id. */
async function upsertLocation(
  name: string,
  type: string,
  parentId: number | null,
): Promise<number> {
  const existing = await query<{ id: number }>('SELECT id FROM locations WHERE name = $1', [name]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO locations (name, type, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, type, parentId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert location ${name}.`);
  }
  return row.id;
}

/** Insert a product if its SKU is free; return the product id. */
async function upsertProduct(p: ProductSeed): Promise<number> {
  const existing = await query<{ id: number }>('SELECT id FROM products WHERE sku = $1', [p.sku]);
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, sku) VALUES ($1, $2, $3, $4) RETURNING id`,
    [p.name, p.type, p.unit, p.sku],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to insert product ${p.sku}.`);
  }
  return row.id;
}

async function main(): Promise<void> {
  console.log('[seed-dev] seeding development data...');

  // 1. PM super-admin (chain-wide, no location).
  const pmId = await upsertUser('Loyiha menejeri', 'pm', 'pm', null);
  console.log(`[seed-dev] pm user id=${pmId}  (login: pm / ${SEED_PASSWORD})`);

  // 2. Locations in chain order; each parent is created before its child.
  const locationIdByName = new Map<string, number>();
  for (const loc of LOCATIONS) {
    const parentId = loc.parentName === null ? null : locationIdByName.get(loc.parentName) ?? null;
    const id = await upsertLocation(loc.name, loc.type, parentId);
    locationIdByName.set(loc.name, id);
  }

  // 3. One manager user per location, then attach as the location's manager.
  //    The username (login) must be unique per location: roles like
  //    supply_manager are now shared across 3 supply nodes (Tort / Perojniy /
  //    Yarim Fabrika), so role-only slugs would collapse all three managers
  //    into the same user. The role-slug counters below keep the first
  //    location in a role on the bare slug (e.g. `supply-manager` stays mapped
  //    to "Tort skladi") and append `-2`, `-3`, ... for the rest. The slug
  //    matches chk_users_username_format (`^[a-z0-9._-]{3,32}$`).
  const roleSlugCount = new Map<string, number>();
  for (const loc of LOCATIONS) {
    const locId = locationIdByName.get(loc.name);
    if (locId === undefined) {
      continue;
    }
    const slug = loc.managerRole.replace(/_/g, '-');
    const seen = roleSlugCount.get(slug) ?? 0;
    roleSlugCount.set(slug, seen + 1);
    const username = seen === 0 ? slug : `${slug}-${seen + 1}`;
    const managerId = await upsertUser(`${loc.name} — boshliq`, username, loc.managerRole, locId);
    await query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [managerId, locId]);
    console.log(`[seed-dev]   manager login: ${username} / ${SEED_PASSWORD}  (${loc.name})`);
  }

  // 4. Products.
  const productIdBySku = new Map<string, number>();
  for (const p of PRODUCTS) {
    productIdBySku.set(p.sku, await upsertProduct(p));
  }

  // 5. A starting stock row for the store — qty below min so M4 has work to do.
  const storeId = locationIdByName.get("Do'kon 1");
  const cakeId = productIdBySku.get('FIN-CHOCO-CAKE');
  if (storeId !== undefined && cakeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 2, 5, 20)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [storeId, cakeId],
    );
  }

  // 6. BOM for Shokoladli tort. One cake = 0.5 kg un + 0.3 kg shakar + 2 tuxum.
  //    Without a BOM the engine stalls at CHECK_PRODUCTION_INPUT because it
  //    cannot compute the input requirement (AC4.1 zero-config goal).
  const flourId = productIdBySku.get('RAW-FLOUR');
  const sugarId = productIdBySku.get('RAW-SUGAR');
  const eggId = productIdBySku.get('RAW-EGG');
  if (cakeId !== undefined && flourId !== undefined && sugarId !== undefined && eggId !== undefined) {
    for (const [componentId, qtyPerUnit] of [
      [flourId, 0.5],
      [sugarId, 0.3],
      [eggId, 2],
    ] as const) {
      await query(
        `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, component_product_id, stage) DO NOTHING`,
        [cakeId, componentId, qtyPerUnit],
      );
    }
  }

  // 7. Raw-warehouse opening stock — enough for the engine to advance past
  //    CHECK_PRODUCTION_INPUT into CREATE_PRODUCTION_ORDER without a manual
  //    purchase round. 200 of each is generous for dev.
  const rawWhId = locationIdByName.get('Mahsulotlar Ombori');
  if (rawWhId !== undefined) {
    const rawSeed: [number | undefined, number][] = [
      [flourId, 200],
      [sugarId, 200],
      [eggId, 200],
    ];
    for (const [productId, qty] of rawSeed) {
      if (productId === undefined) continue;
      await query(
        `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT (location_id, product_id) DO NOTHING`,
        [rawWhId, productId, qty],
      );
    }
  }

  // 8. Sex-storage starter stock (canvas Bug 1 — migration 0020; renamed by D7).
  //    The three sex skladi are logical hand-off nodes (no Poster storage) so
  //    the leftover sync never seeds them. Without at least one stock row the
  //    ecosystem canvas renders them as "SKU yo'q" and downstream replenishment
  //    has no target. Yarim Fabrika skladi carries the semi (SEMI-SPONGE);
  //    Perojniy skladi carries the finished cake. qty=0 keeps the engine
  //    honest — it must produce.
  const yarimStorageId = locationIdByName.get('Yarim Fabrika skladi');
  const perojniyStorageId = locationIdByName.get('Perojniy skladi');
  const spongeId = productIdBySku.get('SEMI-SPONGE');
  if (yarimStorageId !== undefined && spongeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [yarimStorageId, spongeId],
    );
  }
  if (perojniyStorageId !== undefined && cakeId !== undefined) {
    await query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [perojniyStorageId, cakeId],
    );
  }

  console.log('[seed-dev] done.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[seed-dev] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
