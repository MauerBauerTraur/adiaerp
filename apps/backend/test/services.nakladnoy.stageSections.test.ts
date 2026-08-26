/**
 * Owner requirement: a stage set BY HAND in the recipe modal must reach the
 * nakladnoy in the same section a Poster-synced stage does — nothing silently
 * drops out of the document.
 *
 * expandToNakladnoy is pure, so this drives it directly with a hand-built tree:
 *   base | dough | other  -> hamir
 *   decoration | cream    -> krem
 *   assembly              -> bezak
 */
import { describe, expect, it } from 'vitest';
import { expandToNakladnoy } from '../src/services/nakladnoy.js';

type Row = Parameters<typeof expandToNakladnoy>[0] extends Map<number, infer R>
  ? R extends readonly (infer E)[] ? E : never
  : never;

const ROOT = 1;

function line(componentId: number, name: string, stage: string, qty = 1): Row {
  return {
    product_id: ROOT,
    component_product_id: componentId,
    component_name: name,
    component_type: 'raw',
    component_unit: 'kg',
    qty_per_unit: qty,
    stage,
  } as unknown as Row;
}

function sectionsFor(stage: string): Record<string, string[]> {
  const tree = new Map<number, Row[]>([[ROOT, [line(10, `x_${stage}`, stage)]]]);
  const out = expandToNakladnoy(tree, ROOT, 1);
  const bySection: Record<string, string[]> = {};
  for (const l of out) {
    const s = (l as unknown as { section: string }).section;
    (bySection[s] ??= []).push((l as unknown as { label: string }).label);
  }
  return bySection;
}

describe('expandToNakladnoy — every stage reaches a section', () => {
  it('routes the hamir family to hamir', () => {
    for (const stage of ['base', 'dough', 'other']) {
      const s = sectionsFor(stage);
      expect(s.hamir, `stage=${stage}`).toContain(`x_${stage}`);
    }
  });

  it('routes the krem family to krem', () => {
    for (const stage of ['decoration', 'cream']) {
      const s = sectionsFor(stage);
      expect(s.krem, `stage=${stage}`).toContain(`x_${stage}`);
    }
  });

  it('routes assembly to bezak', () => {
    expect(sectionsFor('assembly').bezak).toContain('x_assembly');
  });

  it('never drops a line, whatever the stage', () => {
    for (const stage of ['base', 'dough', 'cream', 'decoration', 'assembly', 'other']) {
      const placed = Object.values(sectionsFor(stage)).flat();
      expect(placed, `stage=${stage} must appear somewhere`).toContain(`x_${stage}`);
    }
  });
});
