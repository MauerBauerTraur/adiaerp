/**
 * EPIC 5 / ADR-0016 — Telegram dispatch for the production dialog.
 *
 *   - parseCallbackData accepts the 4-segment `dlg:pdlg:<id>:<optCode>` form.
 *   - dlg:pdlg:<id>:1 ("ready") answers + resolves the dialog (RBAC: own sex).
 *   - a foreign production manager is denied (rbac).
 *   - dlgx:pdlg:<id> cancels the dialog.
 *   - the web route and the telegram callback produce the SAME outcome
 *     (channel-agnostic — both go through `answerDialog`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  dispatchCallback,
  parseCallbackData,
  DIALOG_CODE_BY_OPTION,
  type CallbackPrincipal,
} from '../src/integrations/telegram/dispatch.js';
import { createDialogForOrder, getDialog } from '../src/services/productionDialog.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function sexWithDialog(): Promise<{ production: number; dialogId: number; userId: number }> {
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
  const krem = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1,$2,1,'decoration'::recipe_stage), ($1,$3,2,'decoration'::recipe_stage)`,
    [cake, zagatovka, krem],
  );
  await setStock(ctx.db, { locationId: sexStorage, productId: zagatovka, qty: 20 });
  await setStock(ctx.db, { locationId: sexStorage, productId: krem, qty: 100 });
  const u = await makeUser(ctx.db, { role: 'production_manager', locationId: production });
  const session = await createDialogForOrder({
    productId: cake, locationId: production, qtyOrdered: 10,
    assignedUserId: u.id, actorUserId: u.id,
  });
  return { production, dialogId: session!.id, userId: u.id };
}

describe('parseCallbackData — dialog 4-segment form', () => {
  it('parses dlg:pdlg:<id>:<code>', () => {
    const parsed = parseCallbackData('dlg:pdlg:42:1');
    expect(parsed).toEqual({ verb: 'dlg', entity: 'pdlg', id: 42, extraId: 1 });
  });
  it('parses the cancel form dlgx:pdlg:<id>', () => {
    const parsed = parseCallbackData('dlgx:pdlg:42');
    expect(parsed).toEqual({ verb: 'dlgx', entity: 'pdlg', id: 42, extraId: null });
  });
  it('exposes a stable option-code map matching the service option ids', () => {
    expect(DIALOG_CODE_BY_OPTION.ready).toBe(1);
    expect(DIALOG_CODE_BY_OPTION.zero).toBe(2);
  });
});

describe('dispatchCallback — production dialog', () => {
  it('the owning sex manager answers "ready" and resolves', async () => {
    const { dialogId, userId, production } = await sexWithDialog();
    const principal: CallbackPrincipal = {
      userId, role: 'production_manager', locationId: production,
    };
    const parsed = parseCallbackData(`dlg:pdlg:${dialogId}:${DIALOG_CODE_BY_OPTION.ready}`)!;
    const out = await dispatchCallback(parsed, principal);
    expect(out.kind).toBe('ok');
    const after = await getDialog(dialogId);
    expect(after?.state).toBe('RESOLVED');
  });

  it('a foreign production manager is denied (rbac)', async () => {
    const { dialogId } = await sexWithDialog();
    const otherSex = await makeLocation(ctx.db, { type: 'production' });
    const u = await makeUser(ctx.db, { role: 'production_manager', locationId: otherSex });
    const principal: CallbackPrincipal = {
      userId: u.id, role: 'production_manager', locationId: otherSex,
    };
    const parsed = parseCallbackData(`dlg:pdlg:${dialogId}:1`)!;
    const out = await dispatchCallback(parsed, principal);
    expect(out.kind).toBe('rbac');
    const after = await getDialog(dialogId);
    expect(after?.state).toBe('AWAITING_SOURCE_DECISION'); // untouched
  });

  it('dlgx:pdlg cancels the dialog', async () => {
    const { dialogId, userId, production } = await sexWithDialog();
    const principal: CallbackPrincipal = {
      userId, role: 'production_manager', locationId: production,
    };
    const parsed = parseCallbackData(`dlgx:pdlg:${dialogId}`)!;
    const out = await dispatchCallback(parsed, principal);
    expect(out.kind).toBe('ok');
    const after = await getDialog(dialogId);
    expect(after?.state).toBe('CANCELLED');
  });

  it('an unknown option code is invalid', async () => {
    const { dialogId, userId, production } = await sexWithDialog();
    const principal: CallbackPrincipal = {
      userId, role: 'production_manager', locationId: production,
    };
    const parsed = parseCallbackData(`dlg:pdlg:${dialogId}:9`)!;
    const out = await dispatchCallback(parsed, principal);
    expect(out.kind).toBe('invalid');
  });
});
