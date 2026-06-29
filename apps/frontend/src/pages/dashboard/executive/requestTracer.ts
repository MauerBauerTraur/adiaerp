/**
 * Replenishment request → canvas trace overlay.
 *
 * Given a `ReplenishmentDetail` (request + `replenishment_transitions[]`),
 * compute which canvas nodes light up green ("bajarildi"), yellow ("hozir
 * shu yerda"), or stay neutral ("kelajak / aloqasiz"), and which edges
 * carry the "moving dot" animation.
 *
 * The transform is pure and read-only — TZ §3 owns the state machine,
 * we only *show* what the backend recorded.
 *
 * State → node mapping (canonical, per backend services/replenishment.ts):
 *
 *   NEW                       requester (origin highlight)
 *   CHECK_STORE_SUPPLIER      target (a supply warehouse)
 *   CHECK_PRODUCTION_INPUT    production parent
 *   CREATE_PURCHASE_ORDER     raw_warehouse + supplier (PO created)
 *   CREATE_PRODUCTION_ORDER   production parent (about to start)
 *   PRODUCING                 the sex that holds the production_order
 *   DONE_TO_WAREHOUSE         target supply (output back into stock)
 *   SHIP_TO_REQUESTER         edge: target → requester (the last hop)
 *   CLOSED                    requester (delivered)
 *   CANCELLED                 no highlight; the trace ends grey
 *
 * The currently-active state ("yellow / pulsing") is whichever transition
 * was the last appended; everything before it is "done"; everything not
 * yet visited stays neutral.
 */
import type {
  ReplenishmentDetail,
  ReplenishmentStatus,
  ReplenishmentTransition,
} from '@/lib/types';

/** Visual state per node id. */
export type TraceNodeState = 'done' | 'active' | 'idle';

/** Visual state per edge id (same vocabulary). */
export type TraceEdgeState = 'done' | 'active' | 'idle';

export interface RequestTrace {
  /** Map of node id → visual state. Unlisted nodes stay 'idle'. */
  nodes: Map<string, TraceNodeState>;
  /** Map of edge id → visual state. Unlisted edges stay 'idle'. */
  edges: Map<string, TraceEdgeState>;
  /** Latest transition's `to_status` — drives banner copy and pulse. */
  currentStatus: ReplenishmentStatus;
  /** True for terminal CLOSED / CANCELLED — no more animation. */
  isTerminal: boolean;
}

/**
 * Inputs the tracer needs *beyond* the request detail itself: the canvas
 * already knows which `location_id` belongs to which supply/raw/store
 * node, but the tracer has no canvas context, so the caller passes a
 * small lookup.
 */
export interface TracerContext {
  /** The Ishlab Chiqarish parent group node id (always present). */
  productionParentId: string;
  /**
   * Map a `location_id` → React Flow node id. Missing entries mean the
   * location is not on the canvas (e.g. filtered store) and the tracer
   * skips the highlight rather than crashing.
   */
  locationNodeId: (locationId: number) => string | undefined;
  /**
   * Build the edge id between two locations. The canvas adapter and the
   * tracer must agree on the id scheme, so we delegate construction
   * back to the caller. Returns `undefined` if no such edge exists.
   */
  edgeId: (sourceLocationId: number, targetLocationId: number) => string | undefined;
}

/**
 * Build the full trace overlay. Walks transitions in order, marking
 * each visited target node 'done', then upgrades the *last* visited
 * node to 'active' (unless the request is in a terminal state, in
 * which case the last node stays 'done').
 */
export function buildRequestTrace(
  detail: ReplenishmentDetail,
  ctx: TracerContext,
): RequestTrace {
  const nodes = new Map<string, TraceNodeState>();
  const edges = new Map<string, TraceEdgeState>();

  const transitions = [...detail.transitions].sort((a, b) => a.id - b.id);
  const lastTransition = transitions[transitions.length - 1] ?? null;
  const currentStatus: ReplenishmentStatus =
    (lastTransition?.to_status as ReplenishmentStatus | undefined) ??
    detail.request.status;
  const isTerminal =
    currentStatus === 'CLOSED' || currentStatus === 'CANCELLED';

  const requesterNode = ctx.locationNodeId(
    detail.request.requester_location_id,
  );

  // Always mark the origin (requester) so the "where it came from" is
  // visible even on a brand-new request with a single NEW transition.
  if (requesterNode) nodes.set(requesterNode, 'done');

  for (let i = 0; i < transitions.length; i += 1) {
    const t = transitions[i];
    if (t === undefined) continue;
    applyStateToTrace(t.to_status as ReplenishmentStatus, detail, ctx, nodes, edges);
  }

  // Upgrade the most recent node touched to 'active' (pulse) — but only
  // if the request is still live. Terminal requests keep everything 'done'.
  if (!isTerminal && lastTransition) {
    const activeNodeId = pickActiveNodeId(
      lastTransition.to_status as ReplenishmentStatus,
      detail,
      ctx,
    );
    if (activeNodeId !== undefined) {
      nodes.set(activeNodeId, 'active');
    }
    // Also mark the *incoming* edge to that node as 'active' so a
    // "moving dot" can ride into the current location. Picked
    // heuristically below.
    const activeEdgeId = pickActiveEdgeId(
      lastTransition.to_status as ReplenishmentStatus,
      detail,
      ctx,
    );
    if (activeEdgeId !== undefined) {
      edges.set(activeEdgeId, 'active');
    }
  }

  return { nodes, edges, currentStatus, isTerminal };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyStateToTrace(
  status: ReplenishmentStatus,
  detail: ReplenishmentDetail,
  ctx: TracerContext,
  nodes: Map<string, TraceNodeState>,
  edges: Map<string, TraceEdgeState>,
): void {
  const req = detail.request;
  const requesterNode = ctx.locationNodeId(req.requester_location_id);
  const targetNode =
    req.target_location_id === null
      ? undefined
      : ctx.locationNodeId(req.target_location_id);

  const mark = (nodeId: string | undefined) => {
    if (nodeId !== undefined) nodes.set(nodeId, 'done');
  };
  const markEdge = (edgeId: string | undefined) => {
    if (edgeId !== undefined) edges.set(edgeId, 'done');
  };

  switch (status) {
    case 'NEW':
      mark(requesterNode);
      break;
    case 'CHECK_STORE_SUPPLIER':
      mark(targetNode);
      break;
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PRODUCTION_ORDER':
      mark(ctx.productionParentId);
      break;
    case 'PRODUCING':
      mark(ctx.productionParentId);
      // The specific sex node is unknown without the linked
      // production_order's location_id — that lives on the request row
      // (`production_order_id`) but we don't have the join here. The
      // canvas paints the parent; sex-level highlight is a Faza B+
      // refinement.
      break;
    case 'DONE_TO_WAREHOUSE':
      mark(ctx.productionParentId);
      mark(targetNode);
      break;
    case 'CREATE_PURCHASE_ORDER':
      // Raw + supplier highlight; we don't know which raw warehouse
      // without a join, so we leave the canvas adapter to expose its
      // single raw node id via a fixed lookup the caller can wire up.
      break;
    case 'SHIP_TO_REQUESTER':
      mark(targetNode);
      mark(requesterNode);
      if (req.target_location_id !== null) {
        markEdge(ctx.edgeId(req.target_location_id, req.requester_location_id));
      }
      break;
    case 'CLOSED':
      mark(requesterNode);
      break;
    case 'CANCELLED':
      // No additional highlight — the trace freezes wherever it was.
      break;
  }
}

function pickActiveNodeId(
  status: ReplenishmentStatus,
  detail: ReplenishmentDetail,
  ctx: TracerContext,
): string | undefined {
  const req = detail.request;
  const targetNode =
    req.target_location_id === null
      ? undefined
      : ctx.locationNodeId(req.target_location_id);
  const requesterNode = ctx.locationNodeId(req.requester_location_id);

  switch (status) {
    case 'NEW':
      return requesterNode;
    case 'CHECK_STORE_SUPPLIER':
    case 'DONE_TO_WAREHOUSE':
      return targetNode;
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PRODUCTION_ORDER':
    case 'PRODUCING':
      return ctx.productionParentId;
    case 'SHIP_TO_REQUESTER':
      return requesterNode;
    case 'CLOSED':
    case 'CANCELLED':
    case 'CREATE_PURCHASE_ORDER':
      return undefined;
  }
}

function pickActiveEdgeId(
  status: ReplenishmentStatus,
  detail: ReplenishmentDetail,
  ctx: TracerContext,
): string | undefined {
  const req = detail.request;
  if (status === 'SHIP_TO_REQUESTER' && req.target_location_id !== null) {
    return ctx.edgeId(req.target_location_id, req.requester_location_id);
  }
  return undefined;
}

/**
 * Build a tiny human-readable summary of the trace for the o'ng panel.
 * Pure function — testable in isolation.
 */
export function describeStatus(
  status: ReplenishmentStatus,
  sexName?: string | null,
): string {
  const sex = sexName?.trim();
  switch (status) {
    case 'NEW':
      return "Yangi — so'rov yaratildi";
    case 'CHECK_STORE_SUPPLIER':
      return 'Sklad tekshirmoqda';
    case 'SHIP_TO_REQUESTER':
      return "Yo'lda — yetkazib berilmoqda";
    case 'CHECK_PRODUCTION_INPUT':
      // With a known sex: "Tort sexi: xom-ashyo tekshirilmoqda".
      return sex
        ? `${sex}: xom-ashyo tekshirilmoqda`
        : 'Ishlab chiqarish: xom-ashyo tekshirilmoqda';
    case 'CREATE_PURCHASE_ORDER':
      return 'Yetkazib beruvchiga buyurtma berildi';
    case 'CREATE_PRODUCTION_ORDER':
      // With a known sex: "Tort sexi buyurtmasi yaratildi".
      return sex
        ? `${sex} buyurtmasi yaratildi`
        : 'Ishlab chiqarish buyurtmasi yaratildi';
    case 'PRODUCING':
      // With a known sex: "Tort sexi ishlab chiqarmoqda" (egasining asosiy
      // talabi — generik "Sex" o'rniga aniq sex nomi ko'rinsin).
      return sex ? `${sex} ishlab chiqarmoqda` : 'Sex ishlab chiqarmoqda';
    case 'DONE_TO_WAREHOUSE':
      return 'Skladga keldi';
    case 'CLOSED':
      return 'Yetkazildi';
    case 'CANCELLED':
      return 'Bekor qilindi';
  }
}

/**
 * Helper for the `ActiveRequestsPanel` — one-liner per request used in
 * the list item ("Kokcha · Tort · 5 dona · Sex ishlab chiqarmoqda").
 */
export function describeRequest(
  args: {
    requester_location_name: string;
    product_name: string;
    qty_needed: number;
    product_unit: string;
    status: ReplenishmentStatus;
    production_location_name?: string | null;
  },
): string {
  return `${args.requester_location_name} · ${args.product_name} · ${args.qty_needed} ${args.product_unit} · ${describeStatus(args.status, args.production_location_name)}`;
}

/**
 * Re-exported for the canvas component — keep this here so the tracer
 * stays the single source of truth for what a transition "means".
 */
export type { ReplenishmentTransition };
