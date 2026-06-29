import { useState } from 'react';
import { ArrowLeftRight, Calculator, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Tabs } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MobileCardList } from '@/components/ui/table-mobile';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { cn } from '@/lib/utils';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { UNIT_LABELS } from '@/lib/labels';
import { formatDateTime, formatQty } from '@/lib/format';
import type { Location, Product, StockRow } from '@/lib/types';
import { MinMaxCell } from './MinMaxCell';
import { MovementDialog } from './MovementDialog';
import { MovementHistory } from './MovementHistory';

/**
 * `POST /api/admin/recalc-minmax` response envelope (phase-2.md §4.3).
 * `errors` is present but optional — backend returns `[]` on success.
 */
interface RecalcResponse {
  updated_count: number;
  skipped_count: number;
  errors?: Array<{ location_id: number; product_id: number; message: string }>;
}

type StockTab = 'stock' | 'history';

const TAB_OPTIONS: { value: StockTab; label: string }[] = [
  { value: 'stock', label: 'Qoldiq' },
  { value: 'history', label: 'Harakatlar tarixi' },
];

/**
 * M3 — stock screen. Shows the `(location, product)` qty / min / max
 * table; rows where `qty <= min_level` are highlighted red. Min/max is
 * inline-editable, movements are recorded via a dialog, and the second
 * tab is the movement ledger.
 *
 * Reused by every warehouse / store module screen — the `title` and the
 * effective location scope are passed in.
 */
export function StockPage({
  title = 'Ombor qoldig‘i',
  description,
}: {
  title?: string;
  description?: string;
}) {
  const { user } = useAuth();
  const { notify } = useToast();
  const { isReadOnly, isOperator } = useCanAct();
  // "Harakat qo'shish" — Stage 1 (commit d76e06a) restricts POST
  // /api/stock/movements to scoped operators. PM is read-only;
  // store_manager has never been allowed to record movements
  // (§6 RBAC matrix). The MovementDialog itself enforces per-pair
  // location scoping when validating the form.
  const canMove = isOperator && user?.role !== 'store_manager';
  // Everyone with stock access (except ai) may edit min/max (§6) — and
  // the backend exempts /api/stock/minmax from authorizeWrite, so PM
  // keeps the configuration write.
  const canEditMinMax = true;
  // Manual recalc trigger is PM-only (phase-2.md §6 RBAC matrix and the
  // backend's configuration exemption per the Stage 6 rbac-matrix test).
  const canRecalc = user?.role === 'pm';

  const bp = useBreakpoint();
  // Switch to the card-list rendering for `<md` (phone). At `sm` (640..1023)
  // and below we still want the dense table once the user is on a tablet
  // landscape — so keep `md` (768+) as the threshold for showing the table.
  const showMobileCards = bp === 'xs';

  const [tab, setTab] = useState<StockTab>('stock');
  const [locationFilter, setLocationFilter] = useState<string>('');
  const [movementOpen, setMovementOpen] = useState(false);
  const [recalcDialogOpen, setRecalcDialogOpen] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);

  const locations = useApiQuery<Location[]>('/api/locations');
  const products = useApiQuery<Product[]>('/api/products');

  // The backend scopes /api/stock by role; an explicit location filter
  // narrows it further for `pm` who otherwise sees the whole chain.
  const stockPath =
    locationFilter === ''
      ? '/api/stock'
      : `/api/stock?location_id=${locationFilter}`;
  const stock = useApiQuery<StockRow[]>(stockPath);

  const rows = stock.data ?? [];
  const belowMin = rows.filter((r) => r.qty <= r.min_level).length;

  async function runRecalc() {
    setIsRecalculating(true);
    try {
      const body =
        locationFilter === ''
          ? {}
          : { location_id: Number(locationFilter) };
      const res = await apiRequest<RecalcResponse>(
        '/api/admin/recalc-minmax',
        { method: 'POST', body },
      );
      const errorCount = res.errors?.length ?? 0;
      notify(
        'success',
        `${res.updated_count} qator yangilandi, ${res.skipped_count} sotuv tarixi yetishmasligi tufayli o‘tib yuborildi.` +
          (errorCount > 0 ? ` ${errorCount} qatorda xato.` : ''),
      );
      setRecalcDialogOpen(false);
      stock.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qayta hisob bajarilmadi.',
      );
    } finally {
      setIsRecalculating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={title}
        description={description ?? 'Bo‘g‘inlar bo‘yicha ostatka va harakatlar.'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {isReadOnly && (
              <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            {canRecalc && (
              <Button
                variant="outline"
                onClick={() => setRecalcDialogOpen(true)}
              >
                <Calculator className="size-4" aria-hidden="true" />
                Min/max qayta hisob
              </Button>
            )}
            {canMove && (
              <Button onClick={() => setMovementOpen(true)}>
                <ArrowLeftRight className="size-4" aria-hidden="true" />
                Harakat qo‘shish
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          options={TAB_OPTIONS}
          ariaLabel="Qoldiq ko‘rinishi"
        />
        <div className="space-y-1">
          <Label htmlFor="stock-location">Bo‘g‘in bo‘yicha</Label>
          <Select
            id="stock-location"
            className="w-full sm:w-56"
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
          >
            <option value="">Barcha bo‘g‘inlar</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {tab === 'stock' && belowMin > 0 && (
        <div
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <Badge variant="danger">{belowMin}</Badge>
          <span>pozitsiya minimal darajadan past — to‘ldirish talab etiladi.</span>
        </div>
      )}

      <Card>
        {tab === 'stock' ? (
          <>
            {stock.isLoading && <LoadingState />}
            {!stock.isLoading && stock.error && (
              <ErrorState message={stock.error} onRetry={stock.refetch} />
            )}
            {!stock.isLoading && !stock.error && rows.length === 0 && (
              <EmptyState message="Qoldiq ma’lumotlari topilmadi." />
            )}
            {!stock.isLoading && !stock.error && rows.length > 0 && !showMobileCards && (
              <>
                <div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Mahsulot</TableHead>
                        <TableHead className="text-right">Qoldiq</TableHead>
                        <TableHead>Min / Max</TableHead>
                        <TableHead>Holat</TableHead>
                        <TableHead>Yangilangan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const isLow = row.qty <= row.min_level;
                        const unit = UNIT_LABELS[row.product_unit];
                        return (
                          <TableRow
                            key={`${row.location_id}-${row.product_id}`}
                            className={cn(
                              isLow && 'bg-destructive/10 hover:bg-destructive/15',
                            )}
                          >
                            <TableCell className="font-medium">
                              {row.product_name}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-right tabular-nums',
                                isLow && 'font-semibold text-destructive',
                              )}
                            >
                              {formatQty(row.qty)} {unit}
                            </TableCell>
                            <TableCell>
                              <MinMaxCell
                                row={row}
                                canEdit={canEditMinMax}
                                onSaved={stock.refetch}
                              />
                            </TableCell>
                            <TableCell>
                              {isLow ? (
                                <Badge variant="danger">Min dan past</Badge>
                              ) : (
                                <Badge variant="success">Yetarli</Badge>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatDateTime(row.updated_at)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
            {!stock.isLoading && !stock.error && rows.length > 0 && showMobileCards && (
              <>
                <MobileCardList
                  items={rows.map((row) => {
                    const isLow = row.qty <= row.min_level;
                    const unit = UNIT_LABELS[row.product_unit];
                    return {
                      id: `${row.location_id}-${row.product_id}`,
                      title: row.product_name,
                      accentClassName: isLow
                        ? 'border-destructive/40 bg-destructive/10'
                        : undefined,
                      badge: isLow ? (
                        <Badge variant="danger">Min dan past</Badge>
                      ) : (
                        <Badge variant="success">Yetarli</Badge>
                      ),
                      fields: [
                        {
                          label: 'Qoldiq',
                          value: (
                            <span
                              className={cn(
                                isLow && 'font-semibold text-destructive',
                              )}
                            >
                              {formatQty(row.qty)} {unit}
                            </span>
                          ),
                        },
                        {
                          label: 'Min / Max',
                          value: (
                            <MinMaxCell
                              row={row}
                              canEdit={canEditMinMax}
                              onSaved={stock.refetch}
                            />
                          ),
                        },
                        {
                          label: 'Yangilangan',
                          value: formatDateTime(row.updated_at),
                        },
                      ],
                    };
                  })}
                />
              </>
            )}
          </>
        ) : (
          <MovementHistory
            locationId={locationFilter === '' ? null : Number(locationFilter)}
          />
        )}
      </Card>

      {canMove && (
        <MovementDialog
          open={movementOpen}
          onOpenChange={setMovementOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          scopeLocationId={
            locationFilter ||
            (user?.location_id != null ? String(user.location_id) : '')
          }
          onSaved={stock.refetch}
        />
      )}

      {canRecalc && (
        <Dialog open={recalcDialogOpen} onOpenChange={setRecalcDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Min/max ni qayta hisoblaymi?</DialogTitle>
              <DialogDescription>
                Hozirgi dynamic qatorlarni sales tarixiga qarab qayta hisoblayman.
                {locationFilter !== ''
                  ? ' Faqat tanlangan bo‘g‘in qatorlari ko‘rib chiqiladi.'
                  : ' Butun zanjirdagi dynamic qatorlar ko‘rib chiqiladi.'}{' '}
                Manual qatorlarga tegmayman. Davom?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRecalcDialogOpen(false)}
                disabled={isRecalculating}
              >
                Bekor qilish
              </Button>
              <Button onClick={runRecalc} disabled={isRecalculating}>
                {isRecalculating && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                Qayta hisoblash
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
