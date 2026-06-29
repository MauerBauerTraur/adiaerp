/**
 * AI assistant — write tool layer (Faza-3 F3.2, ADR-0009).
 *
 * Faza-2 shipped 6 read-only tools. Faza-3 adds 6 *write* tools that the
 * Gemini model can propose, but never directly execute: the assistant
 * service intercepts every write functionCall, RBAC-pre-checks it,
 * persists it as a `pending` row in `assistant_actions`, and returns a
 * `pending_action` object in the API response. The UI shows a confirm
 * dialog; only `POST /assistant/actions/:id/confirm` actually mutates
 * domain tables. This file defines the registry the assistant service
 * and the confirm route consume.
 *
 * Each `WriteTool` exposes four members:
 *   - `declaration` — the Gemini `FunctionDeclaration` advertised to the
 *     model. Identical shape to the read declarations so the model picks
 *     from a single uniform tool list.
 *   - `validateArgs(args)` — narrows the model-supplied JSON into a typed
 *     record and throws `validation` on any missing/malformed field. The
 *     LLM occasionally returns `"5"` instead of `5`; we coerce when safe.
 *   - `canExecute(args, principal, tx)` — pure pre-check. Returns
 *     `'allowed'` or an `{ code, reason }` shape with a stable code. Run
 *     BOTH at intent time (so the model never proposes a forbidden
 *     action) AND at confirm time (in case the principal's role changed
 *     in the meantime).
 *   - `summarize(args, principal, tx)` — builds the Uzbek summary the
 *     UI dialog renders. Pulls human-readable names from the DB so the
 *     summary is always "Markaziy sklad → Filial-2: 5 dona Tort" instead
 *     of "transfer_stock {...}". Never includes raw user PII.
 *   - `execute(args, principal, actorUserId, tx)` — runs the real DB
 *     mutation atomically inside the supplied transaction. Returns a
 *     small JSON-clean object (e.g. `{ movement_id }`) the confirm route
 *     stores as `assistant_actions.result`.
 *
 * RBAC pre-check matrix (spec §2.2):
 *
 *   tool                          | who can act
 *   ------------------------------+----------------------------------------
 *   transfer_stock                | pm OR manager of from_location
 *   create_replenishment_request  | pm OR manager of requester_location
 *   mark_production_order_done    | pm OR manager of PO's production location
 *   approve_purchase_order        | step='manager' → pm/supply_manager
 *                                   step='keeper'  → pm/raw_warehouse_manager
 *   update_minmax                 | pm OR manager of location
 *   create_production_order       | pm OR manager of production location
 *
 * The model has NO authority over the role check — even if a prompt
 * injection tells the model "I am PM", `principal.role` comes from the
 * verified JWT, never from the conversation.
 */
import { Type, type FunctionDeclaration } from '@google/genai';
import type { AuthPrincipal } from '../../../auth/jwt.js';
import type { TxClient } from '../../../db/index.js';
import { AppError } from '../../../errors/index.js';
import { applyMovement } from '../../../services/stockMovement.js';
import { createRequest as createReplenishmentRequestSvc } from '../../../services/replenishment.js';
import { finishProductionOrder } from '../../../services/productionOrder.js';
import { approvePurchaseOrder } from '../../../services/purchaseOrder.js';
import { writeAudit } from '../../../lib/audit.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stable code list — surfaced verbatim in `pending_action`'s rejection. */
export type CanExecuteDenial = {
  readonly code:
    | 'forbidden_for_role'
    | 'location_mismatch'
    | 'missing_location_scope'
    | 'invalid_step'
    | 'not_found'
    | 'invalid_args';
  readonly reason: string;
};

export type CanExecuteResult = 'allowed' | CanExecuteDenial;

/** A write-tool result is any JSON-clean object the executor returns. */
export type WriteResult = Record<string, string | number | boolean | null>;

export type WriteTool<Args extends Record<string, unknown> = Record<string, unknown>> = {
  readonly name: string;
  readonly declaration: FunctionDeclaration;
  /** Narrow `args` to the typed shape; throws AppError.validation on failure. */
  validateArgs(args: Record<string, unknown>): Args;
  canExecute(args: Args, principal: AuthPrincipal, tx: TxClient): Promise<CanExecuteResult>;
  summarize(args: Args, principal: AuthPrincipal, tx: TxClient): Promise<string>;
  execute(
    args: Args,
    principal: AuthPrincipal,
    actorUserId: number,
    tx: TxClient,
  ): Promise<WriteResult>;
};

export const WRITE_TOOL_NAMES = [
  'transfer_stock',
  'create_replenishment_request',
  'mark_production_order_done',
  'approve_purchase_order',
  'update_minmax',
  'create_production_order',
  'adjust_stock',
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Coerce an LLM-supplied positive integer id. */
function requireId(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw AppError.validation(`Field "${field}" must be a positive integer id.`);
  }
  return n;
}

/** Coerce a positive number (qty / level). */
function requirePositive(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw AppError.validation(`Field "${field}" must be a positive number.`);
  }
  return n;
}

/** Coerce a non-negative number. */
function requireNonNegative(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw AppError.validation(`Field "${field}" must be a non-negative number.`);
  }
  return n;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isChainWide(principal: AuthPrincipal): boolean {
  return principal.role === 'pm';
}

async function lookupLocation(
  tx: TxClient,
  locationId: number,
): Promise<{ id: number; name: string; type: string; manager_user_id: number | null } | null> {
  const { rows } = await tx.query<{
    id: string;
    name: string;
    type: string;
    manager_user_id: string | null;
  }>(
    `SELECT id, name, type::text AS type, manager_user_id
       FROM locations WHERE id = $1`,
    [locationId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: Number(row.id),
    name: row.name,
    type: row.type,
    manager_user_id: row.manager_user_id === null ? null : Number(row.manager_user_id),
  };
}

async function lookupProduct(
  tx: TxClient,
  productId: number,
): Promise<{ id: number; name: string; unit: string } | null> {
  const { rows } = await tx.query<{ id: string; name: string; unit: string }>(
    `SELECT id, name, unit::text AS unit FROM products WHERE id = $1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { id: Number(row.id), name: row.name, unit: row.unit };
}

/**
 * "Does this principal manage this location?" — true for PM or when the
 * principal's `locationId` matches. Side-channel for `manager_user_id` is
 * intentionally NOT used: the JWT-bound `locationId` is the only source of
 * truth (a swap of `locations.manager_user_id` doesn't auto-grant access).
 */
function principalManagesLocation(principal: AuthPrincipal, locationId: number): boolean {
  if (isChainWide(principal)) return true;
  return principal.locationId !== null && principal.locationId === locationId;
}

// ---------------------------------------------------------------------------
// 1. transfer_stock
// ---------------------------------------------------------------------------

type TransferStockArgs = {
  product_id: number;
  from_location_id: number;
  to_location_id: number;
  qty: number;
  note: string | null;
};

const transferStock: WriteTool<TransferStockArgs> = {
  name: 'transfer_stock',
  declaration: {
    name: 'transfer_stock',
    description:
      'Transfer `qty` of `product_id` from `from_location_id` to `to_location_id`. ' +
      'Use when the user asks to send/move stock between two locations. The actual ' +
      'stock movement is NOT applied immediately — the user must confirm the proposed ' +
      'action first. RBAC: only PM or the manager of `from_location_id` may propose this.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.NUMBER, description: 'Numeric product id (positive integer).' },
        from_location_id: { type: Type.NUMBER, description: 'Numeric source location id.' },
        to_location_id: { type: Type.NUMBER, description: 'Numeric destination location id.' },
        qty: { type: Type.NUMBER, description: 'Positive transfer quantity.' },
        note: { type: Type.STRING, description: 'Optional free-text note (Uzbek).' },
      },
      required: ['product_id', 'from_location_id', 'to_location_id', 'qty'],
    },
  },
  validateArgs(args) {
    const productId = requireId(args.product_id, 'product_id');
    const fromLocationId = requireId(args.from_location_id, 'from_location_id');
    const toLocationId = requireId(args.to_location_id, 'to_location_id');
    if (fromLocationId === toLocationId) {
      throw AppError.validation('"from_location_id" and "to_location_id" must differ.');
    }
    const qty = requirePositive(args.qty, 'qty');
    return {
      product_id: productId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      qty,
      note: optionalString(args.note),
    };
  },
  async canExecute(args, principal) {
    if (!principalManagesLocation(principal, args.from_location_id)) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the source location manager may propose a transfer.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const [from, to, product] = await Promise.all([
      lookupLocation(tx, args.from_location_id),
      lookupLocation(tx, args.to_location_id),
      lookupProduct(tx, args.product_id),
    ]);
    const fromName = from?.name ?? `#${args.from_location_id}`;
    const toName = to?.name ?? `#${args.to_location_id}`;
    const productName = product?.name ?? `#${args.product_id}`;
    const unit = product?.unit ?? '';
    return `${fromName} → ${toName}: ${args.qty} ${unit} ${productName}`.trim();
  },
  async execute(args, _principal, actorUserId, tx) {
    const { movementId } = await applyMovement(
      {
        productId: args.product_id,
        fromLocationId: args.from_location_id,
        toLocationId: args.to_location_id,
        qty: args.qty,
        reason: 'transfer',
        actorUserId,
        note: args.note,
      },
      tx,
    );
    return { movement_id: movementId };
  },
};

// ---------------------------------------------------------------------------
// 2. create_replenishment_request
// ---------------------------------------------------------------------------

type CreateReplenishmentArgs = {
  product_id: number;
  requester_location_id: number;
  qty_needed: number;
};

const createReplenishmentRequest: WriteTool<CreateReplenishmentArgs> = {
  name: 'create_replenishment_request',
  declaration: {
    name: 'create_replenishment_request',
    description:
      'Open a new replenishment_request (status NEW) for `requester_location_id` ' +
      'asking for `qty_needed` of `product_id`. Use when the user wants to raise a ' +
      'manual replenishment for a location. The actual row is NOT inserted until ' +
      'the user confirms the proposed action. RBAC: PM or the requester location manager.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.NUMBER },
        requester_location_id: { type: Type.NUMBER },
        qty_needed: { type: Type.NUMBER, description: 'Positive quantity to request.' },
      },
      required: ['product_id', 'requester_location_id', 'qty_needed'],
    },
  },
  validateArgs(args) {
    return {
      product_id: requireId(args.product_id, 'product_id'),
      requester_location_id: requireId(args.requester_location_id, 'requester_location_id'),
      qty_needed: requirePositive(args.qty_needed, 'qty_needed'),
    };
  },
  async canExecute(args, principal) {
    if (!principalManagesLocation(principal, args.requester_location_id)) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the requester location manager may propose this request.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const [loc, product] = await Promise.all([
      lookupLocation(tx, args.requester_location_id),
      lookupProduct(tx, args.product_id),
    ]);
    const locName = loc?.name ?? `#${args.requester_location_id}`;
    const productName = product?.name ?? `#${args.product_id}`;
    const unit = product?.unit ?? '';
    return `Yangi so'rov: ${locName} — ${args.qty_needed} ${unit} ${productName}`.trim();
  },
  async execute(args, _principal, actorUserId) {
    const row = await createReplenishmentRequestSvc({
      productId: args.product_id,
      requesterLocationId: args.requester_location_id,
      qtyNeeded: args.qty_needed,
      actorUserId,
    });
    return { replenishment_id: row.id };
  },
};

// ---------------------------------------------------------------------------
// 3. mark_production_order_done
// ---------------------------------------------------------------------------

type MarkProductionDoneArgs = {
  production_order_id: number;
};

const markProductionOrderDone: WriteTool<MarkProductionDoneArgs> = {
  name: 'mark_production_order_done',
  declaration: {
    name: 'mark_production_order_done',
    description:
      'Mark a production_order as `done`: consume the BOM out of the production ' +
      'location and produce the output into the target location, atomically. The ' +
      'state machine flip is NOT applied until the user confirms.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        production_order_id: { type: Type.NUMBER, description: 'Numeric production_order id.' },
      },
      required: ['production_order_id'],
    },
  },
  validateArgs(args) {
    return { production_order_id: requireId(args.production_order_id, 'production_order_id') };
  },
  async canExecute(args, principal, tx) {
    const { rows } = await tx.query<{ location_id: string; status: string }>(
      `SELECT location_id, status FROM production_orders WHERE id = $1`,
      [args.production_order_id],
    );
    const order = rows[0];
    if (order === undefined) {
      return { code: 'not_found', reason: 'Production order not found.' };
    }
    if (!principalManagesLocation(principal, Number(order.location_id))) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the production location manager may finish this order.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const { rows } = await tx.query<{
      qty: string;
      product_name: string;
      product_unit: string;
      location_name: string;
    }>(
      `SELECT po.qty, p.name AS product_name, p.unit AS product_unit, l.name AS location_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         JOIN locations l ON l.id = po.location_id
        WHERE po.id = $1`,
      [args.production_order_id],
    );
    const row = rows[0];
    if (row === undefined) {
      return `Zayafka #${args.production_order_id} tugatish`;
    }
    return `Zayafka #${args.production_order_id} tugatish: ${Number(row.qty)} ${row.product_unit} ${row.product_name} (${row.location_name})`;
  },
  async execute(args, _principal, actorUserId, tx) {
    const result = await finishProductionOrder(args.production_order_id, actorUserId, tx);
    return { production_order_id: result.id, status: result.status };
  },
};

// ---------------------------------------------------------------------------
// 4. approve_purchase_order
// ---------------------------------------------------------------------------

type ApprovePoArgs = {
  purchase_order_id: number;
  step: 'manager' | 'keeper';
};

const approvePoTool: WriteTool<ApprovePoArgs> = {
  name: 'approve_purchase_order',
  declaration: {
    name: 'approve_purchase_order',
    description:
      'Record one approval step on a purchase_order. `step="manager"` is taken by ' +
      'the supply_manager; `step="keeper"` is taken by the raw_warehouse_manager. ' +
      'PM may take either. The order becomes `approved` only when BOTH steps are ' +
      'recorded. The DB write is NOT applied until the user confirms.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        purchase_order_id: { type: Type.NUMBER },
        step: { type: Type.STRING, description: 'Approval step: "manager" or "keeper".' },
      },
      required: ['purchase_order_id', 'step'],
    },
  },
  validateArgs(args) {
    const purchaseOrderId = requireId(args.purchase_order_id, 'purchase_order_id');
    const stepRaw = typeof args.step === 'string' ? args.step.trim().toLowerCase() : '';
    if (stepRaw !== 'manager' && stepRaw !== 'keeper') {
      throw AppError.validation('Field "step" must be "manager" or "keeper".');
    }
    return { purchase_order_id: purchaseOrderId, step: stepRaw };
  },
  async canExecute(args, principal) {
    if (isChainWide(principal)) {
      return 'allowed';
    }
    if (args.step === 'manager' && principal.role === 'supply_manager') {
      return 'allowed';
    }
    if (args.step === 'keeper' && principal.role === 'raw_warehouse_manager') {
      return 'allowed';
    }
    return {
      code: 'forbidden_for_role',
      reason:
        args.step === 'manager'
          ? 'Only PM or supply_manager may take the manager step.'
          : 'Only PM or raw_warehouse_manager may take the keeper step.',
    };
  },
  async summarize(args, _principal, tx) {
    const { rows } = await tx.query<{ qty: string; product_name: string; product_unit: string }>(
      `SELECT po.qty, p.name AS product_name, p.unit AS product_unit
         FROM purchase_orders po
         JOIN products p ON p.id = po.product_id
        WHERE po.id = $1`,
      [args.purchase_order_id],
    );
    const row = rows[0];
    const stepLabel = args.step === 'manager' ? 'manager' : 'keeper';
    if (row === undefined) {
      return `Ta'minot #${args.purchase_order_id} — ${stepLabel} tasdig'i`;
    }
    return `Ta'minot #${args.purchase_order_id} — ${stepLabel} tasdig'i: ${Number(row.qty)} ${row.product_unit} ${row.product_name}`;
  },
  async execute(args, _principal, actorUserId, tx) {
    const updated = await approvePurchaseOrder(
      args.purchase_order_id,
      args.step,
      actorUserId,
      tx,
    );
    return { purchase_order_id: updated.id, status: updated.status };
  },
};

// ---------------------------------------------------------------------------
// 5. update_minmax
// ---------------------------------------------------------------------------

type UpdateMinMaxArgs = {
  product_id: number;
  location_id: number;
  min_level: number;
  max_level: number;
  mode: 'manual' | 'dynamic';
};

const updateMinMax: WriteTool<UpdateMinMaxArgs> = {
  name: 'update_minmax',
  declaration: {
    name: 'update_minmax',
    description:
      'Update the `min_level` and `max_level` thresholds for one (location, product) ' +
      'pair. `mode` defaults to "manual" — set "dynamic" to re-enable the nightly ' +
      'recompute for that pair. The write is NOT applied until the user confirms.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.NUMBER },
        location_id: { type: Type.NUMBER },
        min_level: { type: Type.NUMBER },
        max_level: { type: Type.NUMBER },
        mode: { type: Type.STRING, description: '"manual" (default) or "dynamic".' },
      },
      required: ['product_id', 'location_id', 'min_level', 'max_level'],
    },
  },
  validateArgs(args) {
    const productId = requireId(args.product_id, 'product_id');
    const locationId = requireId(args.location_id, 'location_id');
    const minLevel = requireNonNegative(args.min_level, 'min_level');
    const maxLevel = requireNonNegative(args.max_level, 'max_level');
    if (maxLevel < minLevel) {
      throw AppError.validation('"max_level" cannot be lower than "min_level".');
    }
    const modeRaw = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : 'manual';
    if (modeRaw !== 'manual' && modeRaw !== 'dynamic') {
      throw AppError.validation('Field "mode" must be "manual" or "dynamic".');
    }
    return {
      product_id: productId,
      location_id: locationId,
      min_level: minLevel,
      max_level: maxLevel,
      mode: modeRaw,
    };
  },
  async canExecute(args, principal) {
    if (!principalManagesLocation(principal, args.location_id)) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the location manager may update min/max for this location.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const [loc, product] = await Promise.all([
      lookupLocation(tx, args.location_id),
      lookupProduct(tx, args.product_id),
    ]);
    const locName = loc?.name ?? `#${args.location_id}`;
    const productName = product?.name ?? `#${args.product_id}`;
    const unit = product?.unit ?? '';
    return `${locName} · ${productName}: min=${args.min_level} ${unit}, max=${args.max_level} ${unit} (${args.mode})`.trim();
  },
  async execute(args, _principal, actorUserId, tx) {
    const { rows, rowCount } = await tx.query<{ location_id: string; product_id: string }>(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
       VALUES ($1, $2, 0, $3, $4, $5)
       ON CONFLICT (location_id, product_id)
       DO UPDATE SET min_level = EXCLUDED.min_level,
                     max_level = EXCLUDED.max_level,
                     minmax_mode = EXCLUDED.minmax_mode
       RETURNING location_id, product_id`,
      [args.location_id, args.product_id, args.min_level, args.max_level, args.mode],
    );
    if (rowCount === 0 || rows[0] === undefined) {
      throw AppError.internal('update_minmax: stock upsert returned no row.');
    }
    await writeAudit(tx, {
      actorUserId,
      action: 'stock.minmax_update',
      entity: 'stock',
      entityId: args.location_id,
      payload: {
        product_id: args.product_id,
        location_id: args.location_id,
        min_level: args.min_level,
        max_level: args.max_level,
        mode: args.mode,
      },
    });
    return {
      location_id: args.location_id,
      product_id: args.product_id,
      min_level: args.min_level,
      max_level: args.max_level,
      mode: args.mode,
    };
  },
};

// ---------------------------------------------------------------------------
// 6. create_production_order
// ---------------------------------------------------------------------------

type CreateProductionOrderArgs = {
  product_id: number;
  qty: number;
  location_id: number;
  target_location_id: number;
  deadline: string | null;
};

const createProductionOrder: WriteTool<CreateProductionOrderArgs> = {
  name: 'create_production_order',
  declaration: {
    name: 'create_production_order',
    description:
      'Create a new production_order (status `new`) at `location_id` (a production ' +
      'location) for `qty` of `product_id`, with output landing at `target_location_id` ' +
      '(typically the central warehouse). Optional ISO `deadline` (YYYY-MM-DD). ' +
      'The row is NOT inserted until the user confirms.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.NUMBER },
        qty: { type: Type.NUMBER },
        location_id: { type: Type.NUMBER, description: 'Production location id.' },
        target_location_id: {
          type: Type.NUMBER,
          description: 'Where the produced goods land (usually the central warehouse).',
        },
        deadline: { type: Type.STRING, description: 'Optional ISO date YYYY-MM-DD.' },
      },
      required: ['product_id', 'qty', 'location_id', 'target_location_id'],
    },
  },
  validateArgs(args) {
    const productId = requireId(args.product_id, 'product_id');
    const qty = requirePositive(args.qty, 'qty');
    const locationId = requireId(args.location_id, 'location_id');
    const targetLocationId = requireId(args.target_location_id, 'target_location_id');
    const deadlineRaw = optionalString(args.deadline);
    if (deadlineRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) {
      throw AppError.validation('Field "deadline" must be an ISO date (YYYY-MM-DD).');
    }
    return {
      product_id: productId,
      qty,
      location_id: locationId,
      target_location_id: targetLocationId,
      deadline: deadlineRaw,
    };
  },
  async canExecute(args, principal) {
    if (!principalManagesLocation(principal, args.location_id)) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the production location manager may create a production order here.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const [loc, target, product] = await Promise.all([
      lookupLocation(tx, args.location_id),
      lookupLocation(tx, args.target_location_id),
      lookupProduct(tx, args.product_id),
    ]);
    const locName = loc?.name ?? `#${args.location_id}`;
    const targetName = target?.name ?? `#${args.target_location_id}`;
    const productName = product?.name ?? `#${args.product_id}`;
    const unit = product?.unit ?? '';
    const deadlinePart = args.deadline === null ? '' : ` (muddat: ${args.deadline})`;
    return `Yangi zayafka: ${locName} → ${targetName}: ${args.qty} ${unit} ${productName}${deadlinePart}`.trim();
  },
  async execute(args, _principal, actorUserId, tx) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO production_orders
         (product_id, qty, location_id, target_location_id, deadline, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        args.product_id,
        args.qty,
        args.location_id,
        args.target_location_id,
        args.deadline,
        actorUserId,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw AppError.internal('create_production_order: insert returned no row.');
    }
    const orderId = Number(id);
    await writeAudit(tx, {
      actorUserId,
      action: 'production_order.create',
      entity: 'production_orders',
      entityId: orderId,
      payload: {
        product_id: args.product_id,
        qty: args.qty,
        location_id: args.location_id,
        target_location_id: args.target_location_id,
        via: 'assistant_action',
      },
    });
    return { production_order_id: orderId };
  },
};

// ---------------------------------------------------------------------------
// 7. adjust_stock — voice flow: kirim (+delta) / chiqim (−delta) at one location
// ---------------------------------------------------------------------------
//
// Voice oqimi (F4.3 / ADR-0014) uchun maxsus tool. Foydalanuvchi "omborga 500
// kg un keldi" desa → `{delta: 500, location_id: <ombor>, product_id: <un>}`.
// "5 ta tort buzildi" → `{delta: -5, ...}`. UI/AI chat dan ham chaqirilishi
// mumkin, lekin asosiy ishlatuvchi voiceHandler.
//
// `applyMovement` ostida:
//   - delta > 0  → fromLocationId=null, toLocationId=X   (kirim, reason='adjust')
//   - delta < 0  → fromLocationId=X,    toLocationId=null (chiqim, reason='adjust')
//
// Invariant 3 (negative qty oldini olish) `applyMovement` ichidagi
// guardedDecrement orqali saqlanadi — delta < 0 va |delta| > qty bo'lsa
// INSUFFICIENT_STOCK ko'tariladi va tranzaksiya rollback bo'ladi.

type AdjustStockArgs = {
  product_id: number;
  location_id: number;
  delta: number;
  note: string | null;
};

const adjustStock: WriteTool<AdjustStockArgs> = {
  name: 'adjust_stock',
  declaration: {
    name: 'adjust_stock',
    description:
      'Adjust the stock of `product_id` at `location_id` by a signed `delta` ' +
      '(positive = receipt/kirim, negative = issue/chiqim). Use this for voice ' +
      'commands like "omborga 500 kg un keldi" (delta=+500) or "5 ta tort buzildi" ' +
      '(delta=-5). The DB mutation is NOT applied until the user confirms. ' +
      'RBAC: PM or the manager of `location_id`.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product_id: { type: Type.NUMBER, description: 'Numeric product id (positive integer).' },
        location_id: { type: Type.NUMBER, description: 'Numeric location id.' },
        delta: {
          type: Type.NUMBER,
          description:
            'Signed quantity change. Positive = receipt (kirim), negative = issue (chiqim). ' +
            'Must be non-zero.',
        },
        note: { type: Type.STRING, description: 'Optional free-text note (Uzbek).' },
      },
      required: ['product_id', 'location_id', 'delta'],
    },
  },
  validateArgs(args) {
    const productId = requireId(args.product_id, 'product_id');
    const locationId = requireId(args.location_id, 'location_id');
    const deltaRaw = typeof args.delta === 'number' ? args.delta : Number(args.delta);
    if (!Number.isFinite(deltaRaw) || deltaRaw === 0) {
      throw AppError.validation('Field "delta" must be a non-zero finite number.');
    }
    return {
      product_id: productId,
      location_id: locationId,
      delta: deltaRaw,
      note: optionalString(args.note),
    };
  },
  async canExecute(args, principal) {
    if (!principalManagesLocation(principal, args.location_id)) {
      return {
        code: 'forbidden_for_role',
        reason: 'Only PM or the location manager may adjust stock here.',
      };
    }
    return 'allowed';
  },
  async summarize(args, _principal, tx) {
    const [loc, product] = await Promise.all([
      lookupLocation(tx, args.location_id),
      lookupProduct(tx, args.product_id),
    ]);
    const locName = loc?.name ?? `#${args.location_id}`;
    const productName = product?.name ?? `#${args.product_id}`;
    const unit = product?.unit ?? '';
    const sign = args.delta > 0 ? '+' : '−';
    return `${locName}: ${sign}${Math.abs(args.delta)} ${unit} ${productName}`.trim();
  },
  async execute(args, _principal, actorUserId, tx) {
    const fromLocationId = args.delta < 0 ? args.location_id : null;
    const toLocationId = args.delta > 0 ? args.location_id : null;
    const { movementId } = await applyMovement(
      {
        productId: args.product_id,
        fromLocationId,
        toLocationId,
        qty: Math.abs(args.delta),
        reason: 'adjust',
        actorUserId,
        note: args.note,
      },
      tx,
    );
    return { movement_id: movementId };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const WRITE_TOOL_REGISTRY: Record<WriteToolName, WriteTool> = {
  transfer_stock: transferStock as unknown as WriteTool,
  create_replenishment_request: createReplenishmentRequest as unknown as WriteTool,
  mark_production_order_done: markProductionOrderDone as unknown as WriteTool,
  approve_purchase_order: approvePoTool as unknown as WriteTool,
  update_minmax: updateMinMax as unknown as WriteTool,
  create_production_order: createProductionOrder as unknown as WriteTool,
  adjust_stock: adjustStock as unknown as WriteTool,
};

/** Is `name` a known write tool? */
export function isWriteToolName(name: string): name is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Look up a write tool by name (or `undefined`). */
export function getWriteTool(name: string): WriteTool | undefined {
  return isWriteToolName(name) ? WRITE_TOOL_REGISTRY[name] : undefined;
}

/** All write tool declarations — appended to the model's tool list. */
export function writeToolDeclarations(): FunctionDeclaration[] {
  return WRITE_TOOL_NAMES.map((n) => WRITE_TOOL_REGISTRY[n].declaration);
}
