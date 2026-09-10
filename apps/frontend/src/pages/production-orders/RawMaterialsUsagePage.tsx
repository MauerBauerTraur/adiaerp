import { useState } from 'react';
import { Loader2, PackageSearch, Printer } from 'lucide-react';
import { PageHeader } from '@/components/PageState';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/hooks/useApiQuery';
import { UNIT_LABELS } from '@/lib/labels';

interface UsageRow {
  product_id: number;
  product_name: string;
  unit: string;
  total_qty: number;
  order_count: number;
  total_cost: number | null;
}

function thisMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${lastDay}` };
}

const fmtQty = (n: number) =>
  n.toLocaleString('uz-UZ', { maximumFractionDigits: 3 });
const fmtSom = (n: number) =>
  `${Math.round(n).toLocaleString('ru-RU')} so'm`;
const unitLabel = (u: string) => (UNIT_LABELS as Record<string, string>)[u] ?? u;

export function RawMaterialsUsagePage() {
  const def = thisMonthRange();
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [applied, setApplied] = useState({ from: def.from, to: def.to });

  const url = `/api/production-orders/raw-materials-usage?from=${applied.from}&to=${applied.to}`;
  const { data, isLoading, error } = useApiQuery<UsageRow[]>(url);

  const rows = data ?? [];
  const grandQtyKnown = rows.every((r) => r.unit === rows[0]?.unit);
  const grandCost = rows.reduce((s, r) => s + (r.total_cost ?? 0), 0);
  const hasAnyCost = rows.some((r) => r.total_cost !== null);

  function handlePrint() {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return;
    const esc = (s: string) =>
      s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const body = rows
      .map(
        (r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(r.product_name)}</td>
          <td class="r">${fmtQty(r.total_qty)}</td>
          <td>${esc(unitLabel(r.unit))}</td>
          <td class="r">${r.order_count}</td>
          <td class="r">${r.total_cost === null ? '—' : fmtSom(r.total_cost)}</td>
        </tr>`,
      )
      .join('');
    win.document.write(`<!doctype html><html lang="uz"><head><meta charset="utf-8">
      <title>Xomashyo iste'moli — ${applied.from} … ${applied.to}</title>
      <style>
        *{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;}
        body{margin:24px;color:#111;}
        h1{font-size:18px;margin:0 0 4px;}
        .sub{color:#666;font-size:12px;margin:0 0 16px;}
        table{width:100%;border-collapse:collapse;font-size:13px;}
        th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;}
        th{background:#f3f3f3;}
        td.r,th.r{text-align:right;}
        tfoot td{font-weight:bold;background:#fafafa;}
        @media print{body{margin:0;}}
      </style></head><body>
      <h1>Eng ko'p ishlatilgan xomashyolar</h1>
      <p class="sub">Davr: ${applied.from} — ${applied.to} · Jami ${rows.length} xil xomashyo</p>
      <table>
        <thead><tr>
          <th>#</th><th>Xomashyo nomi</th><th class="r">Ishlatilgan miqdor</th>
          <th>O'lchov</th><th class="r">Buyurtmalar soni</th><th class="r">Summa</th>
        </tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr>
          <td colspan="5">Jami summa</td>
          <td class="r">${hasAnyCost ? fmtSom(grandCost) : '—'}</td>
        </tr></tfoot>
      </table>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    win.document.close();
    win.focus();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Eng ko'p ishlatilgan xomashyolar"
        description="Ishlab chiqarishga berish tarixi bo'yicha xomashyo iste'moli."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Dan</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Gacha</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <Button onClick={() => setApplied({ from, to })} disabled={isLoading}>
          {isLoading ? <Loader2 className="size-4 animate-spin" /> : "Ko'rsatish"}
        </Button>
        <Button
          variant="outline"
          onClick={handlePrint}
          disabled={isLoading || rows.length === 0}
          title="Ro'yxatni printerdan chiqarish"
        >
          <Printer className="size-4" />
          Chop etish
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <PackageSearch className="size-10 opacity-40" />
          <p className="text-sm">Bu davr uchun ma'lumot topilmadi.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5">#</th>
                <th className="px-4 py-2.5">Xomashyo nomi</th>
                <th className="px-4 py-2.5 text-right">Ishlatilgan miqdor</th>
                <th className="px-4 py-2.5 text-right">O'lchov</th>
                <th className="px-4 py-2.5 text-right">Buyurtmalar soni</th>
                <th className="px-4 py-2.5 text-right">Summa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.product_id}
                  className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
                  <td className="px-4 py-2.5 font-medium">{r.product_name}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                    {fmtQty(r.total_qty)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {unitLabel(r.unit)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {r.order_count}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                    {r.total_cost === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      fmtSom(r.total_cost)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/20 text-xs font-medium text-muted-foreground">
                <td colSpan={2} className="px-4 py-2">
                  Jami {rows.length} xil xomashyo
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {grandQtyKnown && rows.length > 0
                    ? fmtQty(rows.reduce((s, r) => s + r.total_qty, 0))
                    : ''}
                </td>
                <td />
                <td />
                <td className="px-4 py-2 text-right font-semibold text-foreground tabular-nums">
                  {hasAnyCost ? fmtSom(grandCost) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
