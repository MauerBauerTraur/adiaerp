import { useEffect, useState } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ViewMode = 'card' | 'table';

const STORAGE_PREFIX = 'adia.view.';

function readStored(pageKey: string): ViewMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + pageKey);
    if (raw === 'card' || raw === 'table') return raw;
    return null;
  } catch {
    return null;
  }
}

function writeStored(pageKey: string, mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + pageKey, mode);
  } catch {
    /* localStorage may be disabled — ignore. */
  }
}

/**
 * F4.10 — per-page view-mode hook backed by localStorage.
 * `pageKey` is the stable identifier the toggle persists under
 * (`adia.view.${pageKey}`); pass the same key to both the hook and the
 * `<ViewToggle>` component so they stay in sync.
 */
export function useViewMode(
  pageKey: string,
  defaultMode: ViewMode = 'card',
): [ViewMode, (next: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => readStored(pageKey) ?? defaultMode);

  // Keep state in sync when the pageKey changes (rare, but supported).
  useEffect(() => {
    const stored = readStored(pageKey);
    if (stored !== null && stored !== mode) {
      setMode(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  const update = (next: ViewMode) => {
    setMode(next);
    writeStored(pageKey, next);
  };

  return [mode, update];
}

interface Props {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
  /** Optional override of the icon-only / icon+label rendering. */
  showLabel?: boolean;
}

/**
 * Compact two-state toggle (card vs. table). Designed to sit in the
 * right side of a page header or filter bar.
 */
export function ViewToggle({ value, onChange, showLabel = true }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Ko'rinish tanlash"
      className="inline-flex items-center rounded-md border border-border/60 bg-card/60 p-0.5 shadow-sm"
      data-testid="view-toggle"
    >
      <ToggleButton
        active={value === 'card'}
        onClick={() => onChange('card')}
        icon={<LayoutGrid className="size-4" aria-hidden="true" />}
        label="Card"
        showLabel={showLabel}
      />
      <ToggleButton
        active={value === 'table'}
        onClick={() => onChange('table')}
        icon={<List className="size-4" aria-hidden="true" />}
        label="Table"
        showLabel={showLabel}
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
  showLabel,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  showLabel: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      data-state={active ? 'active' : 'inactive'}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {icon}
      {showLabel && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}
