import { Fragment, useMemo, useState } from 'react';
import { Plus, CheckCircle2, Circle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { cn } from '@/lib/utils';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUS_OPTIONS,
  PURCHASE_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  Location,
  Product,
  PurchaseOrder,
  PurchaseOrderStatus,
} from '@/lib/types';
import { PurchaseOrderFormDialog } from './PurchaseOrderFormDialog';
import { ApprovalPanel } from './ApprovalPanel';

/**
 * EPIC 6.1 — at-a-glance two-step approval indicator.
 *
 * The full admin→skladchi flow lives in `ApprovalPanel` (inside the
 * expanded row), but the owner asked for the two-step state to be
 * visible on the list itself: who has signed (boshliq) and whether the
 * skladchi has signed. We render two compact pills mirroring the panel's
 * StepCard icons so a manager can scan the queue without expanding.
 */
function ApprovalSteps({ order }: { order: PurchaseOrder }) {
  const managerSigned = order.manager_approved_by !== null;
  const keeperSigned = order.keeper_approved_by !== null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Ikki bosqichli tasdiq holati"
    >
      <StepPill label="Boshliq" signed={managerSigned} />
      <span aria-hidden="true" className="text-muted-foreground/50">
        →
      </span>
      <StepPill label="Skladchi" signed={keeperSigned} />
    </div>
  );
}

function StepPill({ label, signed }: { label: string; signed: boolean }) {
  const Icon = signed ? CheckCircle2 : Circle;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        signed
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border text-muted-foreground',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
      <span className="sr-only">
        {signed ? ' tasdiqladi' : ' hali tasdiqlamagan'}
      </span>
    </span>
  );
}

/**
 * M6 — purchase orders list (sotib olish so‘rovlari).
 * `GET /api/purchase-orders?status=` returns a bare `PurchaseOrder[]`.
 *
 * The two-step approval (D5) is exposed via `ApprovalPanel` — each row
 * expands inline so the manager and the warehouse keeper can sign off
 * independently. Receive / reject also live in that panel.
 */
export function PurchaseOrdersPage() {
  const { isReadOnly, isOperator } = useCanAct();
  // "Yangi sotib olish" — Stage 1 (commit da5aebe) restricts POST
  // /api/purchase-orders to supply_manager (writers only; PM is now
  // read-only). The form dialog enforces per-row scoping via the target
  // location <select>; the backend's requireLocationOperator does the
  // final check, and a 403 surfaces as a toast inside the dialog.
  const canCreate = isOperator;

  // EPIC 6.2 — status is now one dimension inside the shared
  // FilterPopover (held as a string[] keyed by 'status'). We still send a
  // single `?status=` to the backend when exactly one is picked; multiple
  // selections fall back to client-side filtering so the API contract
  // stays unchanged.
  const [filter, setFilter] = useState<FilterValue>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [view, setView] = useViewMode('purchase-orders', 'card');

  const selectedStatuses = useMemo(
    () => (filter['status'] ?? []) as PurchaseOrderStatus[],
    [filter],
  );
  const path =
    selectedStatuses.length === 1
      ? `/api/purchase-orders?status=${selectedStatuses[0]}`
      : '/api/purchase-orders';
  const { data, isLoading, error, refetch } =
    useApiQuery<PurchaseOrder[]>(path);

  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      {
        key: 'status',
        label: 'Holat',
        options: PURCHASE_ORDER_STATUS_OPTIONS,
      },
    ],
    [],
  );

  // The table reads `product_name`, `target_location_name`,
  // `manager_approved_name`, `keeper_approved_name`, `supplier_name`
  // directly from the embedded row — no client-side join on names.
  // Products are still fetched so the quantity cell can render the unit
  // (the backend embeds `product_name` but not `product_unit` for
  // purchase orders; TODO: add it server-side and drop this fetch).
  // Locations are only needed by the "Yangi sotib olish" dialog.
  const products = useApiQuery<Product[]>('/api/products');
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  // When the backend already scoped by a single status the extra filter
  // is a no-op; for a multi-status selection we narrow client-side.
  const rows = useMemo(() => {
    const all = data ?? [];
    if (selectedStatuses.length <= 1) return all;
    const set = new Set<PurchaseOrderStatus>(selectedStatuses);
    return all.filter((r) => set.has(r.status));
  }, [data, selectedStatuses]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Sotib olish so‘rovlari"
        description="Admin buyurtma qiladi → skladchi qabul qiladi; ikki bosqichli tasdiq (boshliq + skladchi)."
        dateTime
        filter={
          <FilterPopover
            groups={filterGroups}
            value={filter}
            onApply={setFilter}
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {isReadOnly && (
              <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            <ViewToggle value={view} onChange={setView} />
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi sotib olish
              </Button>
            )}
          </div>
        }
      />

      <Card
        className={
          view === 'card'
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && rows.length === 0 && (
          <EmptyState message="So‘rovlar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => {
              const unit = productById.get(row.product_id)?.unit ?? '';
              const isOpen = expandedId === row.id;
              return (
                <div
                  key={row.id}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">#{row.id}</p>
                      <p className="truncate text-sm font-semibold">
                        {row.product_name}
                      </p>
                    </div>
                    <Badge variant={PURCHASE_ORDER_STATUS_VARIANT[row.status]}>
                      {PURCHASE_ORDER_STATUS_LABELS[row.status]}
                    </Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Miqdor</dt>
                      <dd className="tabular-nums">
                        {formatQty(row.qty)} {unit}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Yaratilgan</dt>
                      <dd className="text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Qabul qiluvchi</dt>
                      <dd className="truncate">{row.target_location_name}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="mb-1 text-muted-foreground">Tasdiq</dt>
                      <dd>
                        <ApprovalSteps order={row} />
                      </dd>
                    </div>
                  </dl>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setExpandedId(isOpen ? null : row.id)
                    }
                  >
                    {isOpen ? 'Yashirish' : 'Ko‘rish'}
                  </Button>
                  {isOpen && (
                    <div className="rounded-md bg-muted/20 p-3">
                      <ApprovalPanel order={row} onChanged={refetch} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Qabul qiluvchi</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Tasdiq</TableHead>
                <TableHead>Yaratilgan</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const unit = productById.get(row.product_id)?.unit ?? '';
                const isOpen = expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell className="text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell className="font-medium">
                        {row.product_name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(row.qty)} {unit}
                      </TableCell>
                      <TableCell>{row.target_location_name}</TableCell>
                      <TableCell>
                        <Badge variant={PURCHASE_ORDER_STATUS_VARIANT[row.status]}>
                          {PURCHASE_ORDER_STATUS_LABELS[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <ApprovalSteps order={row} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setExpandedId(isOpen ? null : row.id)
                          }
                        >
                          {isOpen ? 'Yashirish' : 'Ko‘rish'}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-muted/20">
                          <ApprovalPanel order={row} onChanged={refetch} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {canCreate && (
        <PurchaseOrderFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
