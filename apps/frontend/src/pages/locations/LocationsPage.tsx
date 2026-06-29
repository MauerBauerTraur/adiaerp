import { useMemo, useState } from 'react';
import {
  Boxes,
  Factory,
  MapPin,
  Pencil,
  Plus,
  Search,
  Store,
  Truck,
  Warehouse,
  Waypoints,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type { Location, LocationType } from '@/lib/types';
import { LocationFormDialog } from './LocationFormDialog';
import { LocationFlowsDialog } from './LocationFlowsDialog';

// ─── Static maps ─────────────────────────────────────────────────────────────

const LOCATION_TYPE_ICON: Record<LocationType, typeof MapPin> = {
  raw_warehouse: Boxes,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

/** Left-border accent + badge color per type */
const LOCATION_TYPE_STYLE: Record<
  LocationType,
  { accent: string; badgeClass: string; iconBg: string }
> = {
  raw_warehouse: {
    accent: 'border-l-amber-400 dark:border-l-amber-500',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
    iconBg: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  },
  production: {
    accent: 'border-l-blue-500 dark:border-l-blue-400',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
    iconBg: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400',
  },
  supply: {
    accent: 'border-l-violet-500 dark:border-l-violet-400',
    badgeClass: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
    iconBg: 'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400',
  },
  sex_storage: {
    accent: 'border-l-violet-500 dark:border-l-violet-400',
    badgeClass: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300',
    iconBg: 'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400',
  },
  central_warehouse: {
    accent: 'border-l-emerald-500 dark:border-l-emerald-400',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300',
    iconBg: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  store: {
    accent: 'border-l-rose-500 dark:border-l-rose-400',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300',
    iconBg: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  },
};

/** Tab definition — `supply` is legacy synonym of `sex_storage`, hidden in tabs */
type TypeTab = '' | Exclude<LocationType, 'supply'>;

const TYPE_TABS: { key: TypeTab; label: string }[] = [
  { key: '', label: 'Hammasi' },
  { key: 'raw_warehouse', label: "Xom-ashyo ombori" },
  { key: 'production', label: 'Ishlab chiqarish' },
  { key: 'sex_storage', label: 'Sex skladi' },
  { key: 'central_warehouse', label: 'Markaziy sklad' },
  { key: 'store', label: "Do'kon" },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function LocationsPage() {
  const { user } = useAuth();
  const isPm = user?.role === 'pm' || user?.role === 'super_admin';

  const { data, isLoading, error, refetch } =
    useApiQuery<Location[]>('/api/locations');
  const allLocations = useMemo(() => data ?? [], [data]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [flowsOpen, setFlowsOpen]   = useState(false);
  const [editing, setEditing]       = useState<Location | null>(null);
  const [view, setView]             = useViewMode('locations', 'card');
  const [selectedType, setSelectedType] = useState<TypeTab>('');
  const [search, setSearch]             = useState('');

  /** Normalise legacy `supply` → `sex_storage` for tab counting */
  function canonicalType(loc: Location): Exclude<LocationType, 'supply'> {
    return loc.type === 'supply' ? 'sex_storage' : (loc.type as Exclude<LocationType, 'supply'>);
  }

  const typeCounts = useMemo<Record<TypeTab, number>>(() => {
    const c: Record<TypeTab, number> = {
      '': 0,
      raw_warehouse: 0,
      production: 0,
      sex_storage: 0,
      central_warehouse: 0,
      store: 0,
    };
    for (const loc of allLocations) {
      c['']++;
      c[canonicalType(loc)]++;
    }
    return c;
  }, [allLocations]);

  const filtered = useMemo(() => {
    return allLocations.filter((loc) => {
      if (selectedType !== '' && canonicalType(loc) !== selectedType) return false;
      if (!matchesSearch(loc.name, search)) return false;
      return true;
    });
  }, [allLocations, selectedType, search]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(location: Location) {
    setEditing(location);
    setDialogOpen(true);
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  function renderCard(loc: Location) {
    const Icon  = LOCATION_TYPE_ICON[loc.type] ?? MapPin;
    const style = LOCATION_TYPE_STYLE[loc.type];
    return (
      <div
        key={loc.id}
        className={cn(
          'flex flex-col gap-3 rounded-xl border border-l-4 border-border/60 bg-card/50 p-4 shadow-sm transition-all hover:bg-card hover:shadow-md',
          style.accent,
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              style.iconBg,
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{loc.name}</p>
            <span
              className={cn(
                'mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                style.badgeClass,
              )}
            >
              {LOCATION_TYPE_LABELS[loc.type]}
            </span>
          </div>
          {isPm && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              title="Tahrirlash"
              onClick={() => openEdit(loc)}
              aria-label={`${loc.name} ni tahrirlash`}
            >
              <Pencil className="size-4" />
            </Button>
          )}
        </div>

        {/* Meta */}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border/40 pt-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Yetkazish muddati</dt>
            <dd className="font-medium">
              {loc.lead_time_days ? `${loc.lead_time_days} kun` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tekshirish davri</dt>
            <dd className="font-medium">
              {loc.review_days ? `${loc.review_days} kun` : '—'}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-5">
      {/* ── Page header ── */}
      <PageHeader
        title="Bo'g'inlar"
        description="Ta'minot zanjirining barcha bo'g'inlari."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {isPm && (
              <Button variant="outline" onClick={() => setFlowsOpen(true)}>
                <Waypoints className="size-4" aria-hidden="true" />
                Oqimlar
              </Button>
            )}
            {isPm && (
              <Button onClick={openCreate}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi bo'g'in
              </Button>
            )}
          </div>
        }
      />

      {/* ── Type tabs + search ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tab pills */}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {TYPE_TABS.map(({ key, label }) => {
            const count    = typeCounts[key];
            const isActive = selectedType === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedType(key)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground',
                )}
              >
                {label}
                <span
                  className={cn(
                    'min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums',
                    isActive
                      ? 'bg-white/20 text-white'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative w-60">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish…"
              className="pl-9 pr-8"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <p className="hidden text-sm text-muted-foreground sm:block">
            {filtered.length} ta
          </p>
        </div>
      </div>

      {/* ── Content ── */}
      <Card
        className={
          view === 'card'
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState message="Bo'g'inlar topilmadi." />
        )}

        {/* Card view */}
        {!isLoading && !error && filtered.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map(renderCard)}
          </div>
        )}

        {/* Table view */}
        {!isLoading && !error && filtered.length > 0 && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nomi</TableHead>
                <TableHead>Turi</TableHead>
                <TableHead>Yetkazish (kun)</TableHead>
                <TableHead>Tekshirish (kun)</TableHead>
                {isPm && <TableHead className="w-14 text-right">Amal</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((loc) => {
                const style = LOCATION_TYPE_STYLE[loc.type];
                return (
                  <TableRow key={loc.id}>
                    <TableCell className="font-medium">{loc.name}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                          style.badgeClass,
                        )}
                      >
                        {LOCATION_TYPE_LABELS[loc.type]}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {loc.lead_time_days ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {loc.review_days ?? '—'}
                    </TableCell>
                    {isPm && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          title="Tahrirlash"
                          onClick={() => openEdit(loc)}
                          aria-label={`${loc.name} ni tahrirlash`}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ── Dialogs ── */}
      {isPm && (
        <LocationFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          location={editing}
          allLocations={allLocations}
          onSaved={refetch}
        />
      )}
      {isPm && (
        <LocationFlowsDialog
          open={flowsOpen}
          onOpenChange={setFlowsOpen}
          allLocations={allLocations}
        />
      )}
    </div>
  );
}
