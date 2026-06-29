/**
 * EPIC 5 / ADR-0016 §3-4 — channel-agnostic AI production dialog service.
 *
 * When a finished cake must be produced (a replenishment request reaches
 * CREATE_PRODUCTION_ORDER, or a sex manager raises one by hand) the AI asks
 * the sex user TWO questions before any document is created:
 *
 *   Q1 (AWAITING_SOURCE_DECISION) — "Nta buyurtma, M zagatovka bor —
 *      tayyordan yoki 0dan?"  (zagatovka source).
 *   Q2 (AWAITING_CREAM_CONFIRM)   — only when a decoration component (krem /
 *      bezak) is short: "Krem kam — yangi tayyorlash yoki ombordan?".
 *
 * The QUESTION and the chosen ANSWER live in `production_dialog_sessions`
 * (migration 0031) — the single source of truth. The web modal and the
 * Telegram bot are both thin render/answer layers over THIS service
 * (Q5 — owner: web + telegram). `answerDialog` is called identically from
 * the HTTP route and from the Grammy callback dispatcher.
 *
 * When the dialog RESOLVES, `answerDialog` runs the conditional-BOM-expansion
 * algorithm (ADR-0016 §4) inside ONE transaction and emits 0..N documents:
 *   - a zagatovka sub-production-order (stage_role='zagatovka', target =
 *     sex_storage) when the user chose "0dan" / a shortfall must be made;
 *   - a replenishment request for any short base/decoration material
 *     (the existing two-step supply flow — invariant 7).
 *
 * Invariants honoured here:
 *   - 1 (atomicity)   — request/sub-order creation + dialog flip + audit run
 *                       in ONE withTransaction; any failure rolls everything
 *                       back and leaves the dialog state untouched.
 *   - 2 (one open req)— createRequest surfaces OPEN_REQUEST_EXISTS; we treat a
 *                       pre-existing open request for a (component, raw_wh) as
 *                       "already requested" and skip it (debounce).
 *   - 3 (no negative) — no stock is mutated directly here; movements happen
 *                       later through the production-order / replenishment flow.
 *   - 5 (audit)       — every create + flip writes an audit_log row.
 *
 * OPEN-QUESTION DEFAULTS taken in this slice (ADR-0016 §8):
 *   OQ1 — ALWAYS ASK. No location-level "always from ready" auto-skip; the
 *         sex user decides every order. (Safest; matches the owner scenario.)
 *   OQ2 — manual min/max only; no new consumption aggregate (out of scope).
 *   OQ3 — each finished cake points at its OWN semi zagatovka via its
 *         decoration BOM (findZagatovkaComponent); no shared-semi constraint.
 *   OQ4 — 6h expiry (DB default). expireStaleDialogs() stamps EXPIRED and
 *         escalates to PM; it never auto-creates documents (a human must
 *         re-trigger), which keeps an abandoned dialog side-effect-free.
 *   OQ5 — krem may be semi OR raw. A short decoration component that is a
 *         `semi` AND the user chose "make" becomes a production sub-request;
 *         otherwise (raw, or "ombordan") it becomes a purchase request.
 */
import { query, withTransaction, type SqlParam, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import {
  findZagatovkaComponent,
  readBaseBom,
  readFinalBom,
  type BomLine,
} from './bom.js';
import {
  createNotificationsForRecipients,
  getUsersByRole,
} from './notify.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DialogState =
  | 'AWAITING_SOURCE_DECISION'
  | 'AWAITING_CREAM_CONFIRM'
  | 'RESOLVED'
  | 'EXPIRED'
  | 'CANCELLED';

export const OPEN_DIALOG_STATES: readonly DialogState[] = [
  'AWAITING_SOURCE_DECISION',
  'AWAITING_CREAM_CONFIRM',
];

export type DialogSessionRow = {
  id: number;
  replenishment_id: number | null;
  production_order_id: number | null;
  product_id: number;
  location_id: number;
  assigned_user_id: number | null;
  state: DialogState;
  qty_ordered: number;
  context: DialogContext;
  decision: DialogDecision | null;
  created_by: number | null;
  created_at: Date;
  resolved_at: Date | null;
  expires_at: Date;
};

export const DIALOG_COLUMNS = `id, replenishment_id, production_order_id,
  product_id, location_id, assigned_user_id, state, qty_ordered, context,
  decision, created_by, created_at, resolved_at, expires_at`;

/** Persisted decision context — light, evolving, so JSONB (ADR-0016 §3.2). */
export type DialogContext = {
  /** semi zagatovka product id of the finished cake's decoration BOM. */
  readonly zagatovka_product_id?: number | null;
  readonly zagatovka_have?: number;
  readonly zagatovka_need?: number;
  /** Topology snapshot at dialog-create time (resolved against location_id). */
  readonly sex_storage_id?: number | null;
  readonly raw_warehouse_id?: number | null;
  readonly production_id?: number | null;
  readonly central_warehouse_id?: number | null;
  /** Q1 outcome carried into Q2/resolve. */
  readonly make_from_zero?: number;
  readonly take_from_ready?: number;
  [key: string]: unknown;
};

/** The full audit of what the user chose (ADR-0016 §3.2). */
export type DialogDecision = {
  source?: 'ready' | 'zero' | 'mixed';
  source_qty_from_ready?: number;
  cream?: 'make' | 'buy' | 'none';
  [key: string]: unknown;
};

/** A render-agnostic question — web shows radios, Telegram inline buttons. */
export type DialogQuestion = {
  readonly text: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly hint?: string;
  }>;
};

/** A document the resolve step created, surfaced to both channels. */
export type CreatedDocument =
  | { readonly type: 'production'; readonly id: number; readonly product_id: number; readonly qty: number }
  | { readonly type: 'purchase'; readonly id: number; readonly product_id: number; readonly qty: number };

export type AnswerResult = {
  readonly session: DialogSessionRow;
  readonly next_question: DialogQuestion | null;
  readonly resolved: boolean;
  readonly created_requests: CreatedDocument[];
};

// -----------------------------------------------------------------------------
// Topology + stock reads (local to the dialog — keeps the service self-contained)
// -----------------------------------------------------------------------------

type Topology = {
  productionId: number | null;
  sexStorageId: number | null;
  rawWarehouseId: number | null;
  centralWarehouseId: number | null;
};

/**
 * Resolve the chain around a PRODUCTION location: its raw warehouse (parent),
 * central warehouse (first central ancestor) and its sex_storage child.
 * `location_id` on a dialog is the production sex floor.
 */
async function resolveTopologyFromProduction(
  tx: TxClient,
  productionId: number,
): Promise<Topology> {
  const { rows } = await tx.query<{ id: string; type: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, type, parent_id, 0 AS depth FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.type, l.parent_id, c.depth + 1
       FROM locations l JOIN chain c ON l.id = c.parent_id
     )
     SELECT id, type, depth FROM chain ORDER BY depth`,
    [productionId],
  );
  let rawWarehouseId: number | null = null;
  let centralWarehouseId: number | null = null;
  for (const r of rows) {
    if (rawWarehouseId === null && r.type === 'raw_warehouse') rawWarehouseId = Number(r.id);
    if (centralWarehouseId === null && r.type === 'central_warehouse') {
      centralWarehouseId = Number(r.id);
    }
  }
  // sex_storage is the production's CHILD (migration 0022), not an ancestor.
  const { rows: sexRows } = await tx.query<{ id: string }>(
    `SELECT id FROM locations
      WHERE parent_id = $1 AND type = 'sex_storage'::location_type
      ORDER BY id LIMIT 1`,
    [productionId],
  );
  const sexStorageId = sexRows[0] !== undefined ? Number(sexRows[0].id) : null;
  return { productionId, sexStorageId, rawWarehouseId, centralWarehouseId };
}

async function readStockQty(
  tx: TxClient,
  locationId: number | null,
  productId: number,
): Promise<number> {
  if (locationId === null) return 0;
  const { rows } = await tx.query<{ qty: string }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  const raw = rows[0]?.qty;
  return raw === undefined ? 0 : Number(raw);
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

/**
 * Open a production dialog for a finished cake order. Reads the zagatovka
 * on-hand vs needed and parks the first question (Q1) — UNLESS the finished
 * product has no decoration BOM / no semi zagatovka component, in which case
 * there is nothing to ask (legacy single-pass product) and `null` is returned
 * so the caller falls back to the plain production flow.
 *
 * Idempotency: if an OPEN dialog already exists for the same
 * (product, location, replenishment_id) it is returned as-is — a request that
 * re-enters CREATE_PRODUCTION_ORDER never spawns a duplicate dialog.
 */
export async function createDialogForOrder(opts: {
  productId: number;
  locationId: number; // production sex floor
  qtyOrdered: number;
  replenishmentId?: number | null;
  productionOrderId?: number | null;
  assignedUserId?: number | null;
  actorUserId: number | null;
  tx?: TxClient;
}): Promise<DialogSessionRow | null> {
  if (!Number.isFinite(opts.qtyOrdered) || opts.qtyOrdered <= 0) {
    throw AppError.validation('qty_ordered must be a number greater than zero.');
  }
  const run = async (tx: TxClient): Promise<DialogSessionRow | null> => {
    // Debounce — reuse an open dialog for the same order context.
    const { rows: existing } = await tx.query<DialogSessionRow>(
      `SELECT ${DIALOG_COLUMNS} FROM production_dialog_sessions
        WHERE product_id = $1 AND location_id = $2
          AND ($3::bigint IS NULL OR replenishment_id IS NOT DISTINCT FROM $3)
          AND state IN ('AWAITING_SOURCE_DECISION','AWAITING_CREAM_CONFIRM')
        ORDER BY id DESC LIMIT 1`,
      [opts.productId, opts.locationId, opts.replenishmentId ?? null],
    );
    if (existing[0] !== undefined) {
      return normalizeRow(existing[0]);
    }

    const zagatovka = await findZagatovkaComponent(tx, opts.productId);
    if (zagatovka === null) {
      // No semi zagatovka in the decoration BOM — nothing to ask. The caller
      // (replenishment engine / route) runs the plain single-pass flow.
      return null;
    }

    const topology = await resolveTopologyFromProduction(tx, opts.locationId);
    const zagatovkaNeed = zagatovka.qty_per_unit * opts.qtyOrdered;
    const zagatovkaHave = await readStockQty(tx, topology.sexStorageId, zagatovka.component_product_id);

    const context: DialogContext = {
      zagatovka_product_id: zagatovka.component_product_id,
      zagatovka_have: zagatovkaHave,
      zagatovka_need: zagatovkaNeed,
      sex_storage_id: topology.sexStorageId,
      raw_warehouse_id: topology.rawWarehouseId,
      production_id: topology.productionId,
      central_warehouse_id: topology.centralWarehouseId,
    };

    const { rows } = await tx.query<DialogSessionRow>(
      `INSERT INTO production_dialog_sessions
         (replenishment_id, production_order_id, product_id, location_id,
          assigned_user_id, state, qty_ordered, context, created_by)
       VALUES ($1, $2, $3, $4, $5, 'AWAITING_SOURCE_DECISION', $6, $7::jsonb, $8)
       RETURNING ${DIALOG_COLUMNS}`,
      [
        opts.replenishmentId ?? null,
        opts.productionOrderId ?? null,
        opts.productId,
        opts.locationId,
        opts.assignedUserId ?? null,
        opts.qtyOrdered,
        JSON.stringify(context),
        opts.actorUserId,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.internal('Dialog session insert returned no row.');
    }
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'production_dialog.create',
      entity: 'production_dialog_sessions',
      entityId: row.id,
      payload: {
        product_id: opts.productId,
        qty_ordered: opts.qtyOrdered,
        zagatovka_have: zagatovkaHave,
        zagatovka_need: zagatovkaNeed,
      },
    });
    return normalizeRow(row);
  };
  return opts.tx !== undefined ? run(opts.tx) : withTransaction(run);
}

// -----------------------------------------------------------------------------
// Question rendering
// -----------------------------------------------------------------------------

/** Build the render-agnostic question for a dialog's CURRENT state. */
export function buildQuestion(session: DialogSessionRow): DialogQuestion | null {
  const ctx = session.context;
  if (session.state === 'AWAITING_SOURCE_DECISION') {
    const have = Number(ctx.zagatovka_have ?? 0);
    const need = Number(ctx.zagatovka_need ?? 0);
    const enough = have >= need;
    const options: DialogQuestion['options'] = enough
      ? [
          { id: 'ready', label: 'Tayyordan ol', hint: `Sex skladida ${have} ta tayyor` },
          { id: 'zero', label: '0dan qil', hint: 'Hamir retsepti bo\'yicha yangi tayyorla' },
        ]
      : have > 0
        ? [
            {
              id: 'mixed',
              label: `Bor ${have} tasini tayyordan, qolganini 0dan`,
              hint: `${need - have} ta yetishmaydi`,
            },
            { id: 'zero', label: 'Hammasini 0dan qil', hint: 'Barchasini yangi tayyorla' },
          ]
        : [{ id: 'zero', label: '0dan qil', hint: 'Sex skladida zagatovka yo\'q' }];
    return {
      text:
        `${Number(session.qty_ordered)} ta buyurtma. Sex skladida ${have} ta zagatovka bor ` +
        `(kerak ${need}). Qaysi yo'l bilan tayyorlaymiz?`,
      options,
    };
  }
  if (session.state === 'AWAITING_CREAM_CONFIRM') {
    const shortName = String(ctx.cream_short_name ?? 'krem');
    const have = Number(ctx.cream_have ?? 0);
    const need = Number(ctx.cream_need ?? 0);
    const isSemi = ctx.cream_is_semi === true;
    const options: DialogQuestion['options'] = isSemi
      ? [
          { id: 'make', label: 'Yangi tayyorlash', hint: `${shortName} retsepti bo'yicha ishlab chiqar` },
          { id: 'buy', label: 'Ombordan so\'rash', hint: 'Xom-ashyo omboridan so\'rovnoma' },
        ]
      : [{ id: 'buy', label: 'Ombordan so\'rash', hint: 'Xom-ashyo omboridan so\'rovnoma' }];
    return {
      text: `${shortName} yetarli emas (bor ${have}, kerak ${need}). Nima qilamiz?`,
      options,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Answer — the dialog state machine + conditional BOM expansion (ADR-0016 §4)
// -----------------------------------------------------------------------------

/**
 * Apply one answer to an open dialog. Runs in ONE transaction (invariant 1).
 * Returns the next question (Q2) when more input is needed, otherwise resolves
 * the dialog and returns the documents created.
 *
 * `optionId` is validated against the CURRENT question's options — an unknown
 * option is INVALID_OPTION (validation 422). An already-terminal dialog is
 * SESSION_EXPIRED / a no-op depending on state.
 */
export async function answerDialog(opts: {
  dialogId: number;
  optionId: string;
  qty?: number;
  actorUserId: number | null;
  tx?: TxClient;
}): Promise<AnswerResult> {
  // Expiry pre-check BEFORE the transaction (and before FOR UPDATE) so the
  // EXPIRED stamp COMMITS even though we then throw — a throw inside the main
  // transaction would roll the stamp back together with everything else. Done
  // outside the lock to avoid a same-row self-deadlock. Skipped when a caller
  // supplies its own `tx` (it owns the lifecycle).
  if (opts.tx === undefined) {
    const peek = await getDialog(opts.dialogId);
    if (
      peek !== null &&
      OPEN_DIALOG_STATES.includes(peek.state) &&
      new Date(peek.expires_at).getTime() <= Date.now()
    ) {
      await query(
        `UPDATE production_dialog_sessions
            SET state = 'EXPIRED', resolved_at = now()
          WHERE id = $1 AND state IN ('AWAITING_SOURCE_DECISION','AWAITING_CREAM_CONFIRM')`,
        [opts.dialogId],
      );
      throw new AppError('SESSION_EXPIRED', `Dialog ${opts.dialogId} has expired.`);
    }
  }

  const run = async (tx: TxClient): Promise<AnswerResult> => {
    const session = await lockDialog(tx, opts.dialogId);

    if (session.state === 'EXPIRED' || session.state === 'CANCELLED') {
      throw new AppError('SESSION_EXPIRED', `Dialog ${opts.dialogId} is ${session.state}.`);
    }
    if (session.state === 'RESOLVED') {
      // Idempotent — already done; return as-is with no new documents.
      return { session, next_question: null, resolved: true, created_requests: [] };
    }

    const question = buildQuestion(session);
    if (question === null) {
      throw AppError.internal(`Dialog ${session.id} has no question for state ${session.state}.`);
    }
    if (!question.options.some((o) => o.id === opts.optionId)) {
      throw new AppError('INVALID_OPTION', `Option "${opts.optionId}" is not valid for this question.`);
    }

    if (session.state === 'AWAITING_SOURCE_DECISION') {
      return answerSourceDecision(tx, session, opts.optionId, opts.actorUserId);
    }
    // AWAITING_CREAM_CONFIRM
    return answerCreamConfirm(tx, session, opts.optionId, opts.actorUserId);
  };
  return opts.tx !== undefined ? run(opts.tx) : withTransaction(run);
}

/**
 * Q1 — the zagatovka source decision. Computes make_from_zero, optionally
 * raises a zagatovka sub-order (and a base-material purchase request if the
 * hamir raw is short), then evaluates the decoration components to decide
 * whether Q2 (cream confirm) is needed or the dialog resolves.
 */
async function answerSourceDecision(
  tx: TxClient,
  session: DialogSessionRow,
  optionId: string,
  actorUserId: number | null,
): Promise<AnswerResult> {
  const ctx = session.context;
  const need = Number(ctx.zagatovka_need ?? 0);
  const have = Number(ctx.zagatovka_have ?? 0);
  const zagatovkaProductId = Number(ctx.zagatovka_product_id ?? 0);

  // take_from_ready / make_from_zero per ADR-0016 §4.1.
  let takeFromReady = 0;
  if (optionId === 'ready') takeFromReady = Math.min(have, need);
  else if (optionId === 'mixed') takeFromReady = Math.min(have, need);
  else takeFromReady = 0; // 'zero'
  const makeFromZero = Math.max(0, need - takeFromReady);

  const created: CreatedDocument[] = [];

  // 1-BOSQICH — when some zagatovka must be made from scratch, check the base
  // (hamir) raw and either raise the zagatovka sub-order or request the short
  // base material first.
  if (makeFromZero > 0 && zagatovkaProductId > 0) {
    const docs = await raiseZagatovka(tx, session, zagatovkaProductId, makeFromZero, actorUserId);
    created.push(...docs);
  }

  // Persist the Q1 decision into context for Q2/resolve.
  const decision: DialogDecision = {
    source: optionId === 'mixed' ? 'mixed' : optionId === 'ready' ? 'ready' : 'zero',
    source_qty_from_ready: takeFromReady,
  };
  const nextContext: DialogContext = {
    ...ctx,
    take_from_ready: takeFromReady,
    make_from_zero: makeFromZero,
  };

  // 2-BOSQICH — evaluate the decoration components (krem/bezak) MINUS the
  // zagatovka. If one is short, ask Q2; otherwise resolve.
  const cream = await firstShortDecorationComponent(tx, session, zagatovkaProductId);
  if (cream !== null) {
    const creamContext: DialogContext = {
      ...nextContext,
      cream_product_id: cream.componentId,
      cream_short_name: cream.name,
      cream_have: cream.have,
      cream_need: cream.need,
      cream_is_semi: cream.isSemi,
    };
    const moved = await setState(
      tx,
      { ...session, context: creamContext, decision },
      'AWAITING_CREAM_CONFIRM',
      actorUserId,
      `source=${decision.source}`,
      { context: creamContext, decision },
    );
    return {
      session: moved,
      next_question: buildQuestion(moved),
      resolved: false,
      created_requests: created,
    };
  }

  // No short decoration material — resolve now.
  const resolved = await resolveDialog(tx, { ...session, context: nextContext }, decision, actorUserId);
  return { session: resolved, next_question: null, resolved: true, created_requests: created };
}

/**
 * Q2 — the cream/decoration-material confirm. "make" raises a production
 * sub-request for the semi component; "buy" raises a purchase request for the
 * shortfall. Then the dialog resolves.
 */
async function answerCreamConfirm(
  tx: TxClient,
  session: DialogSessionRow,
  optionId: string,
  actorUserId: number | null,
): Promise<AnswerResult> {
  const ctx = session.context;
  const creamProductId = Number(ctx.cream_product_id ?? 0);
  const have = Number(ctx.cream_have ?? 0);
  const need = Number(ctx.cream_need ?? 0);
  const shortfall = Math.max(0, need - have);
  const created: CreatedDocument[] = [];

  if (shortfall > 0 && creamProductId > 0) {
    if (optionId === 'make') {
      // OQ5 — the cream is a semi; request its PRODUCTION at the sex floor
      // (the replenishment engine routes a semi component through the
      // production path). One open request per (product, location) — debounce.
      const doc = await raiseSupplyRequest(tx, {
        productId: creamProductId,
        requesterLocationId: session.location_id, // produce at the sex floor
        qty: shortfall,
        actorUserId,
      });
      if (doc !== null) created.push(doc);
    } else {
      // "buy" — request the raw warehouse to top the component up.
      const rawWh = Number(ctx.raw_warehouse_id ?? 0) || session.location_id;
      const doc = await raiseSupplyRequest(tx, {
        productId: creamProductId,
        requesterLocationId: rawWh,
        qty: shortfall,
        actorUserId,
      });
      if (doc !== null) created.push(doc);
    }
  }

  const decision: DialogDecision = {
    ...(session.decision ?? {}),
    cream: optionId === 'make' ? 'make' : 'buy',
  };
  const resolved = await resolveDialog(tx, session, decision, actorUserId);
  return { session: resolved, next_question: null, resolved: true, created_requests: created };
}

// -----------------------------------------------------------------------------
// Document-raising helpers (conditional BOM expansion, ADR-0016 §4.1)
// -----------------------------------------------------------------------------

/**
 * Raise the zagatovka for `makeFromZero` units. Checks the base (hamir) BOM
 * raw against (sex_storage + raw_warehouse, check-first). If everything is on
 * hand, creates a zagatovka sub-production-order (stage_role='zagatovka',
 * target = sex_storage). If a base material is short, raises a purchase
 * request for the FIRST shortfall instead (the operator re-triggers once it
 * arrives). Returns the documents created.
 */
async function raiseZagatovka(
  tx: TxClient,
  session: DialogSessionRow,
  zagatovkaProductId: number,
  makeFromZero: number,
  actorUserId: number | null,
): Promise<CreatedDocument[]> {
  const ctx = session.context;
  const sexStorageId = Number(ctx.sex_storage_id ?? 0) || null;
  const rawWarehouseId = Number(ctx.raw_warehouse_id ?? 0) || null;
  const created: CreatedDocument[] = [];

  const baseBom = await readBaseBom(tx, zagatovkaProductId);

  // Find the first short base material (sex_storage + raw_wh, check-first).
  let firstShort: { componentId: number; shortfall: number } | null = null;
  for (const line of baseBom) {
    const lineNeed = line.qty_per_unit * makeFromZero;
    const sexHave = await readStockQty(tx, sexStorageId, line.component_product_id);
    const rawHave = await readStockQty(tx, rawWarehouseId, line.component_product_id);
    if (sexHave + rawHave < lineNeed) {
      firstShort = { componentId: line.component_product_id, shortfall: lineNeed - (sexHave + rawHave) };
      break;
    }
  }

  if (firstShort !== null) {
    // Base material short — request it from the raw warehouse first.
    const doc = await raiseSupplyRequest(tx, {
      productId: firstShort.componentId,
      requesterLocationId: rawWarehouseId ?? session.location_id,
      qty: firstShort.shortfall,
      actorUserId,
    });
    if (doc !== null) created.push(doc);
    return created;
  }

  // All base material on hand — create the zagatovka sub-order into sex_storage.
  if (sexStorageId === null) {
    throw AppError.validation(
      'Cannot raise a zagatovka sub-order — the production location has no sex_storage.',
    );
  }
  const subOrderId = await insertZagatovkaOrder(tx, {
    productId: zagatovkaProductId,
    qty: makeFromZero,
    productionLocationId: session.location_id,
    sexStorageId,
    parentProductionOrderId: session.production_order_id,
    replenishmentId: session.replenishment_id,
    actorUserId,
  });
  created.push({ type: 'production', id: subOrderId, product_id: zagatovkaProductId, qty: makeFromZero });
  return created;
}

/**
 * The first decoration component (other than the semi zagatovka) that is short
 * against (sex_storage + raw_warehouse). Returns null when every decoration
 * material is sufficient.
 */
async function firstShortDecorationComponent(
  tx: TxClient,
  session: DialogSessionRow,
  zagatovkaProductId: number,
): Promise<
  { componentId: number; name: string; have: number; need: number; isSemi: boolean } | null
> {
  const ctx = session.context;
  const sexStorageId = Number(ctx.sex_storage_id ?? 0) || null;
  const rawWarehouseId = Number(ctx.raw_warehouse_id ?? 0) || null;
  const deco = await readFinalBom(tx, session.product_id);
  const qtyOrdered = Number(session.qty_ordered);

  for (const line of deco) {
    if (line.component_product_id === zagatovkaProductId) continue; // skip the zagatovka itself
    const need = line.qty_per_unit * qtyOrdered;
    const sexHave = await readStockQty(tx, sexStorageId, line.component_product_id);
    const rawHave = await readStockQty(tx, rawWarehouseId, line.component_product_id);
    if (sexHave + rawHave < need) {
      const { rows } = await tx.query<{ name: string; type: string }>(
        'SELECT name, type::text AS type FROM products WHERE id = $1',
        [line.component_product_id],
      );
      const meta = rows[0];
      return {
        componentId: line.component_product_id,
        name: meta?.name ?? `#${line.component_product_id}`,
        have: sexHave + rawHave,
        need,
        isSemi: meta?.type === 'semi',
      };
    }
  }
  return null;
}

/**
 * Raise a replenishment request for a short material — the existing two-step
 * supply flow (invariant 7). Debounced: an existing open request for the same
 * (product, requester_location) returns null (OPEN_REQUEST_EXISTS swallowed),
 * so a re-answered dialog never duplicates a request (invariant 2).
 */
async function raiseSupplyRequest(
  tx: TxClient,
  opts: { productId: number; requesterLocationId: number; qty: number; actorUserId: number | null },
): Promise<CreatedDocument | null> {
  try {
    // The public `createRequest` opens its OWN transaction, but the dialog
    // resolve must stay atomic with the request insert (invariant 1) — so we
    // inline the same NEW-request INSERT + transition + audit here, inside the
    // dialog's transaction. The partial UNIQUE index still debounces duplicates.
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, qty_needed, status, note, created_by)
       VALUES ($1, $2, $3, 'NEW', $4, $5)
       RETURNING id`,
      [
        opts.productId,
        opts.requesterLocationId,
        opts.qty,
        'production dialog: material shortfall',
        opts.actorUserId,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw AppError.internal('Replenishment insert returned no row.');
    await tx.query(
      `INSERT INTO replenishment_transitions
         (replenishment_id, from_status, to_status, reason, actor_user_id)
       VALUES ($1, NULL, 'NEW', 'created (production dialog)', $2)`,
      [id, opts.actorUserId],
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.create',
      entity: 'replenishment_requests',
      entityId: id,
      payload: {
        product_id: opts.productId,
        requester_location_id: opts.requesterLocationId,
        qty_needed: opts.qty,
        source: 'production_dialog',
      },
    });
    return { type: 'purchase', id, product_id: opts.productId, qty: opts.qty };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // An open request already exists — debounce (invariant 2). Not an error.
      return null;
    }
    throw err;
  }
}

/** Insert a zagatovka sub-production-order targeting sex_storage. */
async function insertZagatovkaOrder(
  tx: TxClient,
  opts: {
    productId: number;
    qty: number;
    productionLocationId: number;
    sexStorageId: number;
    parentProductionOrderId: number | null;
    replenishmentId: number | null;
    actorUserId: number | null;
  },
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status,
        replenishment_id, stage_role, parent_production_order_id, created_by)
     VALUES ($1, $2, $3, $4, 'new', $5, 'zagatovka', $6, $7)
     RETURNING id`,
    [
      opts.productId,
      opts.qty,
      opts.productionLocationId,
      opts.sexStorageId,
      opts.replenishmentId,
      opts.parentProductionOrderId,
      opts.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw AppError.internal('Zagatovka order insert returned no row.');
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'production_order.create',
    entity: 'production_orders',
    entityId: id,
    payload: {
      product_id: opts.productId,
      qty: opts.qty,
      stage_role: 'zagatovka',
      target_location_id: opts.sexStorageId,
      parent_production_order_id: opts.parentProductionOrderId,
    },
  });
  return id;
}

// -----------------------------------------------------------------------------
// Cancel / expire
// -----------------------------------------------------------------------------

/** Cancel an open dialog (sex user / pm). Idempotent on terminal states. */
export async function cancelDialog(opts: {
  dialogId: number;
  actorUserId: number | null;
  reason?: string;
  tx?: TxClient;
}): Promise<DialogSessionRow> {
  const run = async (tx: TxClient): Promise<DialogSessionRow> => {
    const session = await lockDialog(tx, opts.dialogId);
    if (!OPEN_DIALOG_STATES.includes(session.state)) {
      return session; // already terminal — no-op.
    }
    return setState(tx, session, 'CANCELLED', opts.actorUserId, opts.reason ?? 'cancelled');
  };
  return opts.tx !== undefined ? run(opts.tx) : withTransaction(run);
}

/**
 * Cron entry point — stamp every open dialog whose `expires_at` has passed as
 * EXPIRED and notify PM (escalation, OQ4). It NEVER auto-creates documents; an
 * abandoned dialog stays side-effect-free and a human re-triggers the order.
 * Returns the count expired.
 */
export async function expireStaleDialogs(now: Date = new Date()): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<DialogSessionRow>(
      `UPDATE production_dialog_sessions
          SET state = 'EXPIRED', resolved_at = now()
        WHERE state IN ('AWAITING_SOURCE_DECISION','AWAITING_CREAM_CONFIRM')
          AND expires_at <= $1
        RETURNING ${DIALOG_COLUMNS}`,
      [now],
    );
    if (rows.length === 0) return 0;
    const pms = await getUsersByRole(tx, 'pm');
    for (const session of rows) {
      await writeAudit(tx, {
        actorUserId: null,
        action: 'production_dialog.expired',
        entity: 'production_dialog_sessions',
        entityId: session.id,
        payload: { product_id: session.product_id, qty_ordered: Number(session.qty_ordered) },
      });
      if (pms.length > 0) {
        await createNotificationsForRecipients(tx, pms, {
          type: 'production_order_created',
          title: `Ishlab chiqarish dialogi muddati o'tdi #${session.id}`,
          body:
            `Dialog #${session.id} (${Number(session.qty_ordered)} ta) javobsiz qoldi va ` +
            `muddati o'tdi. Iltimos, qo'lda tekshiring.`,
          payload: { dialog_id: session.id, product_id: session.product_id },
        });
      }
    }
    return rows.length;
  });
}

// -----------------------------------------------------------------------------
// Reads (route + telegram list)
// -----------------------------------------------------------------------------

/**
 * Open dialogs for a user. PM (or omitted user) sees every open dialog;
 * otherwise scoped to `assignedUserId` (the sex user the dialog belongs to).
 */
export async function listOpenDialogs(opts: {
  assignedUserId?: number | null;
  allLocations?: boolean;
}): Promise<Array<DialogSessionRow & { product_name: string; question: DialogQuestion | null }>> {
  const params: SqlParam[] = [];
  let where = `state IN ('AWAITING_SOURCE_DECISION','AWAITING_CREAM_CONFIRM')`;
  if (opts.allLocations !== true) {
    params.push(opts.assignedUserId ?? null);
    where += ` AND assigned_user_id IS NOT DISTINCT FROM $${params.length}`;
  }
  const { rows } = await query<DialogSessionRow & { product_name: string }>(
    `SELECT ${DIALOG_COLUMNS.split(',').map((c) => `d.${c.trim()}`).join(', ')},
            p.name AS product_name
       FROM production_dialog_sessions d
       JOIN products p ON p.id = d.product_id
      WHERE ${where}
      ORDER BY d.id DESC`,
    params,
  );
  return rows.map((r) => {
    const row = normalizeRow(r) as DialogSessionRow & { product_name: string };
    return { ...row, product_name: r.product_name, question: buildQuestion(row) };
  });
}

/** Fetch one dialog by id (or null). */
export async function getDialog(dialogId: number): Promise<DialogSessionRow | null> {
  const { rows } = await query<DialogSessionRow>(
    `SELECT ${DIALOG_COLUMNS} FROM production_dialog_sessions WHERE id = $1`,
    [dialogId],
  );
  return rows[0] !== undefined ? normalizeRow(rows[0]) : null;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

async function lockDialog(tx: TxClient, dialogId: number): Promise<DialogSessionRow> {
  const { rows } = await tx.query<DialogSessionRow>(
    `SELECT ${DIALOG_COLUMNS} FROM production_dialog_sessions WHERE id = $1 FOR UPDATE`,
    [dialogId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('Production dialog session not found.');
  }
  return normalizeRow(row);
}

/** Flip a dialog's state (+ optional context/decision) and audit it. */
async function setState(
  tx: TxClient,
  session: DialogSessionRow,
  to: DialogState,
  actorUserId: number | null,
  reason: string,
  extra?: { context?: DialogContext; decision?: DialogDecision },
): Promise<DialogSessionRow> {
  const sets: string[] = ['state = $2'];
  const params: SqlParam[] = [session.id, to];
  if (extra?.context !== undefined) {
    params.push(JSON.stringify(extra.context));
    sets.push(`context = $${params.length}::jsonb`);
  }
  if (extra?.decision !== undefined) {
    params.push(JSON.stringify(extra.decision));
    sets.push(`decision = $${params.length}::jsonb`);
  }
  if (to === 'RESOLVED' || to === 'EXPIRED' || to === 'CANCELLED') {
    sets.push('resolved_at = now()');
  }
  const { rows } = await tx.query<DialogSessionRow>(
    `UPDATE production_dialog_sessions SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING ${DIALOG_COLUMNS}`,
    params,
  );
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Dialog state update returned no row.');
  }
  await writeAudit(tx, {
    actorUserId,
    action: `production_dialog.${to.toLowerCase()}`,
    entity: 'production_dialog_sessions',
    entityId: session.id,
    payload: { from: session.state, to, reason },
  });
  return normalizeRow(updated);
}

/** Resolve a dialog — write the final decision + flip to RESOLVED. */
async function resolveDialog(
  tx: TxClient,
  session: DialogSessionRow,
  decision: DialogDecision,
  actorUserId: number | null,
): Promise<DialogSessionRow> {
  return setState(tx, session, 'RESOLVED', actorUserId, `resolved source=${decision.source ?? '-'}`, {
    context: session.context,
    decision,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

/** Coerce BIGINT/NUMERIC string columns to numbers; parse JSONB if needed. */
function normalizeRow<T extends DialogSessionRow>(row: T): T {
  return {
    ...row,
    id: Number(row.id),
    replenishment_id: row.replenishment_id === null ? null : Number(row.replenishment_id),
    production_order_id: row.production_order_id === null ? null : Number(row.production_order_id),
    product_id: Number(row.product_id),
    location_id: Number(row.location_id),
    assigned_user_id: row.assigned_user_id === null ? null : Number(row.assigned_user_id),
    qty_ordered: Number(row.qty_ordered),
    context: typeof row.context === 'string' ? JSON.parse(row.context) : (row.context ?? {}),
    decision:
      typeof row.decision === 'string' ? JSON.parse(row.decision) : (row.decision ?? null),
  };
}

// `BomLine` re-export keeps callers from importing two modules for the dialog.
export type { BomLine };
