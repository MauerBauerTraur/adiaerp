/**
 * Phase A of ADR-0019 ("usta split"): a print-only split of one otdel's
 * daily nakladnoy per master (usta), built from EXISTING orders with no
 * backend change. Who makes an order is decided by name rules
 * (`USTA_RULES`); Phase B replaces them with real station assignments.
 *
 * Pure functions only — the HTML lives in `ustaSplitPrint.ts`.
 */
import type { ProductionDispatch } from '@/lib/types';
import type { OrderInfo } from './dispatchContext';

export type UstaRuleKey = 'krem_kaymokchi' | 'ukrasheniye' | 'biskvitchi' | 'zagotovkachi';
/** `aniqlanmagan`: raw lines whose order is not in the fetched range. */
export type UstaKey = UstaRuleKey | 'aniqlanmagan';

/** The fields a rule may look at — a subset of `OrderInfo`. */
export interface UstaOrderLike {
  product_name: string;
  parent_production_order_id: number | null;
}

export interface UstaRule {
  key: UstaRuleKey;
  label: string;
  matches: (order: UstaOrderLike) => boolean;
}

// Same needles as isKaymakProduct (KremKaymokchiPage.tsx), so a product lands
// on the kaymokchi's slip exactly when it appears on the Krem kaymokchi screen.
const KAYMOK_RE = /каймак|каймок|kaymak|kaymok/i;

/**
 * Phase A classification — FIRST match wins. Kept in one constant so Phase B
 * can swap it for real assignments.
 *
 * - Krem kaymok goes to its own master at any level (a stand-alone kaymak
 *   order is still made by the kaymokchi, who has a separate screen).
 * - A top-level order (no parent) is the final Г/П → Ukrasheniye.
 * - A sub-order named "бисквит…" → Biskvitchi.
 * - Every other sub-order (з/г, other creams, …) → Zagotovkachi.
 */
export const USTA_RULES: readonly UstaRule[] = [
  { key: 'krem_kaymokchi', label: 'Krem kaymokchi', matches: (o) => KAYMOK_RE.test(o.product_name) },
  { key: 'ukrasheniye', label: 'Ukrasheniye', matches: (o) => o.parent_production_order_id == null },
  {
    key: 'biskvitchi',
    label: 'Biskvitchi',
    matches: (o) => o.product_name.trim().toLowerCase().startsWith('бисквит'),
  },
  { key: 'zagotovkachi', label: 'Zagotovkachi', matches: () => true },
];

/** Slip / column order on paper: the way work flows through the otdel. */
export const USTA_DISPLAY_ORDER: readonly UstaKey[] = [
  'biskvitchi',
  'krem_kaymokchi',
  'zagotovkachi',
  'ukrasheniye',
  'aniqlanmagan',
];

const USTA_LABEL = new Map<UstaKey, string>([
  ...USTA_RULES.map((r) => [r.key, r.label] as const),
  ['aniqlanmagan', 'Aniqlanmagan (zayavka topilmadi)'],
]);

export function classifyUsta(order: UstaOrderLike): UstaRuleKey {
  const rule = USTA_RULES.find((r) => r.matches(order));
  // The last rule matches everything; the fallback only satisfies the types.
  return rule?.key ?? 'zagotovkachi';
}

export function ustaLabel(key: UstaKey): string {
  return USTA_LABEL.get(key) ?? key;
}

/**
 * What the warehouse physically hands out: `pcs` lines are rounded UP to a
 * whole unit — after aggregation, and after trimming float noise to 4
 * decimals (so 3.00000001 stays 3). Other units are unchanged. Display only;
 * stored quantities are not touched.
 */
export function displayQty(qty: number, unit: string): number {
  if (unit !== 'pcs') return qty;
  return Math.ceil(Math.round(qty * 1e4) / 1e4);
}

export interface UstaLine {
  product_name: string;
  unit: string;
  qty: number;
}

/** A group of lines received from one source or handed to one recipient. */
export interface UstaLineGroup {
  /** Who it comes from / goes to, as printed. */
  party: string;
  lines: UstaLine[];
}

export interface UstaSlip {
  key: UstaKey;
  label: string;
  orderCount: number;
  /** Raw materials from the warehouse — `pcs` already rounded up. */
  fromWarehouse: UstaLine[];
  /** Semi-finished parts made by another usta (or another otdel). */
  fromOthers: UstaLineGroup[];
  /** What this usta makes, grouped by who receives it. */
  handOver: UstaLineGroup[];
}

export interface UstaMatrixRow {
  product_name: string;
  unit: string;
  /** Displayed quantity per column (aligned with `columns`), 0 = empty. */
  cells: number[];
  /** Sum of the displayed cells — what physically leaves the warehouse. */
  total: number;
}

export interface UstaMatrix {
  columns: Array<{ key: UstaKey; label: string }>;
  rows: UstaMatrixRow[];
}

export interface UstaSplit {
  slips: UstaSlip[];
  matrix: UstaMatrix;
}

/** Printed recipient for an order made to stock with no target. */
export const DEFAULT_RECIPIENT = 'Склад';
/** Printed recipient when the parent is made by the same usta. */
export const INTERNAL_RECIPIENT = "O'zida ishlatiladi";

function isRawLine(item: ProductionDispatch): boolean {
  return item.from_location_type == null || item.from_location_type === 'raw_warehouse';
}

/** Sums lines with the same product and unit. */
class LineBag {
  private readonly lines = new Map<string, UstaLine>();

  add(product_name: string, unit: string, qty: number): void {
    const key = `${product_name}\u0000${unit}`;
    const line = this.lines.get(key);
    if (line) line.qty += qty;
    else this.lines.set(key, { product_name, unit, qty });
  }

  toArray(): UstaLine[] {
    return [...this.lines.values()].sort((a, b) => a.product_name.localeCompare(b.product_name));
  }
}

class GroupBag {
  private readonly groups = new Map<string, LineBag>();

  add(party: string, product_name: string, unit: string, qty: number): void {
    let bag = this.groups.get(party);
    if (!bag) {
      bag = new LineBag();
      this.groups.set(party, bag);
    }
    bag.add(product_name, unit, qty);
  }

  toArray(): UstaLineGroup[] {
    return [...this.groups.entries()]
      .map(([party, bag]) => ({ party, lines: bag.toArray() }))
      .sort((a, b) => a.party.localeCompare(b.party));
  }
}

/**
 * Splits one otdel's orders and raw-material dispatch lines per usta.
 *
 * @param items    the otdel's dispatch items (only raw-warehouse lines are used)
 * @param orderById every order of the date range (needed to walk parents/children)
 * @param otdelId  the otdel (`to_location_id` of the items); its orders are the
 *                 ones located there plus any order the items reference
 */
export function buildUstaSplit(
  items: readonly ProductionDispatch[],
  orderById: ReadonlyMap<number, OrderInfo>,
  otdelId: number | null,
): UstaSplit {
  const otdelOrders = new Map<number, OrderInfo>();
  for (const o of orderById.values()) {
    if (otdelId !== null && o.location_id === otdelId) otdelOrders.set(o.id, o);
  }
  for (const it of items) {
    const o = orderById.get(it.production_order_id);
    if (o) otdelOrders.set(o.id, o);
  }

  const ustaOf = new Map<number, UstaKey>();
  for (const o of otdelOrders.values()) ustaOf.set(o.id, classifyUsta(o));

  const childrenOf = new Map<number, OrderInfo[]>();
  for (const o of orderById.values()) {
    if (o.parent_production_order_id == null) continue;
    const list = childrenOf.get(o.parent_production_order_id) ?? [];
    list.push(o);
    childrenOf.set(o.parent_production_order_id, list);
  }

  const warehouse = new Map<UstaKey, LineBag>();
  const fromOthers = new Map<UstaKey, GroupBag>();
  const handOver = new Map<UstaKey, GroupBag>();
  const orderCount = new Map<UstaKey, number>();
  const bagFor = <T>(m: Map<UstaKey, T>, k: UstaKey, make: () => T): T => {
    let v = m.get(k);
    if (v === undefined) {
      v = make();
      m.set(k, v);
    }
    return v;
  };

  /** How another order's maker is printed, seen from this otdel. */
  const partyOf = (o: OrderInfo): { usta: UstaKey | null; label: string } => {
    if (otdelId !== null && o.location_id !== null && o.location_id !== otdelId) {
      return { usta: null, label: o.location_name ?? 'Boshqa sex' };
    }
    const k = ustaOf.get(o.id) ?? classifyUsta(o);
    return { usta: k, label: ustaLabel(k) };
  };

  // Raw materials from the warehouse, per the usta of the order they are for.
  for (const it of items) {
    if (!isRawLine(it)) continue;
    const usta = ustaOf.get(it.production_order_id);
    // An item whose order is outside the fetched range still has to be
    // weighed out: keep it on a slip of its own rather than guess the maker.
    const k: UstaKey = usta ?? 'aniqlanmagan';
    bagFor(warehouse, k, () => new LineBag()).add(it.product_name, it.product_unit, it.qty_needed);
  }

  for (const o of otdelOrders.values()) {
    const k = ustaOf.get(o.id) ?? classifyUsta(o);
    orderCount.set(k, (orderCount.get(k) ?? 0) + 1);

    // Parts this order needs from another usta's sub-orders.
    for (const child of childrenOf.get(o.id) ?? []) {
      const src = partyOf(child);
      if (src.usta === k) continue; // made by the same usta: internal work
      bagFor(fromOthers, k, () => new GroupBag()).add(src.label, child.product_name, child.unit, child.qty);
    }

    // What this order becomes and who receives it.
    let recipient: string;
    if (o.parent_production_order_id == null) {
      recipient = o.target_location_name ?? DEFAULT_RECIPIENT;
    } else {
      const parent = orderById.get(o.parent_production_order_id);
      if (parent) {
        const dst = partyOf(parent);
        recipient = dst.usta === k ? INTERNAL_RECIPIENT : dst.label;
      } else {
        // The parent is outside the fetched range: classify it from the
        // flattened parent_* columns.
        const pk = classifyUsta({
          product_name: o.parent_product_name ?? '',
          parent_production_order_id: o.grandparent_production_order_id,
        });
        recipient = pk === k ? INTERNAL_RECIPIENT : ustaLabel(pk);
      }
    }
    bagFor(handOver, k, () => new GroupBag()).add(recipient, o.product_name, o.unit, o.qty);
  }

  const slips: UstaSlip[] = [];
  for (const k of USTA_DISPLAY_ORDER) {
    const slip: UstaSlip = {
      key: k,
      label: ustaLabel(k),
      orderCount: orderCount.get(k) ?? 0,
      fromWarehouse: (warehouse.get(k)?.toArray() ?? []).map((l) => ({
        ...l,
        qty: displayQty(l.qty, l.unit),
      })),
      fromOthers: fromOthers.get(k)?.toArray() ?? [],
      handOver: handOver.get(k)?.toArray() ?? [],
    };
    // Skip ustas with nothing to show.
    if (slip.fromWarehouse.length + slip.fromOthers.length + slip.handOver.length > 0) {
      slips.push(slip);
    }
  }

  return { slips, matrix: buildUstaMatrix(slips) };
}

/** Raw materials x ustas, from the slips' already-rounded warehouse lines. */
function buildUstaMatrix(slips: readonly UstaSlip[]): UstaMatrix {
  const withRaw = slips.filter((s) => s.fromWarehouse.length > 0);
  const columns = withRaw.map((s) => ({ key: s.key, label: s.label }));
  const rowByKey = new Map<string, UstaMatrixRow>();
  withRaw.forEach((slip, col) => {
    for (const line of slip.fromWarehouse) {
      const key = `${line.product_name}\u0000${line.unit}`;
      let row = rowByKey.get(key);
      if (!row) {
        row = { product_name: line.product_name, unit: line.unit, cells: columns.map(() => 0), total: 0 };
        rowByKey.set(key, row);
      }
      row.cells[col] = (row.cells[col] ?? 0) + line.qty;
    }
  });
  const rows = [...rowByKey.values()]
    .map((r) => ({ ...r, total: r.cells.reduce((s, v) => s + v, 0) }))
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
  return { columns, rows };
}
