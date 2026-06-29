import {
  type ComponentType,
  type KeyboardEvent,
  useMemo,
} from 'react';
import { Box, Factory, Store, Truck, Warehouse } from 'lucide-react';
import { CHAIN_CLASSES, CHAIN_LABELS, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import { formatCurrencyCompact, formatQty, formatRelative } from '@/lib/format';
import type {
  ChainPulse,
  ChainStatus,
  ChainSummaryNode,
  LocationType,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ChainHealthRowProps {
  chainSummary: ChainSummaryNode[];
  selectedChain: LocationType | null;
  onSelectChain: (type: LocationType | null) => void;
  className?: string;
}

const STAGE_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

const TYPE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Box,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

const STATUS_CONFIG: Record<ChainStatus, { dot: string; badge: string; label: string }> = {
  ok: {
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    label: 'Normal',
  },
  warn: {
    dot: 'bg-amber-400',
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    label: 'Diqqat',
  },
  danger: {
    dot: 'bg-rose-500',
    badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    label: 'Kritik',
  },
};

export function ChainHealthRow({
  chainSummary,
  selectedChain,
  onSelectChain,
  className,
}: ChainHealthRowProps) {
  const byType = useMemo(() => {
    const map = new Map<LocationType, ChainSummaryNode>();
    for (const row of chainSummary) map.set(row.type, row);
    return map;
  }, [chainSummary]);

  return (
    <section
      data-testid="chain-health-row"
      aria-label="Zanjir salomatligi"
      className={cn(className)}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Zanjir salomatligi
        </h2>
        <p className="hidden text-[11px] text-muted-foreground/70 sm:block">
          Bosish → batafsil
        </p>
      </div>
      <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STAGE_ORDER.map((type) => (
          <li key={type}>
            <ChainHealthCard
              type={type}
              summary={byType.get(type) ?? null}
              selected={selectedChain === type}
              onSelect={onSelectChain}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChainHealthCard({
  type,
  summary,
  selected,
  onSelect,
}: {
  type: LocationType;
  summary: ChainSummaryNode | null;
  selected: boolean;
  onSelect: (type: LocationType | null) => void;
}) {
  const tone = CHAIN_TONE_BY_TYPE[type];
  const cls = CHAIN_CLASSES[tone];
  const Icon = TYPE_ICON[type];
  const status: ChainStatus = summary?.status ?? 'ok';
  const statusCfg = STATUS_CONFIG[status];
  const stats = buildStats(summary);

  const handleClick = () => onSelect(selected ? null : type);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(selected ? null : type);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${CHAIN_LABELS[tone]} — ${statusCfg.label}, batafsil ochish`}
      data-testid={`chain-node-${type}`}
      data-status={status}
      data-selected={selected ? 'true' : 'false'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'group flex h-full cursor-pointer flex-col gap-0 overflow-hidden rounded-xl border-2 bg-card shadow-sm outline-none transition-all duration-200',
        'hover:scale-[1.02] hover:shadow-md',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected ? cn(cls.border) : 'border-border/40 hover:border-border',
      )}
    >
      {/* Colored top strip */}
      <div className={cn('h-1 w-full', cls.bg)} />

      {/* Card body */}
      <div className="flex flex-col gap-2.5 p-3.5">
        {/* Icon + title + status */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={cn('flex size-7 items-center justify-center rounded-lg', cls.bgTint)}>
              <Icon className={cn('size-3.5', cls.text)} aria-hidden="true" />
            </div>
            <p className={cn('text-xs font-bold leading-tight', cls.text)}>
              {CHAIN_LABELS[tone]}
            </p>
          </div>
          <span
            className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none', statusCfg.badge)}
            data-testid={`chain-node-status-${type}`}
          >
            <span
              className={cn('mr-1 inline-block size-1.5 rounded-full', statusCfg.dot)}
              aria-hidden="true"
            />
            {statusCfg.label}
          </span>
        </div>

        {/* Location count */}
        <p className="text-[10px] text-muted-foreground">
          {summary === null
            ? "Ma'lumot yo'q"
            : `${formatQty(summary.location_count)} ta bo'g'in`}
        </p>

        {/* Stats grid */}
        <dl className="grid grid-cols-2 gap-1.5">
          {stats.slice(0, 4).map((stat, i) => (
            <div
              key={i}
              className={cn(
                'flex flex-col rounded-lg px-2 py-1.5',
                cls.bgTint,
              )}
            >
              <dt className="truncate text-[8px] font-medium uppercase tracking-wider text-muted-foreground/80">
                {stat.label}
              </dt>
              <dd className={cn('truncate text-sm font-bold leading-tight tabular-nums', STAT_TONE_CLASS[stat.tone ?? 'default'])}>
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const STAT_TONE_CLASS: Record<'default' | 'danger' | 'warning', string> = {
  default: 'text-foreground',
  danger: 'text-rose-600 dark:text-rose-400',
  warning: 'text-amber-600 dark:text-amber-400',
};

interface ChainStat {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'warning';
}

function buildStats(node: ChainSummaryNode | null): ChainStat[] {
  if (node === null) {
    return [
      { label: "Bo'g'in", value: '—' },
      { label: "Ma'lumot", value: '—' },
      { label: 'Pulse', value: '—' },
      { label: 'Status', value: '—' },
    ];
  }

  const pulse: ChainPulse = node.pulse;
  const belowMin: ChainStat = {
    label: "Min'dan past",
    value: formatQty(node.below_min_count),
    tone:
      node.below_min_count === 0
        ? 'default'
        : node.below_min_count >= 4
          ? 'danger'
          : 'warning',
  };
  const skuCount: ChainStat = {
    label: 'SKU',
    value: formatQty(node.total_products),
  };

  switch (pulse.kind) {
    case 'raw': {
      const pending = pulse.pending_purchase_orders ?? 0;
      return [
        skuCount,
        belowMin,
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
        {
          label: 'Ochiq PO',
          value: formatQty(pending),
          tone: pending > 0 ? 'warning' : 'default',
        },
      ];
    }
    case 'production': {
      const overdue = pulse.overdue_orders ?? 0;
      return [
        { label: 'Faol zayafka', value: formatQty(pulse.active_orders) },
        { label: 'Bugun bajarildi', value: formatQty(pulse.done_today) },
        {
          label: "Muddat o'tgan",
          value: formatQty(overdue),
          tone: overdue === 0 ? 'default' : overdue >= 3 ? 'danger' : 'warning',
        },
        { label: 'Sex', value: formatQty(pulse.sex_count ?? 0) },
      ];
    }
    case 'supply': {
      const openReq = pulse.open_requests ?? 0;
      return [
        skuCount,
        {
          label: "Ochiq so'rov",
          value: formatQty(openReq),
          tone: openReq === 0 ? 'default' : openReq >= 5 ? 'danger' : 'warning',
        },
        { label: "Bugun jo'natildi", value: formatQty(pulse.shipped_today) },
        { label: 'Bugun qabul', value: formatQty(pulse.received_today) },
      ];
    }
    case 'central': {
      const errors = pulse.sync_errors_24h ?? 0;
      return [
        skuCount,
        belowMin,
        {
          label: 'Oxirgi sinx',
          value:
            pulse.last_sync_at === null
              ? '—'
              : formatRelative(pulse.last_sync_at),
          tone:
            pulse.last_sync_status === 'failed'
              ? 'danger'
              : pulse.last_sync_status === 'partial'
                ? 'warning'
                : 'default',
        },
        {
          label: '24h xato',
          value: formatQty(errors),
          tone: errors === 0 ? 'default' : errors >= 5 ? 'danger' : 'warning',
        },
      ];
    }
    case 'store': {
      return [
        {
          label: 'Bugungi savdo',
          value: formatCurrencyCompact(pulse.sales_today_sum ?? 0),
        },
        { label: 'Cheklar', value: formatQty(pulse.receipts_today ?? 0) },
        {
          label: "O'rt chek",
          value: formatCurrencyCompact(pulse.avg_receipt_today ?? 0),
        },
        belowMin,
      ];
    }
  }
}
