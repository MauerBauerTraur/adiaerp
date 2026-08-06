import * as React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Sheet, SheetContent } from './sheet';
import { Button } from './button';
import { cn } from '@/lib/utils';

// ── FilterSheet ──────────────────────────────────────────────────────────────

interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  onApply: () => void;
  onClear?: () => void;
  activeCount?: number;
  children: React.ReactNode;
}

export function FilterSheet({
  open,
  onClose,
  onApply,
  onClear,
  activeCount = 0,
  children,
}: FilterSheetProps) {
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" showClose={false} className="w-80 flex flex-col p-0 gap-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
          <div>
            <p className="text-sm font-semibold text-foreground">Filterlar</p>
            {activeCount > 0 && (
              <p className="text-xs text-muted-foreground">{activeCount} ta faol</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeCount > 0 && onClear && (
              <button
                type="button"
                onClick={onClear}
                className="text-sm font-medium text-primary hover:underline"
              >
                Tozalash
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Yopish"
              className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {children}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          <Button className="w-full" onClick={onApply}>
            Qo'llash
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── FilterField ───────────────────────────────────────────────────────────────

export function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-sm font-medium text-foreground">{label}</p>
      {children}
    </div>
  );
}

// ── FilterTrigger ─────────────────────────────────────────────────────────────

interface FilterTriggerProps {
  onClick: () => void;
  activeCount?: number;
  className?: string;
}

export function FilterTrigger({ onClick, activeCount = 0, className }: FilterTriggerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        activeCount > 0 && 'border-primary text-primary',
        className,
      )}
    >
      <SlidersHorizontal className="size-3.5" aria-hidden="true" />
      Filterlar
      {activeCount > 0 && (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground tabular-nums">
          {activeCount}
        </span>
      )}
    </button>
  );
}
