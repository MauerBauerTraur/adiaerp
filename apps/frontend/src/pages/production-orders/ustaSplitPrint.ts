/**
 * Print page for the Phase A usta split (ADR-0019 §8): one slip per usta,
 * then the otdel matrix (raw materials x ustas) on a landscape page.
 * Same look as the other dispatch prints: Arial, light #ddd borders.
 */
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { Unit } from '@/lib/types';
import { USTA_RULES, type UstaLine, type UstaLineGroup, type UstaSplit } from './ustaSplit';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unitLabel(unit: string): string {
  return UNIT_LABELS[unit as Unit] ?? unit;
}

function qty(n: number): string {
  return n === 0 ? '' : formatQty(n);
}

const USTA_LABELS = new Set(USTA_RULES.map((r) => r.label));

/** "Biskvitchi" → "Biskvitchidan"; another otdel's name is quoted instead. */
function fromHeading(party: string): string {
  return USTA_LABELS.has(party) ? `Oladi — ${esc(party)}dan` : `Oladi — «${esc(party)}» sexidan`;
}

function linesTable(lines: readonly UstaLine[], checkLabel: string): string {
  const rows = lines
    .map(
      (l, i) => `<tr${i % 2 ? ' class="alt"' : ''}>
        <td class="name">${esc(l.product_name)}</td>
        <td class="num">${qty(l.qty)}</td>
        <td class="unit">${esc(unitLabel(l.unit))}</td>
        <td class="check">&#9633;</td>
      </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr>
      <th class="left">Mahsulot</th><th class="num">Miqdor</th><th>Birlik</th><th class="check">${checkLabel}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function groupSections(groups: readonly UstaLineGroup[], heading: (party: string) => string, checkLabel: string): string {
  return groups
    .map((g) => `<h3>${heading(g.party)}</h3>${linesTable(g.lines, checkLabel)}`)
    .join('');
}

/** The whole print document as HTML (pure — unit-tested). */
export function buildUstaSplitHtml(
  split: UstaSplit,
  opts: { otdelName: string; dateLabel: string },
): string {
  const otdel = esc(opts.otdelName);
  const date = esc(opts.dateLabel);

  const slips = split.slips
    .map(
      (s) => `<section class="slip" data-usta="${s.key}">
      <div class="bar">
        <span class="usta">${esc(s.label)}</span>
        <span class="meta">${otdel} · ${date} · ${s.orderCount} ta zayavka</span>
      </div>
      ${
        s.fromWarehouse.length > 0
          ? `<h3>Oladi — ombordan</h3>${linesTable(s.fromWarehouse, 'Oldi')}`
          : ''
      }
      ${groupSections(s.fromOthers, fromHeading, 'Oldi')}
      ${groupSections(s.handOver, (p) => `Topshiradi → ${esc(p)}`, 'Topshirdi')}
      <div class="sign">
        <span>Berdi (skladchi): ______________________</span>
        <span>Qabul qildi: ______________________</span>
      </div>
    </section>`,
    )
    .join('');

  const { columns, rows } = split.matrix;
  const matrix =
    columns.length === 0
      ? ''
      : `<section class="matrix">
      <div class="bar">
        <span class="usta">Ustalar matritsasi — xomashyo</span>
        <span class="meta">${otdel} · ${date}</span>
      </div>
      <table>
        <thead><tr>
          <th class="left">#</th><th class="left">Xomashyo</th><th>Birlik</th>
          ${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}
          <th class="total">Jami</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (r, i) => `<tr${i % 2 ? ' class="alt"' : ''}>
            <td class="idx">${i + 1}</td>
            <td class="name">${esc(r.product_name)}</td>
            <td class="unit">${esc(unitLabel(r.unit))}</td>
            ${r.cells.map((v) => `<td class="num">${qty(v)}</td>`).join('')}
            <td class="num total">${qty(r.total)}</td>
          </tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr class="signrow">
          <td></td><td>Imzo</td><td></td>
          ${columns.map(() => '<td></td>').join('')}
          <td class="total"></td>
        </tr></tfoot>
      </table>
      <div class="sign"><span>Berdi (skladchi): ______________________</span></div>
    </section>`;

  const empty =
    split.slips.length === 0 ? `<p class="empty">Bu sex uchun ko'rsatiladigan ma'lumot yo'q.</p>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${otdel} — ustalar bo'yicha (${date})</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  @page matrix { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #111; margin: 0; font-size: 12px; }
  h1 { font-size: 16px; margin: 0 0 10px; }
  h3 { font-size: 12px; margin: 12px 0 5px; text-transform: uppercase; letter-spacing: .3px; color: #333; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 5px 8px; }
  th { background: #f5f5f5; font-size: 11px; text-align: center; }
  th.left { text-align: left; }
  tr.alt td { background: #fafafa; }
  td.name { font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.unit { text-align: center; color: #555; width: 56px; }
  td.idx { text-align: right; color: #999; width: 28px; }
  td.check, th.check { text-align: center; width: 64px; }
  td.total, th.total { background: #fff8e6; font-weight: 700; }
  .slip { border: 1px solid #ddd; margin: 0 0 16px; padding: 0 10px 10px; page-break-inside: avoid; break-inside: avoid; }
  .bar { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
         background: #222; color: #fff; margin: 0 -10px 4px; padding: 8px 12px; }
  .bar .usta { font-size: 16px; font-weight: 700; }
  .bar .meta { font-size: 11px; opacity: .85; }
  .sign { display: flex; justify-content: space-between; gap: 24px; margin-top: 18px; font-size: 12px; }
  .matrix { page: matrix; break-before: page; page-break-before: always; }
  .matrix .bar { margin: 0 0 8px; }
  tr.signrow td { height: 34px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .empty { color: #555; }
</style></head><body>
<h1>${otdel} — ustalar bo'yicha nakladnoy</h1>
${empty}${slips}${matrix}
<script>window.onload=function(){window.print()}</script>
</body></html>`;
}

/** Opens the print window (the browser's print dialog appears on load). */
export function openUstaSplitPrint(split: UstaSplit, opts: { otdelName: string; dateLabel: string }): void {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(buildUstaSplitHtml(split, opts));
  w.document.close();
}
