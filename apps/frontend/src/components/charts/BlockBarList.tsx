import type { ChainTone } from '@/lib/chainTokens';
import { formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Sprint C — horizontal bar list (top-N).
 *
 * Pattern lifted from Tremor's BarList. Each row shows a label, a coloured
 * bar (width relative to `total`), and the numeric value. Used by the
 * central-warehouse detail panel for "top 10 blocks by qty", but generic
 * enough to drop into any chain.
 */
export interface BlockBarItem {
  id: string | number;
  label: string;
  value: number;
  tone?: ChainTone;
  /** Optional caption rendered next to the value (e.g. unit suffix). */
  caption?: string;
}

export interface BlockBarListProps {
  items: BlockBarItem[];
  /** Reference value used to compute relative bar width (max or sum). */
  total: number;
  /** Cap the list length; default = 10. */
  maxItems?: number;
  /** Fallback chain tone applied when `item.tone` is omitted. */
  defaultTone?: ChainTone;
  className?: string;
}

const TONE_BG: Record<ChainTone, string> = {
  raw: 'bg-chain-raw/60',
  production: 'bg-chain-production/60',
  supply: 'bg-chain-supply/60',
  sex_storage: 'bg-chain-supply/60',
  central: 'bg-chain-central/60',
  store: 'bg-chain-store/60',
};

export function BlockBarList({
  items,
  total,
  maxItems = 10,
  defaultTone = 'central',
  className,
}: BlockBarListProps) {
  const safeTotal = total > 0 ? total : 1;
  const visible = items.slice(0, maxItems);

  return (
    <ul
      data-testid="block-bar-list"
      className={cn('flex flex-col gap-1.5', className)}
    >
      {visible.map((item) => {
        const pct = Math.min(100, Math.max(0, (item.value / safeTotal) * 100));
        const tone = item.tone ?? defaultTone;
        return (
          <li
            key={item.id}
            className="relative flex items-center gap-2 rounded-md bg-surface-2/50 px-3 py-1.5"
          >
            {/* Background bar */}
            <span
              aria-hidden="true"
              className={cn(
                'absolute inset-y-0 left-0 rounded-md',
                TONE_BG[tone],
              )}
              style={{ width: `${pct}%` }}
            />
            {/* Foreground content */}
            <span className="relative z-10 min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {item.label}
            </span>
            <span className="relative z-10 shrink-0 text-xs tabular-nums text-foreground">
              {formatQty(item.value)}
              {item.caption ? (
                <span className="ml-1 text-muted-foreground">{item.caption}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
