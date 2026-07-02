import { useMemo, useState } from 'react';
import { RefreshCw, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useApiQuery } from '@/hooks/useApiQuery';
import { LoadingState, ErrorState } from '@/components/PageState';
import { UNIT_LABELS } from '@/lib/labels';
import type { StockAlert, Unit } from '@/lib/types';

export function StockAlertsPage() {
  const { data, isLoading, error, refetch } = useApiQuery<StockAlert[]>(
    '/api/products/stock-alerts',
  );

  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);

  const alerts = data ?? [];

  // Unique location names from the full alert list (sorted)
  const locations = useMemo<string[]>(() => {
    const names = new Set<string>();
    for (const a of alerts) {
      names.add(a.storage_location_name ?? '—');
    }
    return Array.from(names).sort((a, b) => {
      if (a === '—') return 1;
      if (b === '—') return -1;
      return a.localeCompare(b, 'uz');
    });
  }, [alerts]);

  const filtered = useMemo(() => {
    if (selectedLocation === null) return alerts;
    return alerts.filter((a) =>
      (a.storage_location_name ?? '—') === selectedLocation,
    );
  }, [alerts, selectedLocation]);

  const belowMin = filtered.filter((a) => a.alert === 'below_min');
  const aboveMax = filtered.filter((a) => a.alert === 'above_max');

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Stok nazorat</h1>
          <p className="text-sm text-muted-foreground">
            Min/max chegaradan chiqqan mahsulotlar
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="size-4" />
          Yangilash
        </Button>
      </div>

      {/* Location filter */}
      {!isLoading && !error && locations.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-muted-foreground">Sklad:</span>
          <Select
            value={selectedLocation ?? ''}
            onChange={(e) => setSelectedLocation(e.target.value || null)}
            className="w-64"
          >
            <option value="">Hammasi ({alerts.length} ta)</option>
            {locations.map((loc) => {
              const count = alerts.filter(
                (a) => (a.storage_location_name ?? '—') === loc,
              ).length;
              return (
                <option key={loc} value={loc}>
                  {loc} ({count} ta)
                </option>
              );
            })}
          </Select>
        </div>
      )}

      {isLoading && <LoadingState />}
      {error && <ErrorState message={typeof error === 'string' ? error : 'Xatolik yuz berdi'} />}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <AlertTriangle className="size-10 opacity-20" />
          <p className="text-sm">
            {alerts.length === 0
              ? "Hamma mahsulot me'yor ichida"
              : "Bu ombor uchun ogohlantirishlar yo‘q"}
          </p>
        </div>
      )}

      {belowMin.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <TrendingDown className="size-5 text-destructive" />
            <h2 className="text-base font-semibold text-destructive">
              Minimumdan past — {belowMin.length} ta mahsulot
            </h2>
          </div>
          <AlertTable rows={belowMin} />
        </section>
      )}

      {aboveMax.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp className="size-5 text-amber-500" />
            <h2 className="text-base font-semibold text-amber-500">
              Maximumdan yuqori — {aboveMax.length} ta mahsulot
            </h2>
          </div>
          <AlertTable rows={aboveMax} />
        </section>
      )}
    </div>
  );
}

function AlertTable({ rows }: { rows: StockAlert[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Mahsulot</th>
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Omborxona</th>
            <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Hozir</th>
            <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Min</th>
            <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const unit = UNIT_LABELS[r.unit as Unit] ?? r.unit;
            const isBelowMin = r.alert === 'below_min';
            return (
              <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                <td className="px-4 py-2.5 font-medium">{r.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {r.storage_location_name ?? '—'}
                </td>
                <td className={`px-4 py-2.5 text-right font-mono font-semibold ${
                  isBelowMin ? 'text-destructive' : 'text-amber-500'
                }`}>
                  {r.current_qty} {unit}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                  {r.min_qty != null ? `${r.min_qty} ${unit}` : '—'}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">
                  {r.max_qty != null ? `${r.max_qty} ${unit}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
