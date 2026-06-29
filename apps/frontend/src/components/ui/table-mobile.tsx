import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * F4.8 — mobile card-list replacement for a `Table`.
 *
 * On phones a wide table forces awkward horizontal scrolling. Render a
 * `<MobileCardList>` next to the `<Table>` with mirror data and toggle
 * via Tailwind responsive utilities:
 *
 * ```tsx
 * <MobileCardList items={rows} ... className="md:hidden" />
 * <div className="hidden md:block"><Table>...</Table></div>
 * ```
 *
 * Each card has a primary line (title), an optional badge slot in the
 * top-right, a list of label/value rows, and an optional action footer.
 */
export interface MobileCardField {
  label: string;
  value: React.ReactNode;
}

export interface MobileCardItem {
  /** Stable key. */
  id: string | number;
  /** Card title — the most important field, top-left. */
  title: React.ReactNode;
  /** Optional secondary line beneath the title. */
  subtitle?: React.ReactNode;
  /** Optional badge/icon block in the top-right corner. */
  badge?: React.ReactNode;
  /** Label / value rows printed under the title. */
  fields?: MobileCardField[];
  /** Optional action row at the bottom of the card. */
  footer?: React.ReactNode;
  /** Optional click handler — turns the card into a button. */
  onClick?: () => void;
  /** Optional accent (Tailwind class) — e.g. `bg-destructive/10`. */
  accentClassName?: string;
}

interface MobileCardListProps {
  items: MobileCardItem[];
  className?: string;
  emptyMessage?: string;
}

export function MobileCardList({
  items,
  className,
  emptyMessage,
}: MobileCardListProps) {
  if (items.length === 0) {
    return emptyMessage ? (
      <p className={cn('px-4 py-8 text-center text-sm text-muted-foreground', className)}>
        {emptyMessage}
      </p>
    ) : null;
  }

  return (
    <ul className={cn('flex flex-col gap-2 p-3', className)}>
      {items.map((item) => {
        const interactive = item.onClick !== undefined;
        return (
          <li
            key={item.id}
            className={cn(
              'rounded-md border border-border/60 bg-card/40 p-3',
              item.accentClassName,
              interactive &&
                'cursor-pointer transition-colors hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
            onClick={item.onClick}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      item.onClick?.();
                    }
                  }
                : undefined
            }
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {item.title}
                </div>
                {item.subtitle && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.subtitle}
                  </div>
                )}
              </div>
              {item.badge !== undefined && (
                <div className="shrink-0">{item.badge}</div>
              )}
            </div>

            {item.fields && item.fields.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                {item.fields.map((field, idx) => (
                  <div key={idx} className="min-w-0">
                    <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {field.label}
                    </dt>
                    <dd className="mt-0.5 truncate text-foreground tabular-nums">
                      {field.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {item.footer && (
              <div className="mt-3 border-t border-border/40 pt-3">
                {item.footer}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
