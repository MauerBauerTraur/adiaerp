import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Input } from '@/components/ui/input';

export interface ComboOption {
  value: string;
  label: string;
}

/**
 * Type-to-search product picker. A native <select> only jumps to the first
 * letter, which is unusable against a catalogue of hundreds of products, so
 * screens that pick a product use this instead.
 *
 * Extracted from ProductionOrderFormDialog so the transfer screen shares it.
 */
export function ProductCombobox({
  id,
  options,
  value,
  onChange,
  disabled,
  placeholder = 'Qidiring yoki tanlang…',
  emptyLabel = 'Mahsulot topilmadi.',
  className,
}: {
  id?: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? '',
    [options, value],
  );

  function closeDropdown() {
    setOpen(false);
    setQuery('');
  }

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const displayValue = open ? query : selectedLabel;

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          value={displayValue}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setQuery('');
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeDropdown();
          }}
          className="pr-8"
        />
        <ChevronsUpDown
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</p>
          ) : (
            filtered.map((opt) => (
              <div
                key={opt.value}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 ${
                  opt.value === value ? 'bg-primary/10 font-medium text-primary' : ''
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.value);
                  closeDropdown();
                  inputRef.current?.blur();
                }}
              >
                {opt.value === value ? (
                  <Check className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
