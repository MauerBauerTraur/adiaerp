import { describe, expect, it } from 'vitest';
import type { ProductionDispatch } from '@/lib/types';
import type { OrderInfo } from './dispatchContext';
import {
  buildUstaSplit,
  classifyUsta,
  displayQty,
  DEFAULT_RECIPIENT,
  INTERNAL_RECIPIENT,
  USTA_RULES,
  type UstaSlip,
} from './ustaSplit';
import { buildUstaSplitHtml } from './ustaSplitPrint';

const OTDEL = 7;

function order(over: Partial<OrderInfo> & Pick<OrderInfo, 'id' | 'product_name'>): OrderInfo {
  return {
    product_id: over.id * 10,
    qty: 1,
    unit: 'kg',
    location_id: OTDEL,
    location_name: 'Оформления отдел',
    product_type: 'semi',
    production_cost: null,
    target_location_name: null,
    parent_production_order_id: null,
    parent_product_name: null,
    parent_unit: null,
    parent_qty: null,
    parent_production_cost: null,
    grandparent_production_order_id: null,
    grandparent_product_name: null,
    grandparent_unit: null,
    grandparent_qty: null,
    grandparent_production_cost: null,
    ...over,
  };
}

let nextItemId = 1;
function raw(orderId: number, product_name: string, qty_needed: number, product_unit = 'kg'): ProductionDispatch {
  return {
    id: nextItemId++,
    production_order_id: orderId,
    product_id: 900 + nextItemId,
    product_name,
    product_unit,
    qty_needed,
    status: 'pending',
    from_location_id: 1,
    from_location_name: 'Xom-ashyo ombori',
    from_location_type: 'raw_warehouse',
    product_type: 'raw',
    to_location_id: OTDEL,
    to_location_name: 'Оформления отдел',
    movement_id: null,
    created_at: '2026-09-28T06:00:00Z',
    dispatched_at: null,
    dispatched_by: null,
    received_at: null,
    received_by: null,
  };
}

/**
 * Г/П МЕДОВИК (top level) ← з/г медовик ← бисквит медовый; the Г/П also
 * needs крем каймак, and the з/г needs крем масляный (same master).
 */
const GP = order({ id: 101, product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ', qty: 10, unit: 'pcs', product_type: 'gp' });
const ZG = order({ id: 102, product_name: 'з/г медовик шок', qty: 10, unit: 'pcs', parent_production_order_id: 101, parent_product_name: GP.product_name });
const BISKVIT = order({ id: 103, product_name: 'бисквит медовый', qty: 2.5, parent_production_order_id: 102, parent_product_name: ZG.product_name, grandparent_production_order_id: 101 });
const KAYMAK = order({ id: 104, product_name: 'крем каймак', qty: 1.2, parent_production_order_id: 101, parent_product_name: GP.product_name });
const MASLO_KREM = order({ id: 105, product_name: 'крем масляный', qty: 0.8, parent_production_order_id: 102, parent_product_name: ZG.product_name });

const ORDERS = new Map([GP, ZG, BISKVIT, KAYMAK, MASLO_KREM].map((o) => [o.id, o]));

const ITEMS: ProductionDispatch[] = [
  raw(103, 'мука', 1.2),
  raw(103, 'яйцо', 2.3, 'pcs'),
  raw(102, 'сахар', 0.5),
  raw(102, 'яйцо', 1.2, 'pcs'),
  raw(104, 'сливки', 0.9, 'l'),
  raw(101, 'шоколад', 0.3),
  raw(105, 'масло', 0.4),
];

const slipOf = (slips: UstaSlip[], key: UstaSlip['key']) => {
  const s = slips.find((x) => x.key === key);
  if (!s) throw new Error(`no slip ${key}`);
  return s;
};
const lines = (ls: Array<{ product_name: string; qty: number; unit: string }>) =>
  ls.map((l) => `${l.product_name} ${l.qty} ${l.unit}`);

describe('classifyUsta — Phase A name rules', () => {
  const top = (product_name: string) => ({ product_name, parent_production_order_id: null });
  const sub = (product_name: string) => ({ product_name, parent_production_order_id: 1 });

  it('a top-level (final Г/П) order → Ukrasheniye', () => {
    expect(classifyUsta(top('Г/П МЕДОВИК ШОК ЧЕРНЫЙ'))).toBe('ukrasheniye');
    // "starts with бисквит" applies to sub-orders only.
    expect(classifyUsta(top('бисквит медовый'))).toBe('ukrasheniye');
  });

  it('a sub-order starting with "бисквит" (case-insensitive, trimmed) → Biskvitchi', () => {
    expect(classifyUsta(sub('бисквит медовый'))).toBe('biskvitchi');
    expect(classifyUsta(sub('  Бисквит шоколадный '))).toBe('biskvitchi');
    expect(classifyUsta(sub('БИСКВИТ'))).toBe('biskvitchi');
    // Contains but does not start with it.
    expect(classifyUsta(sub('торт бисквитный'))).toBe('zagotovkachi');
  });

  it('krem kaymak / kaymok → Krem kaymokchi, at any level', () => {
    expect(classifyUsta(sub('крем каймак'))).toBe('krem_kaymokchi');
    expect(classifyUsta(sub('Крем  каймак (какао)'))).toBe('krem_kaymokchi');
    expect(classifyUsta(sub('крем каймок с ичной'))).toBe('krem_kaymokchi');
    expect(classifyUsta(sub('каймок варёный'))).toBe('krem_kaymokchi');
    expect(classifyUsta(top('крем каймак'))).toBe('krem_kaymokchi');
  });

  it('any other sub-order → Zagotovkachi', () => {
    for (const name of ['з/г медовик', 'крем масляный', 'зувала', 'баунти крем']) {
      expect(classifyUsta(sub(name))).toBe('zagotovkachi');
    }
  });

  it('keeps all rules in one exported constant, ending with a catch-all', () => {
    expect(USTA_RULES.map((r) => r.key)).toEqual(['krem_kaymokchi', 'ukrasheniye', 'biskvitchi', 'zagotovkachi']);
    expect(USTA_RULES.at(-1)?.matches({ product_name: 'x', parent_production_order_id: 5 })).toBe(true);
  });
});

describe('displayQty — pcs rounded up, after aggregation', () => {
  it('rounds pcs up to a whole unit, ignoring float noise', () => {
    expect(displayQty(2.3, 'pcs')).toBe(3);
    expect(displayQty(2, 'pcs')).toBe(2);
    expect(displayQty(3.00000001, 'pcs')).toBe(3);
    expect(displayQty(0.1 + 0.2, 'pcs')).toBe(1);
  });

  it('leaves other units alone', () => {
    expect(displayQty(2.3, 'kg')).toBe(2.3);
    expect(displayQty(0.125, 'l')).toBe(0.125);
  });

  it('sums first, then rounds (0.4 + 0.4 eggs → 1, not 2)', () => {
    const { slips } = buildUstaSplit([raw(102, 'яйцо', 0.4, 'pcs'), raw(102, 'яйцо', 0.4, 'pcs')], ORDERS, OTDEL);
    expect(lines(slipOf(slips, 'zagotovkachi').fromWarehouse)).toEqual(['яйцо 1 pcs']);
  });
});

describe('buildUstaSplit — slips', () => {
  const { slips, matrix } = buildUstaSplit(ITEMS, ORDERS, OTDEL);

  it('one slip per usta with something to show, in work-flow order', () => {
    expect(slips.map((s) => s.key)).toEqual(['biskvitchi', 'krem_kaymokchi', 'zagotovkachi', 'ukrasheniye']);
    expect(slips.map((s) => s.orderCount)).toEqual([1, 1, 2, 1]);
  });

  it('Biskvitchi: raw from the warehouse, hands the бисквит to Zagotovkachi', () => {
    const s = slipOf(slips, 'biskvitchi');
    expect(lines(s.fromWarehouse)).toEqual(['мука 1.2 kg', 'яйцо 3 pcs']);
    expect(s.fromOthers).toEqual([]);
    expect(s.handOver).toEqual([{ party: 'Zagotovkachi', lines: [{ product_name: 'бисквит медовый', unit: 'kg', qty: 2.5 }] }]);
  });

  it('Zagotovkachi: gets the бисквит from Biskvitchi; its own cream is internal', () => {
    const s = slipOf(slips, 'zagotovkachi');
    expect(lines(s.fromWarehouse)).toEqual(['масло 0.4 kg', 'сахар 0.5 kg', 'яйцо 2 pcs']);
    expect(s.fromOthers).toEqual([{ party: 'Biskvitchi', lines: [{ product_name: 'бисквит медовый', unit: 'kg', qty: 2.5 }] }]);
    expect(s.handOver).toEqual([
      { party: INTERNAL_RECIPIENT, lines: [{ product_name: 'крем масляный', unit: 'kg', qty: 0.8 }] },
      { party: 'Ukrasheniye', lines: [{ product_name: 'з/г медовик шок', unit: 'pcs', qty: 10 }] },
    ]);
  });

  it('Krem kaymokchi: hands the kaymak to Ukrasheniye', () => {
    const s = slipOf(slips, 'krem_kaymokchi');
    expect(lines(s.fromWarehouse)).toEqual(['сливки 0.9 l']);
    expect(s.handOver).toEqual([{ party: 'Ukrasheniye', lines: [{ product_name: 'крем каймак', unit: 'kg', qty: 1.2 }] }]);
  });

  it('Ukrasheniye: gets з/г and kaymak from the other ustas, hands the Г/П to the warehouse', () => {
    const s = slipOf(slips, 'ukrasheniye');
    expect(lines(s.fromWarehouse)).toEqual(['шоколад 0.3 kg']);
    expect(s.fromOthers).toEqual([
      { party: 'Krem kaymokchi', lines: [{ product_name: 'крем каймак', unit: 'kg', qty: 1.2 }] },
      { party: 'Zagotovkachi', lines: [{ product_name: 'з/г медовик шок', unit: 'pcs', qty: 10 }] },
    ]);
    expect(s.handOver).toEqual([{ party: DEFAULT_RECIPIENT, lines: [{ product_name: GP.product_name, unit: 'pcs', qty: 10 }] }]);
  });

  it('a top-level order with a target hands over to that target', () => {
    const withTarget = new Map(ORDERS);
    withTarget.set(101, { ...GP, target_location_name: 'Markaziy sklad' });
    const s = slipOf(buildUstaSplit(ITEMS, withTarget, OTDEL).slips, 'ukrasheniye');
    expect(s.handOver.map((g) => g.party)).toEqual(['Markaziy sklad']);
  });

  it('a part made in another otdel is received from that otdel', () => {
    const cross = new Map(ORDERS);
    cross.set(103, { ...BISKVIT, location_id: 9, location_name: 'Бисквит цех' });
    const { slips: s } = buildUstaSplit(ITEMS.filter((i) => i.production_order_id !== 103), cross, OTDEL);
    expect(slipOf(s, 'zagotovkachi').fromOthers.map((g) => g.party)).toEqual(['Бисквит цех']);
    expect(s.some((x) => x.key === 'biskvitchi')).toBe(false);
  });

  it('skips ustas with nothing to show — an otdel with only top-level orders is all Ukrasheniye', () => {
    const only = new Map([[GP.id, GP]]);
    const { slips: s } = buildUstaSplit([raw(101, 'шоколад', 0.3)], only, OTDEL);
    expect(s.map((x) => x.key)).toEqual(['ukrasheniye']);
  });

  it('a raw line whose order was not loaded is kept on its own slip', () => {
    const { slips: s } = buildUstaSplit([raw(999, 'ванилин', 0.01)], ORDERS, OTDEL);
    expect(lines(slipOf(s, 'aniqlanmagan').fromWarehouse)).toEqual(['ванилин 0.01 kg']);
  });

  it('matrix: raw materials x ustas, empty cells for zero, Jami = sum of displayed cells', () => {
    expect(matrix.columns.map((c) => c.label)).toEqual(['Biskvitchi', 'Krem kaymokchi', 'Zagotovkachi', 'Ukrasheniye']);
    const egg = matrix.rows.find((r) => r.product_name === 'яйцо');
    // 2.3 → 3 and 1.2 → 2: the warehouse hands out 5 eggs, not 4 (3.5 rounded).
    expect(egg?.cells).toEqual([3, 0, 2, 0]);
    expect(egg?.total).toBe(5);
    const sugar = matrix.rows.find((r) => r.product_name === 'сахар');
    expect(sugar?.cells).toEqual([0, 0, 0.5, 0]);
    expect(sugar?.total).toBe(0.5);
    expect(matrix.rows.map((r) => r.product_name)).toEqual(['масло', 'мука', 'сахар', 'сливки', 'шоколад', 'яйцо']);
  });
});

describe('buildUstaSplitHtml', () => {
  const html = buildUstaSplitHtml(buildUstaSplit(ITEMS, ORDERS, OTDEL), {
    otdelName: 'Оформления <отдел>',
    dateLabel: '2026-09-28',
  });

  it('prints each usta slip with its sections and signature lines', () => {
    expect(html.match(/class="slip"/g)).toHaveLength(4);
    expect(html).toContain('Oladi — ombordan');
    expect(html).toContain('Oladi — Biskvitchidan');
    expect(html).toContain('Oladi — Zagotovkachidan');
    expect(html).toContain('Topshiradi → Ukrasheniye');
    expect(html).toContain(`Topshiradi → ${DEFAULT_RECIPIENT}`);
    expect(html.match(/Berdi \(skladchi\)/g)?.length).toBe(5); // 4 slips + matrix
    expect(html.match(/Qabul qildi/g)).toHaveLength(4);
  });

  it('local number format, dona for pcs, empty zero cells, landscape matrix page', () => {
    expect(html).toContain('<td class="num">1,2</td>');
    expect(html).toContain('<td class="unit">dona</td>');
    expect(html).toContain('<td class="num"></td>');
    expect(html).toContain('@page matrix { size: A4 landscape');
    expect(html).toContain('<td>Imzo</td>');
  });

  it('escapes names', () => {
    expect(html).toContain('Оформления &lt;отдел&gt;');
    expect(html).not.toContain('<отдел>');
  });
});
