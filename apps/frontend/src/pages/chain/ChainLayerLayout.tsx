import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  Factory,
  MapPin,
  Package,
  RefreshCw,
  Store,
  Truck,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader } from '@/components/PageState';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  LOCATION_TYPE_LABELS,
  MOVEMENT_REASON_LABELS,
  UNIT_LABELS,
} from '@/lib/labels';
import type {
  ChainLayerLocation,
  ChainLayerMovement,
  ChainLayerTotals,
  LocationType,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.6 — shared layout for the five chain-layer module screens
 * (`/raw-warehouse`, `/production`, `/supply`, `/central-warehouse`,
 * `/stores`). Each page composes:
 *
 *   PageHeader  (title + Uzbek description + optional action slot)
 *   KPI strip   (3–4 tone-coloured cards, layer-specific accent)
 *   Locations   (this layer's locations as a card grid)
 *   Widgets     (layer-specific blocks — passed via `widgets`)
 *   Movements   (compact recent-movements feed at the bottom)
 *
 * Loading / error states are intentionally NOT owned by this layout —
 * each page wires `useApiQuery` and feeds the resolved data in. The
 * layout assumes the parent already rendered a top-level
 * `LoadingState`/`ErrorState` when needed.
 */

/** A single KPI card displayed in the strip. */
export interface ChainKpi {
  label: string;
  value: number;
  icon: LucideIcon;
  /** Visual tone — `accent` uses the layer accent colour. */
  tone: 'neutral' | 'accent' | 'amber' | 'destructive';
  hint?: string;
  /**
   * EPIC 7.1 — drill-down route. When set, the KPI card becomes a link
   * to its full detail (e.g. below-min → stock list filtered to lows).
   */
  href?: string;
}

/** Visual accent per chain layer — kept subtle (premium dark cobalt base). */
const LAYER_ACCENT: Record<
  LocationType,
  { ring: string; iconWrap: string; valueText: string; icon: LucideIcon }
> = {
  raw_warehouse: {
    ring: 'ring-1 ring-teal-500/30',
    iconWrap: 'bg-teal-500/15 text-teal-300',
    valueText: 'text-teal-200',
    icon: Boxes,
  },
  production: {
    ring: 'ring-1 ring-amber-500/30',
    iconWrap: 'bg-amber-500/15 text-amber-300',
    valueText: 'text-amber-200',
    icon: Factory,
  },
  supply: {
    ring: 'ring-1 ring-sky-500/30',
    iconWrap: 'bg-sky-500/15 text-sky-300',
    valueText: 'text-sky-200',
    icon: Truck,
  },
  // `sex_storage` reuses the supply accent — the layer is the same
  // visual stage, only the name has changed.
  sex_storage: {
    ring: 'ring-1 ring-sky-500/30',
    iconWrap: 'bg-sky-500/15 text-sky-300',
    valueText: 'text-sky-200',
    icon: Truck,
  },
  central_warehouse: {
    ring: 'ring-1 ring-emerald-500/30',
    iconWrap: 'bg-emerald-500/15 text-emerald-300',
    valueText: 'text-emerald-200',
    icon: Warehouse,
  },
  store: {
    ring: 'ring-1 ring-primary/30',
    iconWrap: 'bg-primary/15 text-primary',
    valueText: 'text-primary',
    icon: Store,
  },
};

interface ChainLayerLayoutProps {
  layerType: LocationType;
  title: string;
  description: string;
  /** Action slot — e.g. a "Yangi so'rov" button on the right of the header. */
  headerAction?: ReactNode;
  totals: ChainLayerTotals;
  /** Caller-prepared KPIs (3–4). */
  kpis: ChainKpi[];
  locations: ChainLayerLocation[];
  /**
   * Layer-specific widget blocks rendered between the locations grid
   * and the recent-movements feed. Each entry stacks vertically; pass
   * a wrapping `Card` per widget for consistent edges.
   */
  widgets?: ReactNode;
  recentMovements: ChainLayerMovement[];
  /**
   * Renderer for each location card. When omitted, the layout falls
   * back to a built-in compact card; pages can supply their own to
   * surface layer-specific extras (e.g. today's sales for stores).
   */
  renderLocationCard?: (location: ChainLayerLocation) => ReactNode;
}

/**
 * Layout shell. Consumers fetch their data, build the `kpis` array
 * and `widgets` slot, then hand off rendering to this component. The
 * empty branch (no locations) is handled inline so every chain-layer
 * page surfaces the same wording.
 */
export function ChainLayerLayout({
  layerType,
  title,
  description,
  headerAction,
  kpis,
  locations,
  widgets,
  recentMovements,
  renderLocationCard,
}: ChainLayerLayoutProps) {
  const accent = LAYER_ACCENT[layerType];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader title={title} description={description} action={headerAction} />

      <KpiStrip layerType={layerType} kpis={kpis} />

      <LocationsGrid
        locations={locations}
        layerType={layerType}
        accentRing={accent.ring}
        renderCard={renderLocationCard}
      />

      {widgets}

      <RecentMovementsCard movements={recentMovements} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

function KpiStrip({
  layerType,
  kpis,
}: {
  layerType: LocationType;
  kpis: ChainKpi[];
}) {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      data-testid="chain-kpi-strip"
    >
      {kpis.map((kpi) => (
        <KpiCard key={kpi.label} kpi={kpi} layerType={layerType} />
      ))}
    </div>
  );
}

function KpiCard({ kpi, layerType }: { kpi: ChainKpi; layerType: LocationType }) {
  const accent = LAYER_ACCENT[layerType];
  const Icon = kpi.icon;

  const ringByTone =
    kpi.tone === 'destructive'
      ? 'ring-1 ring-destructive/30'
      : kpi.tone === 'amber'
        ? 'ring-1 ring-amber-500/30'
        : kpi.tone === 'accent'
          ? accent.ring
          : '';
  const iconWrapByTone =
    kpi.tone === 'destructive'
      ? 'bg-destructive/15 text-destructive'
      : kpi.tone === 'amber'
        ? 'bg-amber-500/15 text-amber-300'
        : kpi.tone === 'accent'
          ? accent.iconWrap
          : 'bg-muted text-muted-foreground';
  const numberTone =
    kpi.tone === 'destructive'
      ? 'text-destructive'
      : kpi.tone === 'amber'
        ? 'text-amber-200'
        : kpi.tone === 'accent'
          ? accent.valueText
          : 'text-foreground';

  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {kpi.label}
        </p>
        <p
          className={cn(
            'text-3xl font-semibold tabular-nums leading-none',
            numberTone,
          )}
          data-testid="chain-kpi-value"
        >
          {formatQty(kpi.value)}
        </p>
        {kpi.hint && (
          <p className="text-xs text-muted-foreground">{kpi.hint}</p>
        )}
      </div>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center rounded-md',
          iconWrapByTone,
        )}
      >
        <Icon className="size-4" />
      </span>
    </div>
  );

  // EPIC 7.1 — clickable KPI drills down to its detail when `href` is set.
  if (kpi.href !== undefined) {
    return (
      <Card
        className={cn(
          'p-5 transition-colors hover:border-border hover:bg-muted/30',
          'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          ringByTone,
        )}
      >
        <Link
          to={kpi.href}
          aria-label={`${kpi.label} — batafsil`}
          className="block outline-none"
        >
          {inner}
        </Link>
      </Card>
    );
  }

  return <Card className={cn('p-5', ringByTone)}>{inner}</Card>;
}

// ---------------------------------------------------------------------------
// Locations grid
// ---------------------------------------------------------------------------

const LOCATION_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Warehouse,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Package,
  store: Store,
};

function LocationsGrid({
  locations,
  layerType,
  accentRing,
  renderCard,
}: {
  locations: ChainLayerLocation[];
  layerType: LocationType;
  accentRing: string;
  renderCard?: (location: ChainLayerLocation) => ReactNode;
}) {
  if (locations.length === 0) {
    return (
      <Card className="p-6">
        <EmptyState message="Bu zanjir bo‘g‘ini uchun bo‘g‘inlar topilmadi." />
      </Card>
    );
  }

  return (
    <section
      aria-label={`${LOCATION_TYPE_LABELS[layerType]} bo‘g‘inlari`}
      className="space-y-3"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
          Bo‘g‘inlar
          <Badge variant="outline" className="ml-1 tabular-nums">
            {locations.length}
          </Badge>
        </h2>
      </header>
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="chain-locations-grid"
      >
        {locations.map((loc) =>
          renderCard ? (
            <div key={loc.id}>{renderCard(loc)}</div>
          ) : (
            <DefaultLocationCard
              key={loc.id}
              location={loc}
              accentRing={accentRing}
            />
          ),
        )}
      </div>
    </section>
  );
}

function DefaultLocationCard({
  location,
  accentRing,
}: {
  location: ChainLayerLocation;
  accentRing: string;
}) {
  const Icon = LOCATION_ICON[location.type];
  const hasDanger = location.below_min_count > 0;
  return (
    <Card className={cn('p-4 flex flex-col gap-3', accentRing)}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{location.name}</p>
          <p className="text-xs text-muted-foreground">
            {LOCATION_TYPE_LABELS[location.type]}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Mahsulot" value={location.total_products} />
        <Stat
          label="Min’dan past"
          value={location.below_min_count}
          tone={hasDanger ? 'danger' : 'neutral'}
        />
        <Stat
          label="So‘rovlar"
          value={location.open_requests_count}
          tone={location.open_requests_count > 0 ? 'amber' : 'neutral'}
        />
      </dl>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'danger' | 'amber';
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-destructive font-semibold'
      : tone === 'amber'
        ? 'text-amber-200 font-semibold'
        : 'text-foreground';
  return (
    <div className="rounded-md border border-border/40 bg-background/40 p-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={cn('mt-0.5 text-base tabular-nums leading-none', valueClass)}>
        {formatQty(value)}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent movements feed
// ---------------------------------------------------------------------------

function RecentMovementsCard({ movements }: { movements: ChainLayerMovement[] }) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">Oxirgi harakatlar</h2>
          <p className="text-xs text-muted-foreground">
            Shu bo‘g‘in bo‘yicha so‘nggi {Math.min(movements.length, 20)} ta
            ombor harakati.
          </p>
        </div>
      </header>
      {movements.length === 0 ? (
        <EmptyState message="Harakatlar yo‘q." />
      ) : (
        <ol className="divide-y divide-border/60" data-testid="chain-recent-movements">
          {movements.slice(0, 20).map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{m.product_name}</span>
                <span className="text-xs text-muted-foreground">
                  {m.from_location_name ?? '—'}
                  {' → '}
                  {m.to_location_name ?? '—'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <span className="tabular-nums font-semibold">
                  {formatQty(m.qty)} {UNIT_LABELS[m.product_unit]}
                </span>
                <Badge variant="outline" className="font-normal">
                  {MOVEMENT_REASON_LABELS[m.reason]}
                </Badge>
                <span className="hidden text-xs text-muted-foreground sm:inline tabular-nums">
                  {formatDateTime(m.created_at)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Re-exports — convenient icons for the per-page KPI builders.
// ---------------------------------------------------------------------------

export const CHAIN_KPI_ICONS = {
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  Package,
  RefreshCw,
  AlertTriangle,
} as const;
