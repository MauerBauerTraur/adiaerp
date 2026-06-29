/**
 * requestTracer — pure transform contract tests.
 *
 * Pins the state → node/edge mapping defined by TZ §3. The tracer is
 * the load-bearing piece that turns a `ReplenishmentDetail` into a
 * canvas overlay; if a future state-machine change breaks one of
 * these assertions, the canvas trace will silently mislead the owner,
 * so every transition gets its own test.
 */
import { describe, expect, it } from 'vitest';
import { buildRequestTrace, describeStatus } from './requestTracer';
import type {
  ReplenishmentDetail,
  ReplenishmentRequest,
  ReplenishmentStatus,
  ReplenishmentTransition,
} from '@/lib/types';

const REQUESTER_LOC = 7; // Do'kon Kokcha
const TARGET_LOC = 4; // Tort sklad
const PRODUCTION_GROUP = 'production-group';

const CTX = {
  productionParentId: PRODUCTION_GROUP,
  locationNodeId: (id: number) => `loc-${id}`,
  edgeId: (src: number, tgt: number) => `edge-loc-${src}-loc-${tgt}`,
};

function makeRequest(
  status: ReplenishmentStatus,
  overrides: Partial<ReplenishmentRequest> = {},
): ReplenishmentRequest {
  return {
    id: 100,
    product_id: 1,
    requester_location_id: REQUESTER_LOC,
    target_location_id: TARGET_LOC,
    qty_needed: 5,
    status,
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-05-25T08:00:00.000Z',
    updated_at: '2026-05-25T08:00:00.000Z',
    closed_at: null,
    product_name: 'Tort',
    product_unit: 'pcs',
    requester_location_name: 'Kokcha',
    target_location_name: 'Tort sklad',
    production_location_name: null,
    ...overrides,
  };
}

function makeTransition(
  id: number,
  to: ReplenishmentStatus,
  from: ReplenishmentStatus | null = null,
): ReplenishmentTransition {
  return {
    id,
    from_status: from,
    to_status: to,
    reason: null,
    actor_user_id: null,
    actor_name: null,
    created_at: '2026-05-25T08:00:00.000Z',
  };
}

function detail(
  status: ReplenishmentStatus,
  transitions: ReplenishmentTransition[],
  overrides?: Partial<ReplenishmentRequest>,
): ReplenishmentDetail {
  return {
    request: makeRequest(status, overrides),
    transitions,
  };
}

describe('buildRequestTrace', () => {
  it('marks the requester as done on a NEW request', () => {
    const trace = buildRequestTrace(
      detail('NEW', [makeTransition(1, 'NEW')]),
      CTX,
    );

    expect(trace.nodes.get(`loc-${REQUESTER_LOC}`)).toBe('active');
    expect(trace.currentStatus).toBe('NEW');
    expect(trace.isTerminal).toBe(false);
  });

  it('moves the active highlight to the supply target on CHECK_STORE_SUPPLIER', () => {
    const trace = buildRequestTrace(
      detail('CHECK_STORE_SUPPLIER', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CHECK_STORE_SUPPLIER', 'NEW'),
      ]),
      CTX,
    );

    expect(trace.nodes.get(`loc-${REQUESTER_LOC}`)).toBe('done');
    expect(trace.nodes.get(`loc-${TARGET_LOC}`)).toBe('active');
  });

  it('lights the production group parent on CHECK_PRODUCTION_INPUT', () => {
    const trace = buildRequestTrace(
      detail('CHECK_PRODUCTION_INPUT', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CHECK_STORE_SUPPLIER', 'NEW'),
        makeTransition(3, 'CHECK_PRODUCTION_INPUT', 'CHECK_STORE_SUPPLIER'),
      ]),
      CTX,
    );

    expect(trace.nodes.get(PRODUCTION_GROUP)).toBe('active');
    expect(trace.nodes.get(`loc-${TARGET_LOC}`)).toBe('done');
  });

  it('animates the supply→requester edge on SHIP_TO_REQUESTER', () => {
    const trace = buildRequestTrace(
      detail('SHIP_TO_REQUESTER', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CHECK_STORE_SUPPLIER', 'NEW'),
        makeTransition(3, 'SHIP_TO_REQUESTER', 'CHECK_STORE_SUPPLIER'),
      ]),
      CTX,
    );

    const edgeId = `edge-loc-${TARGET_LOC}-loc-${REQUESTER_LOC}`;
    expect(trace.edges.get(edgeId)).toBe('active');
  });

  it('freezes the trace as done when CLOSED', () => {
    const trace = buildRequestTrace(
      detail('CLOSED', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CHECK_STORE_SUPPLIER', 'NEW'),
        makeTransition(3, 'SHIP_TO_REQUESTER', 'CHECK_STORE_SUPPLIER'),
        makeTransition(4, 'CLOSED', 'SHIP_TO_REQUESTER'),
      ]),
      CTX,
    );

    expect(trace.isTerminal).toBe(true);
    // No node should be 'active' in a terminal trace.
    for (const state of trace.nodes.values()) {
      expect(state).not.toBe('active');
    }
    // The requester ends 'done'.
    expect(trace.nodes.get(`loc-${REQUESTER_LOC}`)).toBe('done');
  });

  it('handles CANCELLED gracefully (no extra highlight)', () => {
    const trace = buildRequestTrace(
      detail('CANCELLED', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CANCELLED', 'NEW'),
      ]),
      CTX,
    );

    expect(trace.isTerminal).toBe(true);
    expect(trace.currentStatus).toBe('CANCELLED');
    // No pulse anywhere.
    for (const state of trace.nodes.values()) {
      expect(state).not.toBe('active');
    }
  });

  it('skips highlights for locations not on the canvas', () => {
    const ctxWithoutTarget = {
      ...CTX,
      locationNodeId: (id: number) =>
        id === TARGET_LOC ? undefined : `loc-${id}`,
    };

    const trace = buildRequestTrace(
      detail('CHECK_STORE_SUPPLIER', [
        makeTransition(1, 'NEW'),
        makeTransition(2, 'CHECK_STORE_SUPPLIER', 'NEW'),
      ]),
      ctxWithoutTarget,
    );

    // Target is filtered, requester still marked.
    expect(trace.nodes.get(`loc-${TARGET_LOC}`)).toBeUndefined();
    expect(trace.nodes.get(`loc-${REQUESTER_LOC}`)).toBe('done');
  });

  it('falls back to request.status when transitions are empty', () => {
    const trace = buildRequestTrace(detail('NEW', []), CTX);
    expect(trace.currentStatus).toBe('NEW');
  });
});

describe('describeStatus', () => {
  it('returns a non-empty Uzbek phrase for every status', () => {
    const statuses: ReplenishmentStatus[] = [
      'NEW',
      'CHECK_STORE_SUPPLIER',
      'SHIP_TO_REQUESTER',
      'CHECK_PRODUCTION_INPUT',
      'CREATE_PURCHASE_ORDER',
      'CREATE_PRODUCTION_ORDER',
      'PRODUCING',
      'DONE_TO_WAREHOUSE',
      'CLOSED',
      'CANCELLED',
    ];
    for (const s of statuses) {
      const phrase = describeStatus(s);
      expect(phrase.length).toBeGreaterThan(0);
    }
  });

  it('prefixes PRODUCING with the sex name when provided', () => {
    expect(describeStatus('PRODUCING', 'Tort sexi')).toBe(
      'Tort sexi ishlab chiqarmoqda',
    );
  });

  it('prefixes CHECK_PRODUCTION_INPUT with the sex name when provided', () => {
    expect(describeStatus('CHECK_PRODUCTION_INPUT', 'Perojniy sexi')).toBe(
      'Perojniy sexi: xom-ashyo tekshirilmoqda',
    );
  });

  it('prefixes CREATE_PRODUCTION_ORDER with the sex name when provided', () => {
    expect(describeStatus('CREATE_PRODUCTION_ORDER', 'Tort sexi')).toBe(
      'Tort sexi buyurtmasi yaratildi',
    );
  });

  it('falls back to the generic copy when sexName is null', () => {
    expect(describeStatus('PRODUCING', null)).toBe('Sex ishlab chiqarmoqda');
    expect(describeStatus('CHECK_PRODUCTION_INPUT', null)).toBe(
      'Ishlab chiqarish: xom-ashyo tekshirilmoqda',
    );
    expect(describeStatus('CREATE_PRODUCTION_ORDER', null)).toBe(
      'Ishlab chiqarish buyurtmasi yaratildi',
    );
  });

  it('falls back to the generic copy when sexName is an empty/whitespace string', () => {
    expect(describeStatus('PRODUCING', '')).toBe('Sex ishlab chiqarmoqda');
    expect(describeStatus('PRODUCING', '   ')).toBe('Sex ishlab chiqarmoqda');
  });

  it('does not touch non-production statuses even when a sexName is supplied', () => {
    expect(describeStatus('NEW', 'Tort sexi')).toBe("Yangi — so'rov yaratildi");
    expect(describeStatus('SHIP_TO_REQUESTER', 'Tort sexi')).toBe(
      "Yo'lda — yetkazib berilmoqda",
    );
  });
});
