import { useState, useMemo } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { LoadingState, ErrorState, EmptyState } from '@/components/PageState';
import type { Location } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type SaleItem = {
  id: number;
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  price: number;
  cost_price: number | null;
  sold_at: string;
  poster_transaction_id: number;
};

type SalesResponse = {
  items: SaleItem[];
  total: number;
  limit: number;
  offset: number;
};

type NakladnoyLine = {
  id: number;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  note?: string;
};

type NakladnoyHeader = {
  id: number;
  location_id: number;
  location_name: string;
  created_at: string;
  lines: NakladnoyLine[];
};

function fmtMoney(n: number) {
  return n.toLocaleString('uz-UZ');
}

function fmtQty(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Store list item
// ---------------------------------------------------------------------------
function StoreListItem({
  loc,
  selected,
  salesTotal,
  salesCount,
  salesTarget,
  onSelect,
}: {
  loc: Location;
  selected: boolean;
  salesTotal: number;
  salesCount: number;
  salesTarget: number;
  onSelect: () => void;
}) {
  const progress = salesTarget > 0 ? Math.min(100, (salesTotal / salesTarget) * 100) : 0;
  const dotColor =
    salesCount === 0
      ? 'bg-yellow-400'
      : progress >= 100
      ? 'bg-emerald-500'
      : 'bg-emerald-400';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full px-4 py-3 text-left transition-colors ${
        selected
          ? 'bg-zinc-900 dark:bg-zinc-800'
          : 'hover:bg-muted/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full shrink-0 ${dotColor}`} />
        <span className={`font-semibold text-sm truncate ${selected ? 'text-white' : ''}`}>
          {loc.name}
        </span>
        <span className={`ml-auto text-xs ${selected ? 'text-zinc-400' : 'text-muted-foreground'}`}>
          {salesCount}/{Math.max(salesCount, 6)}
        </span>
      </div>
      {salesTotal > 0 && (
        <p className={`mt-0.5 ml-4 text-xs tabular-nums ${selected ? 'text-zinc-300' : 'text-muted-foreground'}`}>
          {fmtMoney(salesTotal)} so'm
        </p>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Right panel: store detail
// ---------------------------------------------------------------------------
function StoreDetail({ loc }: { loc: Location }) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: salesData, isLoading: salesLoading } = useApiQuery<SalesResponse>(
    `/api/sales?from=${today}&to=${today}&location_id=${loc.id}&limit=50`,
  );

  const { data: nakladnoyList, isLoading: nakladLoading } = useApiQuery<NakladnoyHeader[]>(
    `/api/nakladnoy?location_id=${loc.id}&limit=5`,
  );

  // Aggregate sales per product
  const soldProducts = useMemo(() => {
    const items = salesData?.items ?? [];
    const map = new Map<number, { name: string; unit: string; qty: number; price: number; total: number }>();
    for (const s of items) {
      if (!map.has(s.product_id)) {
        map.set(s.product_id, { name: s.product_name, unit: s.product_unit, qty: 0, price: s.price, total: 0 });
      }
      const entry = map.get(s.product_id)!;
      entry.qty += s.qty;
      entry.total += s.qty * s.price;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [salesData]);

  const todayTotal = soldProducts.reduce((s, p) => s + p.total, 0);

  // Get latest nakladnoy lines as "kelgan mahsulot"
  const kelganLines = useMemo(() => {
    if (!nakladnoyList || nakladnoyList.length === 0) return [];
    const latest = nakladnoyList[0];
    return latest?.lines ?? [];
  }, [nakladnoyList]);

  if (salesLoading || nakladLoading) return <LoadingState />;

  return (
    <div className="flex flex-col gap-4">
      {/* Header KPI */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold">{loc.name}</h2>
            </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bugungi KPI</p>
          <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {fmtMoney(todayTotal)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">so'm</span>
          </p>
        </div>
      </div>

      {/* Kelgan mahsulot */}
      <div className="overflow-hidden rounded-xl border border-amber-200/60 dark:border-amber-800/30 bg-amber-50/30 dark:bg-amber-950/10">
        <div className="flex items-center gap-2 border-b border-amber-200/60 dark:border-amber-800/30 px-4 py-3">
          <span className="size-2 rounded-full bg-amber-400" />
          <span className="text-sm font-semibold">
            Kelgan mahsulot <span className="font-bold">{kelganLines.length}</span>
          </span>
        </div>
        {kelganLines.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground text-center">
            Bugun nakladnoy topilmadi
          </p>
        ) : (
          <div className="divide-y divide-amber-100 dark:divide-amber-900/30">
            {kelganLines.map((line) => (
              <div key={line.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm font-semibold uppercase">{line.product_name}</span>
                <span className="tabular-nums text-sm font-bold">
                  {fmtQty(line.qty)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">{line.product_unit}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sotiladigan mahsulot */}
      <div className="overflow-hidden rounded-xl border border-blue-200/60 dark:border-blue-800/30 bg-blue-50/20 dark:bg-blue-950/10">
        <div className="flex items-center gap-2 border-b border-blue-200/60 dark:border-blue-800/30 px-4 py-3">
          <span className="size-2 rounded-full bg-blue-500" />
          <span className="text-sm font-semibold">
            Sotiladigan mahsulot <span className="font-bold">{soldProducts.length}</span>
          </span>
        </div>
        {soldProducts.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground text-center">
            Bugun sotuv topilmadi
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/20 bg-muted/5">
                  <th className="py-2 pl-4 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mahsulot</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Miqdor</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">1 birlik</th>
                  <th className="py-2 pr-4 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {soldProducts.map((p, i) => (
                  <tr key={i} className="hover:bg-muted/10 transition-colors">
                    <td className="py-2.5 pl-4">
                      <div className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-emerald-500" />
                        <span className="font-semibold text-xs uppercase">{p.name}</span>
                        <span className="rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                          Sotildi
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {fmtQty(p.qty)}
                      <span className="ml-1 text-xs text-muted-foreground">{p.unit}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fmtMoney(p.price)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(p.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Footer */}
            <div className="border-t border-border/20 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Jami reja</span>
                <span className="font-semibold tabular-nums">{fmtMoney(todayTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Bajarildi</span>
                <span className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(todayTotal)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted/40">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: '85%' }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SotuvlarPage
// ---------------------------------------------------------------------------
export function SotuvlarPage() {
  const { data: allLocations, isLoading, error } = useApiQuery<Location[]>('/api/locations');
  const today = new Date().toISOString().slice(0, 10);

  const stores = useMemo(
    () => (allLocations ?? []).filter((l) => l.type === 'store'),
    [allLocations],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? stores[0]?.id ?? null;
  const selectedStore = stores.find((s) => s.id === effectiveId) ?? null;

  // Sales summary per store (we fetch all at once for the sidebar KPI)
  const { data: allSalesData } = useApiQuery<SalesResponse>(
    stores.length > 0 ? `/api/sales?from=${today}&to=${today}&limit=500` : null,
  );

  const storeSalesMap = useMemo(() => {
    const m = new Map<number, { total: number; count: number }>();
    for (const s of allSalesData?.items ?? []) {
      const cur = m.get(s.store_id) ?? { total: 0, count: 0 };
      cur.total += s.qty * s.price;
      cur.count += 1;
      m.set(s.store_id, cur);
    }
    return m;
  }, [allSalesData]);

  if (isLoading) return <div className="p-6"><LoadingState /></div>;
  if (error) return <div className="p-6"><ErrorState message={error} /></div>;
  if (stores.length === 0) return <div className="p-6"><EmptyState message="Do'konlar topilmadi." /></div>;

  const dateLabel = new Date().toLocaleDateString('uz-UZ', { day: '2-digit', month: 'long', year: 'numeric' });

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel — store list */}
      <div className="w-52 shrink-0 border-r border-border/50 overflow-y-auto flex flex-col bg-card">
        <div className="border-b border-border/30 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sotuv</p>
          <p className="text-xs text-muted-foreground">{dateLabel}</p>
        </div>
        {stores.map((loc) => {
          const stats = storeSalesMap.get(loc.id) ?? { total: 0, count: 0 };
          return (
            <StoreListItem
              key={loc.id}
              loc={loc}
              selected={loc.id === effectiveId}
              salesTotal={stats.total}
              salesCount={stats.count}
              salesTarget={0}
              onSelect={() => setSelectedId(loc.id)}
            />
          );
        })}
      </div>

      {/* Right panel — detail */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {selectedStore ? (
          <StoreDetail loc={selectedStore} />
        ) : (
          <EmptyState message="Do'konni tanlang." />
        )}
      </div>
    </div>
  );
}
