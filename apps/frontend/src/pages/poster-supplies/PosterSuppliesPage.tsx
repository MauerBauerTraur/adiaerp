/**
 * M10 — Poster Поставки (yetkazib berishlar).
 *
 * Posterdan avtomatik yuklangan postavkalar: qaysi xomashyo qaysi
 * skladga, qancha miqdorda va qancha narxda tushgani.
 *
 * Har bir postavka qatori kengaytiriladi (accordion) → ingredient satrlari
 * ko'rinadi.
 *
 * Backend: GET /api/poster-supplies + POST /api/poster-supplies/sync
 */
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Package,
  RefreshCw,
  Truck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { DateRangeFilter, dateRangeToQuery } from '@/components/DateRangeFilter';
import type { DateRangeValue } from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatSom, formatQty, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PosterSuppliesResponse, PosterSupply, PosterSupplyItem } from '@/lib/types';
import { apiRequest } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';

export function PosterSuppliesPage() {
  const [range, setRange] = useState<DateRangeValue>({ range: 'month' });
  const [syncing, setSyncing] = useState(false);
  const { notify } = useToast();

  const { data, isLoading, error, refetch } = useApiQuery<PosterSuppliesResponse>(
    `/api/poster-supplies?${dateRangeToQuery(range)}`,
  );

  const supplies = data?.items ?? [];
  const totalSum = supplies.reduce((acc, s) => acc + s.supply_sum, 0);

  async function handleSync() {
    setSyncing(true);
    try {
      const body = await apiRequest<{ ok: boolean; upserted: number; errors: number }>(
        '/api/poster-supplies/sync',
        { method: 'POST' },
      );
      notify(
        'success',
        `Sinxronizatsiya tugadi: ${body.upserted} postavka yangilandi${body.errors ? `, ${body.errors} xato` : ''}`,
      );
      refetch();
    } catch {
      notify('error', 'Sinxronizatsiya amalga oshmadi');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <Truck className="size-5 text-primary" />
            Poster Postavkalar
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Posterdan avtomatik yuklangan xomashyo yetkazib berishlar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeFilter value={range} onChange={setRange} />
          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCw className={cn('size-4 mr-1.5', syncing && 'animate-spin')} />
            Yangilash
          </Button>
        </div>
      </div>

      {/* Summary strip */}
      {supplies.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Jami postavka" value={`${supplies.length} ta`} icon={Package} />
          <StatCard label="Jami summa" value={formatSom(totalSum)} icon={Truck} />
          <StatCard
            label="Yetkazib beruvchilar"
            value={`${new Set(supplies.map((s) => s.supplier_name)).size} ta`}
            icon={RefreshCw}
            className="col-span-2 sm:col-span-1"
          />
        </div>
      )}

      {/* Main table */}
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : supplies.length === 0 ? (
        <Card className="p-8 text-center">
          <EmptyState message="Bu davr uchun postavkalar topilmadi. Yangilash tugmasini bosing." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Sana</TableHead>
                <TableHead>Yetkazib beruvchi</TableHead>
                <TableHead>Sklad</TableHead>
                <TableHead className="text-right">Miqdor (pozitsiya)</TableHead>
                <TableHead className="text-right">Jami summa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {supplies.map((supply) => (
                <SupplyRow key={supply.id} supply={supply} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function SupplyRow({ supply }: { supply: PosterSupply }) {
  const [open, setOpen] = useState(false);
  const hasItems = supply.items.length > 0;

  return (
    <>
      <TableRow
        className={cn(
          'cursor-pointer select-none',
          hasItems && 'hover:bg-muted/40',
        )}
        onClick={() => hasItems && setOpen((v) => !v)}
      >
        <TableCell className="pr-0">
          {hasItems ? (
            open ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )
          ) : null}
        </TableCell>
        <TableCell className="tabular-nums text-sm">
          {formatDateTime(supply.supply_date)}
        </TableCell>
        <TableCell className="font-medium">
          {supply.supplier_name ?? '—'}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {supply.storage_name ?? `Sklad #${supply.storage_id}`}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {supply.items.length > 0 ? `${supply.items.length} ta` : '—'}
        </TableCell>
        <TableCell className="text-right tabular-nums font-semibold">
          {formatSom(supply.supply_sum)}
        </TableCell>
      </TableRow>

      {open && hasItems && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={6} className="p-0">
            <div className="border-t border-border/40 px-8 py-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="pb-1.5 pr-4 text-left font-medium">Xomashyo</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Miqdor</th>
                    <th className="pb-1.5 pr-4 text-right font-medium">Birlik narxi</th>
                    <th className="pb-1.5 text-right font-medium">Summa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {supply.items.map((item) => (
                    <IngredientRow key={item.ingredient_id} item={item} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border/60 font-semibold">
                    <td className="pt-2 pr-4">Jami</td>
                    <td className="pt-2 pr-4 text-right tabular-nums">
                      {supply.items.length} xil
                    </td>
                    <td />
                    <td className="pt-2 text-right tabular-nums">
                      {formatSom(supply.supply_sum)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function IngredientRow({ item }: { item: PosterSupplyItem }) {
  const unitPrice = item.qty > 0 ? item.item_sum / item.qty : 0;
  return (
    <tr>
      <td className="py-1.5 pr-4 font-medium">{item.ingredient_name}</td>
      <td className="py-1.5 pr-4 text-right tabular-nums">
        {formatQty(item.qty)} {item.ingredient_unit}
      </td>
      <td className="py-1.5 pr-4 text-right tabular-nums text-muted-foreground">
        {unitPrice > 0 ? formatSom(unitPrice) : '—'}
        {unitPrice > 0 && (
          <span className="ml-1 text-[10px] text-muted-foreground/70">
            /{item.ingredient_unit}
          </span>
        )}
      </td>
      <td className="py-1.5 text-right tabular-nums">{formatSom(item.item_sum)}</td>
    </tr>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <Card className={cn('flex items-center gap-3 p-4', className)}>
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="size-4 text-primary" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-bold tabular-nums">{value}</p>
      </div>
    </Card>
  );
}
