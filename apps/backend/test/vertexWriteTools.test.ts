/**
 * F3.2 — Write-tool registry unit tests.
 *
 * Focused on the per-tool argument validation, RBAC pre-check, and the
 * summary-builder pulling human-friendly names from the DB. The end-to-end
 * "model proposes → confirm → DB mutation" flow lives in
 * `routes.assistantActions.test.ts`; this file is fast unit coverage with
 * no Vertex mock and no Express layer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import {
  WRITE_TOOL_NAMES,
  WRITE_TOOL_REGISTRY,
  getWriteTool,
  isWriteToolName,
  writeToolDeclarations,
} from '../src/integrations/vertex/tools/write.js';
import type { AuthPrincipal } from '../src/auth/jwt.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

function pmPrincipal(): AuthPrincipal {
  return { userId: 1, role: 'pm', locationId: null };
}
function storeManagerPrincipal(locationId: number): AuthPrincipal {
  return { userId: 2, role: 'store_manager', locationId };
}

describe('write-tool registry — shape', () => {
  it('exposes all 7 write tool names', () => {
    expect(WRITE_TOOL_NAMES).toHaveLength(7);
    expect(new Set(WRITE_TOOL_NAMES)).toEqual(
      new Set([
        'transfer_stock',
        'create_replenishment_request',
        'mark_production_order_done',
        'approve_purchase_order',
        'update_minmax',
        'create_production_order',
        'adjust_stock',
      ]),
    );
  });

  it('writeToolDeclarations() returns one FunctionDeclaration per tool', () => {
    const decls = writeToolDeclarations();
    expect(decls).toHaveLength(WRITE_TOOL_NAMES.length);
    for (const d of decls) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.parameters).toBeDefined();
    }
  });

  it('isWriteToolName + getWriteTool behave correctly', () => {
    expect(isWriteToolName('transfer_stock')).toBe(true);
    expect(isWriteToolName('get_stock')).toBe(false);
    expect(getWriteTool('transfer_stock')).toBeDefined();
    expect(getWriteTool('not_a_tool')).toBeUndefined();
  });
});

describe('transfer_stock — validation', () => {
  const tool = WRITE_TOOL_REGISTRY.transfer_stock;

  it('rejects equal from/to', () => {
    expect(() =>
      tool.validateArgs({ product_id: 1, from_location_id: 7, to_location_id: 7, qty: 1 }),
    ).toThrow();
  });
  it('rejects qty <= 0', () => {
    expect(() =>
      tool.validateArgs({ product_id: 1, from_location_id: 1, to_location_id: 2, qty: 0 }),
    ).toThrow();
  });
  it('coerces numeric strings safely', () => {
    const args = tool.validateArgs({
      product_id: '5',
      from_location_id: '7',
      to_location_id: '8',
      qty: '3',
    });
    expect(args).toMatchObject({ product_id: 5, from_location_id: 7, to_location_id: 8, qty: 3 });
  });
});

describe('transfer_stock — RBAC pre-check', () => {
  const tool = WRITE_TOOL_REGISTRY.transfer_stock;

  it('PM is allowed regardless of from_location', async () => {
    await withTransaction(async (tx) => {
      const decision = await tool.canExecute(
        { product_id: 1, from_location_id: 99, to_location_id: 100, qty: 1, note: null },
        pmPrincipal(),
        tx,
      );
      expect(decision).toBe('allowed');
    });
  });

  it('store_manager of the SOURCE location is allowed', async () => {
    await withTransaction(async (tx) => {
      const decision = await tool.canExecute(
        { product_id: 1, from_location_id: 7, to_location_id: 8, qty: 1, note: null },
        storeManagerPrincipal(7),
        tx,
      );
      expect(decision).toBe('allowed');
    });
  });

  it('store_manager of ANOTHER location is denied with forbidden_for_role', async () => {
    await withTransaction(async (tx) => {
      const decision = await tool.canExecute(
        { product_id: 1, from_location_id: 7, to_location_id: 8, qty: 1, note: null },
        storeManagerPrincipal(99),
        tx,
      );
      expect(decision).not.toBe('allowed');
      if (decision !== 'allowed') {
        expect(decision.code).toBe('forbidden_for_role');
      }
    });
  });
});

describe('transfer_stock — summary builder', () => {
  it('renders "From → To: qty unit Product" using DB names', async () => {
    const from = await makeLocation(ctx.db, { name: 'Markaziy sklad', type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { name: 'Filial-2', type: 'store' });
    const product = await makeProduct(ctx.db, { name: 'Tort Napoleon', unit: 'pcs' });

    const tool = WRITE_TOOL_REGISTRY.transfer_stock;
    const summary = await withTransaction((tx) =>
      tool.summarize(
        { product_id: product, from_location_id: from, to_location_id: to, qty: 5, note: null },
        pmPrincipal(),
        tx,
      ),
    );
    expect(summary).toContain('Markaziy sklad');
    expect(summary).toContain('Filial-2');
    expect(summary).toContain('5');
    expect(summary).toContain('Tort Napoleon');
  });
});

describe('approve_purchase_order — RBAC matrix', () => {
  const tool = WRITE_TOOL_REGISTRY.approve_purchase_order;

  it('manager step requires supply_manager or PM', async () => {
    await withTransaction(async (tx) => {
      const ok = await tool.canExecute(
        { purchase_order_id: 1, step: 'manager' },
        { userId: 1, role: 'supply_manager', locationId: null },
        tx,
      );
      expect(ok).toBe('allowed');
      const denied = await tool.canExecute(
        { purchase_order_id: 1, step: 'manager' },
        { userId: 1, role: 'store_manager', locationId: 1 },
        tx,
      );
      expect(denied).not.toBe('allowed');
    });
  });

  it('keeper step requires raw_warehouse_manager or PM', async () => {
    await withTransaction(async (tx) => {
      const ok = await tool.canExecute(
        { purchase_order_id: 1, step: 'keeper' },
        { userId: 1, role: 'raw_warehouse_manager', locationId: null },
        tx,
      );
      expect(ok).toBe('allowed');
      const denied = await tool.canExecute(
        { purchase_order_id: 1, step: 'keeper' },
        { userId: 1, role: 'supply_manager', locationId: 1 },
        tx,
      );
      expect(denied).not.toBe('allowed');
    });
  });
});

describe('update_minmax — execute path', () => {
  it('upserts stock with new thresholds and writes an audit row', async () => {
    const loc = await makeLocation(ctx.db, { name: 'Filial-5', type: 'store' });
    const product = await makeProduct(ctx.db, { name: 'Sut', unit: 'l' });
    const user = await makeUser(ctx.db, { role: 'pm' });

    const tool = WRITE_TOOL_REGISTRY.update_minmax;
    const args = tool.validateArgs({
      product_id: product,
      location_id: loc,
      min_level: 12,
      max_level: 40,
      mode: 'manual',
    });
    const result = await withTransaction((tx) =>
      tool.execute(
        args,
        { userId: user.id, role: 'pm', locationId: null },
        user.id,
        tx,
      ),
    );
    expect(result).toMatchObject({
      product_id: product,
      location_id: loc,
      min_level: 12,
      max_level: 40,
    });

    const { rows } = await ctx.db.query<{ min_level: string; max_level: string; minmax_mode: string }>(
      `SELECT min_level, max_level, minmax_mode FROM stock
        WHERE location_id = $1 AND product_id = $2`,
      [loc, product],
    );
    expect(Number(rows[0]?.min_level)).toBe(12);
    expect(Number(rows[0]?.max_level)).toBe(40);
    expect(rows[0]?.minmax_mode).toBe('manual');

    const audit = await ctx.db.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity = 'stock' AND action = 'stock.minmax_update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe('stock.minmax_update');
  });

  it('rejects max < min at validation time', () => {
    const tool = WRITE_TOOL_REGISTRY.update_minmax;
    expect(() =>
      tool.validateArgs({
        product_id: 1,
        location_id: 1,
        min_level: 10,
        max_level: 5,
      }),
    ).toThrow();
  });
});

describe('mark_production_order_done — pre-check finds order', () => {
  it('returns not_found when production_order_id is absent', async () => {
    const tool = WRITE_TOOL_REGISTRY.mark_production_order_done;
    await withTransaction(async (tx) => {
      const decision = await tool.canExecute(
        { production_order_id: 999999 },
        pmPrincipal(),
        tx,
      );
      expect(decision).not.toBe('allowed');
      if (decision !== 'allowed') {
        expect(decision.code).toBe('not_found');
      }
    });
  });
});

describe('create_replenishment_request — pre-check', () => {
  it('store_manager limited to own location', async () => {
    const tool = WRITE_TOOL_REGISTRY.create_replenishment_request;
    await withTransaction(async (tx) => {
      const decision = await tool.canExecute(
        { product_id: 1, requester_location_id: 5, qty_needed: 10 },
        storeManagerPrincipal(99),
        tx,
      );
      expect(decision).not.toBe('allowed');
    });
  });
});

// Touch setStock to keep imports tidy (avoids "unused" lint warnings for
// helper used implicitly when extending coverage later).
void setStock;
