import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Printer } from 'lucide-react';
import { EmptyState, ErrorState, PageHeader } from '@/components/PageState';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ReportPeriodBar, fmtPeriod, localIsoDate } from './ReportPeriodBar';

/**
 * Kunlik ishlab chiqarish hisoboti — for management: what was ordered and
 * produced, what it cost and what it sells for, per otdel with the raw
 * materials issued, the warehouses, and supplier deliveries. Problems come
 * first. Data: GET /api/reports/production-daily.
 */

export interface ProductLine {
  product_id: number;
  product_name: string;
  unit: string;
  location_id: number | null;
  location_name: string | null;
  ordered_qty: number;
  produced_qty: number;
  pending_orders: number;
  unit_cost: number | null;
  sell_price: number | null;
  cost_total: number | null;
  sales_total: number | null;
  profit_total: number | null;
  loss: boolean;
}

export interface OtdelLine {
  location_id: number | null;
  location_name: string;
  orders: number;
  produced_qty: number;
  raw_given_value: number;
  cost_total: number;
  sales_total: number;
  profit_total: number;
}

export interface ProductionDailyReport {
  from: string;
  to: string;
  generated_at: string;
  summary: {
    orders: number;
    otdels: number;
    ordered_qty: number;
    produced_qty: number;
    done_orders: number;
    cost_total: number;
    sales_total: number;
    profit_total: number;
    margin_pct: number | null;
    supplies_total: number | null;
    supplies_count: number | null;
  };
  products: ProductLine[];
  otdels: OtdelLine[];
  stock: {
    groups: { key: string; label: string; value: number }[];
    low: { product_name: string; unit: string; qty: number; min_level: number; location_name: string }[];
  };
  supplies: { supplier_name: string; storage_name: string; date: string; sum: number }[] | null;
  problems: {
    losses: { product_name: string; location_name: string | null; loss: number }[];
    unfinished: { order_id: number; product_name: string; location_name: string | null; qty: number; status: string }[];
  };
  warnings: string[];
}

const fmtSom = (n: number) => Math.round(n).toLocaleString('ru-RU');
const fmtMln = (n: number) =>
  `${n < 0 ? '−' : ''}${(Math.abs(n) / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mln`;
const fmtQty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtSom(Math.abs(n))}`;
const unitLabel = (u: string) => (u === 'kg' ? 'kg' : u === 'l' ? 'l' : 'dona');
const dash = (n: number | null, f: (v: number) => string = fmtSom) => (n === null ? '—' : f(n));

function openPrint(r: ProductionDailyReport) {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const period = fmtPeriod(r.from, r.to);
  const s = r.summary;
  const productRows = r.products
    .map((p) => `<tr><td>${esc(p.product_name)}${p.loss ? ' (zarar)' : ''}${p.pending_orders > 0 ? ' (jarayonda)' : ''}</td>
      <td class="r">${fmtQty(p.ordered_qty)}</td><td class="r">${fmtQty(p.produced_qty)}</td>
      <td class="r">${dash(p.cost_total)}</td><td class="r">${dash(p.sales_total)}</td>
      <td class="r">${p.profit_total === null ? '—' : signed(p.profit_total)}</td></tr>`)
    .join('');
  const otdelRows = r.otdels
    .map((o) => `<tr><td>${esc(o.location_name)}</td><td class="r">${o.orders}</td><td class="r">${fmtQty(o.produced_qty)}</td>
      <td class="r">${fmtSom(o.raw_given_value)}</td><td class="r">${signed(o.profit_total)}</td></tr>`)
    .join('');
  const stockRows = r.stock.groups.map((g) => `<tr><td>${esc(g.label)}</td><td class="r">${fmtSom(g.value)} so'm</td></tr>`).join('');
  const supplyRows = (r.supplies ?? [])
    .map((x) => `<tr><td>${esc(x.supplier_name)}</td><td>${esc(x.storage_name)}</td><td class="r">${fmtSom(x.sum)}</td></tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ishlab chiqarish hisoboti — ${period}</title>
    <style>body{font-family:Georgia,'Times New Roman',serif;margin:24px;color:#111;font-size:12.5px}
    h1{font-size:16px;text-align:center;margin:0}p.meta{text-align:center;color:#444;margin:2px 0 14px}
    h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:3px 6px;text-align:left}
    th{background:#f0f0f0}.r{text-align:right;font-variant-numeric:tabular-nums}
    .sum td:first-child{width:60%}.sign{display:flex;gap:60px;margin-top:26px}
    .sign div{flex:1;border-top:1px solid #111;padding-top:3px}@media print{@page{margin:12mm}}</style></head><body>
    <h1>ADIA — ISHLAB CHIQARISH HISOBOTI</h1><p class="meta">Sana: ${period}</p>
    <h2>1. Xulosa</h2><table class="sum">
      <tr><td>Zayavkalar</td><td class="r">${s.orders} ta (${s.otdels} otdel)</td></tr>
      <tr><td>Ishlab chiqarildi</td><td class="r">${fmtQty(s.produced_qty)} (${s.done_orders} / ${s.orders} zayavka)</td></tr>
      <tr><td>Tannarx</td><td class="r">${fmtSom(s.cost_total)} so'm</td></tr>
      <tr><td>Sotuv qiymati</td><td class="r">${fmtSom(s.sales_total)} so'm</td></tr>
      <tr><td>Foyda</td><td class="r">${signed(s.profit_total)} so'm${s.margin_pct !== null ? ` (${s.margin_pct}%)` : ''}</td></tr>
      <tr><td>Yetkazib beruvchilardan kirim</td><td class="r">${s.supplies_total === null ? '—' : `${fmtSom(s.supplies_total)} so'm`}</td></tr>
    </table>
    <h2>2. Mahsulotlar</h2><table><thead><tr><th>Mahsulot</th><th class="r">Zayavka</th><th class="r">Tayyor</th><th class="r">Tannarx</th><th class="r">Sotuv</th><th class="r">Foyda</th></tr></thead><tbody>${productRows}</tbody></table>
    <h2>3. Otdellar</h2><table><thead><tr><th>Otdel</th><th class="r">Zayavka</th><th class="r">Tayyor</th><th class="r">Berilgan xomashyo</th><th class="r">Foyda</th></tr></thead><tbody>${otdelRows}</tbody></table>
    <h2>4. Omborlar (hozirgi holat, tannarxda)</h2><table>${stockRows}</table>
    ${supplyRows ? `<h2>5. Kirim</h2><table><thead><tr><th>Yetkazib beruvchi</th><th>Ombor</th><th class="r">Summa</th></tr></thead><tbody>${supplyRows}</tbody></table>` : ''}
    <div class="sign"><div>Tayyorladi:</div><div>Qabul qildi (rahbar):</div></div>
    <script>window.onload=function(){window.print()}<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'bad' }) {
  const toneCls =
    tone === 'good'
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : tone === 'bad'
        ? 'border-red-500/40 bg-red-500/5'
        : 'border-border bg-card';
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneCls}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

export function ProductionDailyReportPage() {
  const today = useMemo(() => localIsoDate(), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const invalidRange = from > to;
  const { data, isLoading, error, refetch } = useApiQuery<ProductionDailyReport>(
    invalidRange ? null : `/api/reports/production-daily?from=${from}&to=${to}`,
  );
  const period = fmtPeriod(from, to);

  const r = data;
  const hasProblems =
    r !== undefined &&
    r !== null &&
    (r.problems.losses.length > 0 || r.problems.unfinished.length > 0 || r.stock.low.length > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Ishlab chiqarish hisoboti"
        description="Rahbariyat uchun: zayavkalar, ishlab chiqarish, tannarx va foyda, otdellar, omborlar, kirim."
        action={
          r ? (
            <Button variant="outline" onClick={() => openPrint(r)}>
              <Printer className="size-4" />
              Chop etish
            </Button>
          ) : undefined
        }
      />

      <ReportPeriodBar from={from} to={to} today={today} onChange={(f, t) => { setFrom(f); setTo(t); }} />

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          Hisobot tayyorlanmoqda…
        </div>
      )}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && r && (
        <>
          {r.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              {r.warnings.map((w) => <p key={w}>{w}</p>)}
            </div>
          )}

          {/* Problems first */}
          {hasProblems && (
            <section aria-label="E'tibor talab qiladi" className="grid gap-3 md:grid-cols-3">
              {r.problems.losses.length > 0 && (
                <div className="rounded-xl border border-red-500/40 bg-card px-4 py-3">
                  <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
                    <AlertTriangle className="size-4" /> Zararda
                  </p>
                  <ul className="space-y-0.5 text-sm">
                    {r.problems.losses.map((l) => (
                      <li key={`${l.product_name}|${l.location_name}`}>
                        {l.product_name} <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">{signed(l.loss)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.problems.unfinished.length > 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-card px-4 py-3">
                  <p className="mb-1 text-sm font-semibold text-amber-700 dark:text-amber-400">Bajarilmagan zayavkalar</p>
                  <ul className="space-y-0.5 text-sm">
                    {r.problems.unfinished.map((u) => (
                      <li key={u.order_id}>
                        #{u.order_id} {u.product_name} — {fmtQty(u.qty)} ta
                        <span className="text-muted-foreground"> · {u.location_name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.stock.low.length > 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-card px-4 py-3">
                  <p className="mb-1 text-sm font-semibold text-amber-700 dark:text-amber-400">Kam qolgan xomashyo</p>
                  <ul className="space-y-0.5 text-sm">
                    {r.stock.low.map((l) => (
                      <li key={`${l.product_name}|${l.location_name}`}>
                        {l.product_name} — <span className="tabular-nums">{fmtQty(l.qty)}</span> {unitLabel(l.unit)}
                        <span className="text-muted-foreground"> (min {fmtQty(l.min_level)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Summary */}
          <section aria-label="Xulosa" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Zayavkalar" value={`${r.summary.orders} ta`} sub={`${r.summary.otdels} ta otdel`} />
            <Kpi label="Ishlab chiqarildi" value={fmtQty(r.summary.produced_qty)} sub={`${r.summary.done_orders} / ${r.summary.orders} zayavka tayyor`} />
            <Kpi label="Tannarx" value={fmtMln(r.summary.cost_total)} sub="so'm" />
            <Kpi label="Sotuv qiymati" value={fmtMln(r.summary.sales_total)} sub="so'm" />
            <Kpi
              label="Foyda"
              value={fmtMln(r.summary.profit_total)}
              sub={r.summary.margin_pct !== null ? `so'm · ${r.summary.margin_pct}%` : "so'm"}
              tone={r.summary.profit_total > 0 ? 'good' : r.summary.profit_total < 0 ? 'bad' : undefined}
            />
            <Kpi
              label="Kirim (postavka)"
              value={r.summary.supplies_total === null ? '—' : fmtMln(r.summary.supplies_total)}
              sub={r.summary.supplies_count === null ? "Poster'dan olinmadi" : `so'm · ${r.summary.supplies_count} ta`}
            />
          </section>

          {r.products.length === 0 ? (
            <EmptyState message={`${period} uchun zayavka berilmagan.`} />
          ) : (
            <>
              {/* Products */}
              <section className="rounded-xl border border-border bg-card p-4">
                <h2 className="mb-3 text-base font-semibold">Mahsulotlar bo'yicha</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2">Mahsulot</th>
                        <th className="px-3 py-2">Otdel</th>
                        <th className="px-3 py-2 text-right">Zayavka</th>
                        <th className="px-3 py-2 text-right">Ishlab chiqarildi</th>
                        <th className="px-3 py-2 text-right">Tannarx (1)</th>
                        <th className="px-3 py-2 text-right">Sotuv narxi (1)</th>
                        <th className="px-3 py-2 text-right">Tannarx jami</th>
                        <th className="px-3 py-2 text-right">Sotuv jami</th>
                        <th className="px-3 py-2 text-right">Foyda</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {r.products.map((p) => (
                        <tr key={`${p.product_id}|${p.location_id}`} className="border-b border-border/50 last:border-0">
                          <td className="px-3 py-2">
                            {p.product_name}
                            {p.loss && <span className="ml-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">zarar</span>}
                            {p.pending_orders > 0 && <span className="ml-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">jarayonda</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{p.location_name ?? '—'}</td>
                          <td className="px-3 py-2 text-right">{fmtQty(p.ordered_qty)}</td>
                          <td className="px-3 py-2 text-right">{fmtQty(p.produced_qty)} {unitLabel(p.unit)}</td>
                          <td className="px-3 py-2 text-right">{dash(p.unit_cost)}</td>
                          <td className="px-3 py-2 text-right">{dash(p.sell_price)}</td>
                          <td className="px-3 py-2 text-right">{dash(p.cost_total)}</td>
                          <td className="px-3 py-2 text-right">{dash(p.sales_total)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${p.profit_total !== null && p.profit_total < 0 ? 'text-red-600 dark:text-red-400' : p.profit_total !== null && p.profit_total > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                            {p.profit_total === null ? '—' : signed(p.profit_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/20 font-semibold tabular-nums">
                        <td className="px-3 py-2" colSpan={2}>Jami</td>
                        <td className="px-3 py-2 text-right">{fmtQty(r.summary.ordered_qty)}</td>
                        <td className="px-3 py-2 text-right">{fmtQty(r.summary.produced_qty)}</td>
                        <td colSpan={2} />
                        <td className="px-3 py-2 text-right">{fmtSom(r.summary.cost_total)}</td>
                        <td className="px-3 py-2 text-right">{fmtSom(r.summary.sales_total)}</td>
                        <td className="px-3 py-2 text-right">{signed(r.summary.profit_total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              {/* Otdels */}
              <section className="rounded-xl border border-border bg-card p-4">
                <h2 className="mb-3 text-base font-semibold">Otdellar bo'yicha</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2">Otdel</th>
                        <th className="px-3 py-2 text-right">Zayavkalar</th>
                        <th className="px-3 py-2 text-right">Ishlab chiqarildi</th>
                        <th className="px-3 py-2 text-right">Berilgan xomashyo</th>
                        <th className="px-3 py-2 text-right">Tannarx</th>
                        <th className="px-3 py-2 text-right">Sotuv qiymati</th>
                        <th className="px-3 py-2 text-right">Foyda</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {r.otdels.map((o) => (
                        <tr key={String(o.location_id)} className="border-b border-border/50 last:border-0">
                          <td className="px-3 py-2">{o.location_name}</td>
                          <td className="px-3 py-2 text-right">{o.orders}</td>
                          <td className="px-3 py-2 text-right">{fmtQty(o.produced_qty)}</td>
                          <td className="px-3 py-2 text-right">{fmtSom(o.raw_given_value)}</td>
                          <td className="px-3 py-2 text-right">{fmtSom(o.cost_total)}</td>
                          <td className="px-3 py-2 text-right">{fmtSom(o.sales_total)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${o.profit_total < 0 ? 'text-red-600 dark:text-red-400' : o.profit_total > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                            {signed(o.profit_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* Warehouses + supplies */}
          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-base font-semibold">Omborlarda</h2>
              <p className="mb-3 text-xs text-muted-foreground">Hozirgi holat, tannarxda</p>
              <div className="space-y-2">
                {r.stock.groups.map((g) => (
                  <div key={g.key} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                    <span className="text-sm">{g.label}</span>
                    <span className="font-semibold tabular-nums">{fmtSom(g.value)} so'm</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-base font-semibold">Kirim — yetkazib beruvchilardan</h2>
              <p className="mb-3 text-xs text-muted-foreground">Poster postavkalari · {period}</p>
              {r.supplies === null ? (
                <p className="text-sm text-muted-foreground">Poster'dan olinmadi.</p>
              ) : r.supplies.length === 0 ? (
                <p className="text-sm text-muted-foreground">Bu davrda postavka kiritilmagan.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="tabular-nums">
                    {r.supplies.map((x) => (
                      <tr key={`${x.supplier_name}|${x.date}`} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5">{x.supplier_name}<span className="block text-xs text-muted-foreground">{x.storage_name}</span></td>
                        <td className="py-1.5 text-right font-semibold">{fmtSom(x.sum)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
