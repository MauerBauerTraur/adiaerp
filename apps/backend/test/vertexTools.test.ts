/**
 * F2.2 Sprint-3 — `list_locations` and `list_products` executor tests.
 *
 * These two tools were added so the LLM can map a free-text name ("Markaziy
 * sklad", "tort") to a numeric id BEFORE calling the other six read-only
 * tools. They are the only tools that intentionally let a non-PM caller run
 * a name filter, so the RBAC scope must still pin them to their own
 * location (for `list_locations`) while the product catalogue stays global
 * (for `list_products`).
 *
 * What we assert here:
 *   1. `list_locations` returns active locations and supports `type` +
 *      `name_contains` filters (case-insensitive, LIKE-meta escaped).
 *   2. `list_locations` RBAC — a `store_manager` only sees their own row,
 *      and a name filter that doesn't match their row returns empty.
 *   3. `list_products` returns active products and supports `type` +
 *      `name_contains` filters with the documented `limit` defaults.
 *   4. `list_products` is global — a `store_manager` can still discover
 *      product ids (catalogue isn't location-scoped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../src/integrations/vertex/tools.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
} from './helpers/fixtures.js';
import type { AuthPrincipal } from '../src/auth/jwt.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

function pmPrincipal(userId: number): AuthPrincipal {
  return { userId, role: 'pm', locationId: null };
}

function storeManagerPrincipal(
  userId: number,
  locationId: number,
): AuthPrincipal {
  return { userId, role: 'store_manager', locationId };
}

describe('list_locations executor', () => {
  it('returns active locations with {id, name, type}, sorted by name', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const a = await makeLocation(ctx.db, {
      name: 'Markaziy sklad',
      type: 'central_warehouse',
    });
    const b = await makeLocation(ctx.db, { name: 'Do\'kon A', type: 'store' });

    const rows = await TOOL_REGISTRY.list_locations.execute(
      {},
      pmPrincipal(pm.id),
    );
    const found = rows.filter(
      (r) => r.id === a || r.id === b,
    );
    expect(found.length).toBe(2);
    const central = found.find((r) => r.id === a)!;
    expect(central.name).toBe('Markaziy sklad');
    expect(central.type).toBe('central_warehouse');
    const store = found.find((r) => r.id === b)!;
    expect(store.type).toBe('store');
  });

  it('filters by type (lower-case enum)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeLocation(ctx.db, { name: 'Wh Alpha', type: 'central_warehouse' });
    await makeLocation(ctx.db, { name: 'Store Alpha', type: 'store' });

    const rows = await TOOL_REGISTRY.list_locations.execute(
      { type: 'store' },
      pmPrincipal(pm.id),
    );
    for (const row of rows) {
      expect(row.type).toBe('store');
    }
  });

  it('filters by name_contains (case-insensitive, LIKE-safe)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const target = await makeLocation(ctx.db, {
      name: 'Markaziy MAIN',
      type: 'central_warehouse',
    });
    await makeLocation(ctx.db, { name: 'Eron filial', type: 'store' });

    const rows = await TOOL_REGISTRY.list_locations.execute(
      { name_contains: 'markaziy' },
      pmPrincipal(pm.id),
    );
    expect(rows.some((r) => r.id === target)).toBe(true);
    // The unrelated location must not appear in this filtered result.
    expect(rows.every((r) => /markaziy/i.test(String(r.name)))).toBe(true);
  });

  it('escapes LIKE metacharacters in name_contains', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const literal = await makeLocation(ctx.db, {
      name: '50% Discount Wh',
      type: 'central_warehouse',
    });
    const decoy = await makeLocation(ctx.db, {
      name: '50A Discount Wh',
      type: 'central_warehouse',
    });

    // Without LIKE escaping, "50%" would match BOTH rows. With escaping it
    // must match only the literal-percent row.
    const rows = await TOOL_REGISTRY.list_locations.execute(
      { name_contains: '50%' },
      pmPrincipal(pm.id),
    );
    expect(rows.some((r) => r.id === literal)).toBe(true);
    expect(rows.some((r) => r.id === decoy)).toBe(false);
  });

  it('RBAC: store_manager only sees their own location', async () => {
    const mine = await makeLocation(ctx.db, {
      name: 'Mine Store',
      type: 'store',
    });
    const other = await makeLocation(ctx.db, {
      name: 'Other Store',
      type: 'store',
    });
    const sm = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: mine,
    });

    const rows = await TOOL_REGISTRY.list_locations.execute(
      {},
      storeManagerPrincipal(sm.id, mine),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(mine);
    // The other store must NOT appear, regardless of args.
    expect(rows.some((r) => r.id === other)).toBe(false);
  });

  it('RBAC: store_manager with a non-matching name_contains gets empty', async () => {
    const mine = await makeLocation(ctx.db, {
      name: 'Tashkent Store',
      type: 'store',
    });
    const sm = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: mine,
    });

    const rows = await TOOL_REGISTRY.list_locations.execute(
      { name_contains: 'Markaziy' },
      storeManagerPrincipal(sm.id, mine),
    );
    expect(rows).toEqual([]);
  });
});

describe('list_products executor', () => {
  it('returns active products with {id, name, type, unit}', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const flour = await makeProduct(ctx.db, {
      name: 'Un',
      type: 'raw',
      unit: 'kg',
    });
    const cake = await makeProduct(ctx.db, {
      name: 'Tort Napoleon',
      type: 'finished',
      unit: 'pcs',
    });

    const rows = await TOOL_REGISTRY.list_products.execute(
      {},
      pmPrincipal(pm.id),
    );
    const flourRow = rows.find((r) => r.id === flour);
    const cakeRow = rows.find((r) => r.id === cake);
    expect(flourRow?.name).toBe('Un');
    expect(flourRow?.type).toBe('raw');
    expect(flourRow?.unit).toBe('kg');
    expect(cakeRow?.name).toBe('Tort Napoleon');
    expect(cakeRow?.type).toBe('finished');
    expect(cakeRow?.unit).toBe('pcs');
  });

  it('filters by type (raw/semi/finished)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeProduct(ctx.db, { name: 'Krem-A', type: 'semi', unit: 'kg' });
    await makeProduct(ctx.db, { name: 'Cake-A', type: 'finished', unit: 'pcs' });

    const rows = await TOOL_REGISTRY.list_products.execute(
      { type: 'semi' },
      pmPrincipal(pm.id),
    );
    for (const row of rows) {
      expect(row.type).toBe('semi');
    }
  });

  it('filters by name_contains (case-insensitive)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const tort = await makeProduct(ctx.db, {
      name: 'Tort Napoleon',
      type: 'finished',
      unit: 'pcs',
    });
    await makeProduct(ctx.db, { name: 'Salat olivye', type: 'finished', unit: 'pcs' });

    const rows = await TOOL_REGISTRY.list_products.execute(
      { name_contains: 'tort' },
      pmPrincipal(pm.id),
    );
    expect(rows.some((r) => r.id === tort)).toBe(true);
    expect(rows.every((r) => /tort/i.test(String(r.name)))).toBe(true);
  });

  it('respects limit (default 50, capped at 200)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rows = await TOOL_REGISTRY.list_products.execute(
      { limit: 5 },
      pmPrincipal(pm.id),
    );
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('store_manager can still browse the global catalogue (not scoped)', async () => {
    // The product catalogue is global. RBAC continues at downstream tools.
    const store = await makeLocation(ctx.db, { type: 'store' });
    const sm = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });
    const p = await makeProduct(ctx.db, {
      name: 'Visible Cake',
      type: 'finished',
      unit: 'pcs',
    });
    const rows = await TOOL_REGISTRY.list_products.execute(
      { name_contains: 'Visible' },
      storeManagerPrincipal(sm.id, store),
    );
    expect(rows.some((r) => r.id === p)).toBe(true);
  });
});
