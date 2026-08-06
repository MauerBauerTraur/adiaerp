import { useState } from 'react';
import { Loader2, PackageSearch } from 'lucide-react';
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
}

function thisMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${lastDay}` };
}

export function RawMaterialsUsagePage() {
  const def = thisMonthRange();
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [applied, setApplied] = useState({ from: def.from, to: def.to });

  const url = `/api/production-orders/raw-materials-usage?from=${applied.from}&to=${applied.to}`;
  const { data, isLoading, error } = useApiQuery<UsageRow[]>(url);

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
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
                    {r.total_qty.toLocaleString('uz-UZ', { maximumFractionDigits: 3 })}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {(UNIT_LABELS as Record<string, string>)[r.unit] ?? r.unit}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">
                    {r.order_count}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/20 text-xs font-medium text-muted-foreground">
                <td colSpan={2} className="px-4 py-2">
                  Jami {rows.length} xil xomashyo
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
