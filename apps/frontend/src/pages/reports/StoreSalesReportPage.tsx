import { useMemo, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { EmptyState, ErrorState, PageHeader } from '@/components/PageState';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ReportPeriodBar, fmtPeriod, localIsoDate } from './ReportPeriodBar';

/**
 * "Do'konlar sotuvi" — each store's sales for a period, as Poster reports
 * them (GET /api/reports/store-sales reads Poster's own reports, so the
 * numbers match Poster's "Товары" screen 1:1). Cake slices keep their
 * modifier (КУСОК / ПОЛОВИНА / ЦЕЛЫЙ) and can also be viewed converted to
 * whole cakes for production planning.
 */

export interface StoreSalesItem {
  product_name: string;
  modifier: string | null;
  poster_product_id: number;
  modification_id: number | null;
  qty: number;
  unit: 'pcs' | 'kg';
  revenue: number;
  profit: number;
  whole_factor: number | null;
}

export interface StoreSalesStore {
  spot_id: number;
  name: string;
  revenue: number;
  profit: number;
  checks: number;
  avg_check: number;
  items: StoreSalesItem[];
}

export interface StoreSalesReport {
  from: string;
  to: string;
  generated_at: string;
  stores: StoreSalesStore[];
}

type View = 'poster' | 'whole';

const SIZE_ORDER = ['ЦЕЛЫЙ', 'ПОЛОВИНА', 'КУСОК'] as const;
const SIZE_LABELS: Record<(typeof SIZE_ORDER)[number], string> = {
  ЦЕЛЫЙ: 'Целый',
  ПОЛОВИНА: 'Половина',
  КУСОК: 'Кусок',
};
const PAGE = 30;

const fmtSom = (n: number) => Math.round(n).toLocaleString('ru-RU');
const fmtMln = (n: number) =>
  `${(n / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mln`;
const fmtQty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const unitLabel = (u: StoreSalesItem['unit']) => (u === 'kg' ? 'kg' : 'dona');
const isSize = (m: string | null): m is (typeof SIZE_ORDER)[number] =>
  m !== null && (SIZE_ORDER as readonly string[]).includes(m.toUpperCase());

export interface CakeRow {
  product_name: string;
  poster_product_id: number;
  sizes: Partial<Record<(typeof SIZE_ORDER)[number], number>>;
  whole: number;
  /** A size had no weight in Poster's menu, so `whole` is a lower bound. */
  partial: boolean;
  revenue: number;
}

/** Fold ЦЕЛЫЙ / ПОЛОВИНА / КУСОК rows of one cake into one line in whole cakes. */
export function groupCakes(items: readonly StoreSalesItem[]): CakeRow[] {
  const byProduct = new Map<number, CakeRow>();
  for (const i of items) {
    if (!isSize(i.modifier)) continue;
    const key = i.modifier.toUpperCase() as (typeof SIZE_ORDER)[number];
    const row = byProduct.get(i.poster_product_id) ?? {
      product_name: i.product_name,
      poster_product_id: i.poster_product_id,
      sizes: {},
      whole: 0,
      partial: false,
      revenue: 0,
    };
    row.sizes[key] = (row.sizes[key] ?? 0) + i.qty;
    if (i.whole_factor === null) row.partial = true;
    else row.whole += i.qty * i.whole_factor;
    row.revenue += i.revenue;
    byProduct.set(i.poster_product_id, row);
  }
  return [...byProduct.values()].sort((a, b) => b.whole - a.whole);
}

function openPrint(report: StoreSalesReport) {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const period = fmtPeriod(report.from, report.to);
  const total = report.stores.reduce((s, x) => s + x.revenue, 0);
  const checks = report.stores.reduce((s, x) => s + x.checks, 0);
  const sections = report.stores
    .filter((s) => s.revenue > 0)
    .map((s) => {
      const rows = s.items
        .map((i) => `<tr><td>${esc(i.product_name)}</td><td>${i.modifier ? esc(i.modifier) : ''}</td>
          <td class="r">${fmtQty(i.qty)} ${unitLabel(i.unit)}</td><td class="r">${fmtSom(i.revenue)}</td></tr>`)
        .join('');
      return `<div class="store">
        <h2>${esc(s.name)}</h2>
        <p class="sub">Tushum ${fmtSom(s.revenue)} so'm · ${s.checks} ta chek · o'rtacha chek ${fmtSom(s.avg_check)} so'm</p>
        <table><thead><tr><th>Mahsulot</th><th>Modifikator</th><th class="r">Soni</th><th class="r">Tushum</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">Jami</td><td class="r">${fmtSom(s.revenue)}</td></tr></tfoot></table>
      </div>`;
    })
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Do'konlar sotuvi — ${period}</title>
    <style>body{font-family:Arial,sans-serif;margin:20px;color:#111;font-size:12px}
    h1{font-size:17px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 2px;border-bottom:2px solid #333;padding-bottom:3px}
    .sub{color:#444;margin:4px 0 6px}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f3f3f3}
    .r{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:bold;background:#fafafa}
    .store{page-break-inside:avoid}.sign{margin-top:28px;display:flex;gap:60px;color:#444}
    @media print{@page{margin:10mm}}</style></head><body>
    <h1>Do'konlar sotuvi — ${period}</h1>
    <p class="sub">Jami tushum ${fmtSom(total)} so'm · ${checks} ta chek · Poster ma'lumoti</p>
    ${sections}
    <div class="sign"><span>Tayyorladi: ____________</span><span>Qabul qildi: ____________</span></div>
    <script>window.onload=function(){window.print()}<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

export function StoreSalesReportPage() {
  const today = useMemo(() => localIsoDate(), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [view, setView] = useState<View>('poster');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const invalidRange = from > to;
  const { data, isLoading, error, refetch } = useApiQuery<StoreSalesReport>(
    invalidRange ? null : `/api/reports/store-sales?from=${from}&to=${to}`,
  );

  function setRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    setLimit(PAGE);
  }

  const stores = data?.stores ?? [];
  const totals = useMemo(() => {
    const revenue = stores.reduce((s, x) => s + x.revenue, 0);
    const checks = stores.reduce((s, x) => s + x.checks, 0);
    const profit = stores.reduce((s, x) => s + x.profit, 0);
    return { revenue, checks, profit, avg: checks > 0 ? revenue / checks : 0 };
  }, [stores]);
  const maxRevenue = Math.max(1, ...stores.map((s) => s.revenue));

  const busiest = [...stores].sort((a, b) => b.revenue - a.revenue)[0];
  const selected = stores.find((s) => s.spot_id === storeId) ?? busiest ?? null;

  const needle = search.trim().toLowerCase();
  const posterRows = (selected?.items ?? []).filter(
    (i) => needle === '' || `${i.product_name} ${i.modifier ?? ''}`.toLowerCase().includes(needle),
  );
  const cakeRows = groupCakes(selected?.items ?? []).filter(
    (r) => needle === '' || r.product_name.toLowerCase().includes(needle),
  );
  const rowCount = view === 'poster' ? posterRows.length : cakeRows.length;

  const period = fmtPeriod(from, to);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Do'konlar sotuvi"
        description="Har bir do'kon alohida — Poster hisobotidagi bilan bir xil."
        action={
          data && totals.revenue > 0 ? (
            <Button variant="outline" onClick={() => openPrint(data)}>
              <Printer className="size-4" />
              Chop etish
            </Button>
          ) : undefined
        }
      />

      <ReportPeriodBar from={from} to={to} today={today} onChange={setRange} />

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          Poster'dan olinmoqda…
        </div>
      )}
      {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}

      {!isLoading && !error && data && (
        <>
          {/* Totals across stores */}
          <section aria-label="Jami" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { label: 'Jami tushum', value: fmtMln(totals.revenue), sub: `so'm · ${period}` },
              { label: 'Cheklar', value: String(totals.checks), sub: 'ta' },
              { label: "O'rtacha chek", value: fmtSom(totals.avg), sub: "so'm" },
              {
                label: 'Foyda (Poster)',
                value: fmtMln(totals.profit),
                sub: totals.revenue > 0 ? `so'm · ${Math.round((totals.profit / totals.revenue) * 100)}%` : "so'm",
              },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className="text-2xl font-semibold">{k.value}</p>
                <p className="text-xs text-muted-foreground">{k.sub}</p>
              </div>
            ))}
          </section>

          {/* Stores */}
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" aria-label="Do'konlar">
            {stores.map((s) => {
              const active = selected?.spot_id === s.spot_id;
              return (
                <button
                  key={s.spot_id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { setStoreId(s.spot_id); setLimit(PAGE); }}
                  className={`rounded-xl border bg-card px-4 py-3 text-left transition-colors ${
                    active ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <p className="text-sm font-semibold">{s.name}</p>
                  <p className="text-lg font-semibold tabular-nums">{fmtMln(s.revenue)}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.checks > 0 ? `${s.checks} ta chek · o'rtacha ${fmtSom(s.avg_check)}` : "Sotuv yo'q"}
                  </p>
                  <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-r bg-primary" style={{ width: `${(s.revenue / maxRevenue) * 100}%` }} />
                  </span>
                </button>
              );
            })}
          </section>

          {/* Selected store */}
          {selected && (
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">
                  {selected.name} — {fmtSom(selected.revenue)} so'm
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    aria-label="Mahsulot qidirish"
                    placeholder="Mahsulot qidirish…"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }}
                    className="h-8 w-56 rounded-lg border border-border bg-background px-2 text-sm"
                  />
                  <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs" role="group" aria-label="Ko'rinish">
                    {([['poster', "Poster'dagidek"], ['whole', 'Tortlar butunga']] as const).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={view === v}
                        onClick={() => { setView(v); setLimit(PAGE); }}
                        className={`px-3 py-1.5 font-medium transition-colors ${
                          view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {selected.items.length === 0 ? (
                <EmptyState message={`${period} kuni bu do'konda sotuv bo'lmagan.`} />
              ) : (
                <div className="overflow-x-auto">
                  {view === 'poster' ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2">Mahsulot</th>
                          <th className="px-3 py-2">Modifikator</th>
                          <th className="px-3 py-2 text-right">Soni</th>
                          <th className="px-3 py-2 text-right">Tushum</th>
                          <th className="px-3 py-2 text-right">Foyda</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {posterRows.slice(0, limit).map((i) => (
                          <tr key={`${i.poster_product_id}:${i.modification_id ?? 0}`} className="border-b border-border/50 last:border-0">
                            <td className="px-3 py-2">{i.product_name}</td>
                            <td className="px-3 py-2">
                              {i.modifier ? (
                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${isSize(i.modifier) ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                                  {i.modifier}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">{fmtQty(i.qty)} {unitLabel(i.unit)}</td>
                            <td className="px-3 py-2 text-right">{fmtSom(i.revenue)}</td>
                            <td className="px-3 py-2 text-right">{fmtSom(i.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-muted/20 text-sm font-semibold tabular-nums">
                          <td className="px-3 py-2" colSpan={3}>Jami ({posterRows.length} qator)</td>
                          <td className="px-3 py-2 text-right">{fmtSom(posterRows.reduce((s, i) => s + i.revenue, 0))}</td>
                          <td className="px-3 py-2 text-right">{fmtSom(posterRows.reduce((s, i) => s + i.profit, 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2">Tort</th>
                          <th className="px-3 py-2">Nima sotildi</th>
                          <th className="px-3 py-2 text-right">Butunga aylantirilgan</th>
                          <th className="px-3 py-2 text-right">Tushum</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {cakeRows.slice(0, limit).map((r) => (
                          <tr key={r.poster_product_id} className="border-b border-border/50 last:border-0">
                            <td className="px-3 py-2">{r.product_name}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {SIZE_ORDER.filter((k) => r.sizes[k]).map((k) => `${SIZE_LABELS[k]} ${fmtQty(r.sizes[k]!)}`).join(' · ')}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className="font-semibold">≈ {fmtQty(Math.round(r.whole * 100) / 100)}</span> ta
                              {r.partial && <span className="ml-1 text-xs text-muted-foreground">(+ og'irligi yo'q)</span>}
                            </td>
                            <td className="px-3 py-2 text-right">{fmtSom(r.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-muted/20 text-sm font-semibold tabular-nums">
                          <td className="px-3 py-2" colSpan={2}>Jami ({cakeRows.length} xil tort)</td>
                          <td className="px-3 py-2 text-right">≈ {fmtQty(Math.round(cakeRows.reduce((s, r) => s + r.whole, 0) * 100) / 100)} ta</td>
                          <td className="px-3 py-2 text-right">{fmtSom(cakeRows.reduce((s, r) => s + r.revenue, 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                  {rowCount > limit && (
                    <button
                      type="button"
                      onClick={() => setLimit((l) => l + 50)}
                      className="mt-3 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                    >
                      Yana ko'rsatish ({rowCount - limit} ta)
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
