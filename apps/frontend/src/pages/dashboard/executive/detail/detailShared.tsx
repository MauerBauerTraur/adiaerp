import type { ReactNode } from 'react';
import type { ChainTone } from '@/lib/chainTokens';
import { CHAIN_CLASSES } from '@/lib/chainTokens';
import { cn } from '@/lib/utils';

/**
 * Sprint C — shared building blocks for the chain detail panels.
 *
 * Five panels share the same skeletal anatomy: a 4-tile sub-KPI grid,
 * a charted region, and one or two tabular lists. These helpers
 * standardize the look and keep the per-stage panels short.
 */

export interface SubKpiTile {
  label: string;
  value: string;
  caption?: string;
  tone?: 'default' | 'danger' | 'warn' | 'success';
}

export function SubKpiGrid({
  tiles,
  tone,
}: {
  tiles: [SubKpiTile, SubKpiTile, SubKpiTile, SubKpiTile];
  tone: ChainTone;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((tile, i) => (
        <SubKpiCell key={i} tile={tile} tone={tone} />
      ))}
    </div>
  );
}

const TILE_TONE_CLASS: Record<NonNullable<SubKpiTile['tone']>, string> = {
  default: 'text-foreground',
  danger: 'text-destructive',
  warn: 'text-warning',
  success: 'text-success',
};

function SubKpiCell({
  tile,
  tone,
}: {
  tile: SubKpiTile;
  tone: ChainTone;
}) {
  const toneClass = TILE_TONE_CLASS[tile.tone ?? 'default'];
  return (
    <div className="rounded-md border border-border/40 bg-surface-2/40 p-3">
      <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {tile.label}
      </p>
      <p
        className={cn(
          'mt-1 truncate text-xl font-semibold leading-tight tabular-nums',
          toneClass,
        )}
        data-tone={tone}
      >
        {tile.value}
      </p>
      {tile.caption && (
        <p className="truncate text-[10px] text-muted-foreground tabular-nums">
          {tile.caption}
        </p>
      )}
    </div>
  );
}

export function PanelSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function PanelSkeleton() {
  return (
    <div
      className="flex animate-pulse flex-col gap-4"
      data-testid="chain-detail-skeleton"
      aria-hidden="true"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[78px] rounded-md border border-border/40 bg-surface-2/40"
          />
        ))}
      </div>
      <div className="h-44 rounded-md border border-border/40 bg-surface-2/40" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-9 rounded-md bg-surface-2/40" />
        ))}
      </div>
    </div>
  );
}

export function ToneAccent({ tone }: { tone: ChainTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute inset-x-0 top-0 h-0.5',
        CHAIN_CLASSES[tone].bg,
      )}
    />
  );
}
