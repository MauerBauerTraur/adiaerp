/**
 * EPIC 1.1 — reusable multi-select filter popover.
 *
 * A single "Filter" trigger opens a popover with one or more filter groups
 * (rendered as tabs when there is more than one). Each group is a searchable,
 * multi-select checkbox list with a live selected-count. Selections are held
 * as a DRAFT inside the popover and only lifted to the parent via `onApply`
 * when the user presses "Qo'llash"; "Hammasini tozalash" clears the draft.
 *
 * Design goals (owner feedback image14 referens):
 *   - one entry point, no row of separate <select>s;
 *   - per-group search box + count badge;
 *   - explicit Apply / Clear-all footer;
 *   - the trigger shows the total number of applied selections.
 *
 * Built on the shared shadcn <Popover> + <Tabs>; the checkbox is a plain
 * accessible <button role="checkbox"> so we add no new radix dependency.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Filter, Search } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/** One selectable option within a filter group. */
export interface FilterOption {
  value: string;
  label: string;
}

/** One filter dimension (a tab) — e.g. "Mahsulot turi" or "O'lchov birligi". */
export interface FilterGroup {
  /** Stable key used in the value map and as the tab id. */
  key: string;
  /** Tab / section label (Uzbek). */
  label: string;
  options: FilterOption[];
  /** Hide the in-group search box when an option list is tiny. */
  searchable?: boolean;
}

/** Applied selections keyed by group key → selected option values. */
export type FilterValue = Record<string, string[]>;

interface FilterPopoverProps {
  groups: FilterGroup[];
  /** Currently applied value (controlled by the parent). */
  value: FilterValue;
  /** Lifted on "Qo'llash". */
  onApply: (value: FilterValue) => void;
  /** Optional label override for the trigger. */
  triggerLabel?: string;
  className?: string;
}

function countSelected(value: FilterValue): number {
  return Object.values(value).reduce((sum, arr) => sum + arr.length, 0);
}

export function FilterPopover({
  groups,
  value,
  onApply,
  triggerLabel = 'Filter',
  className,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterValue>(value);
  const [searches, setSearches] = useState<Record<string, string>>({});

  // Reset the draft to the applied value whenever the popover (re)opens so a
  // dismissed-without-apply session never leaks partial selections.
  useEffect(() => {
    if (open) {
      setDraft(value);
      setSearches({});
    }
  }, [open, value]);

  const appliedCount = countSelected(value);

  function toggle(groupKey: string, optionValue: string) {
    setDraft((prev) => {
      const current = prev[groupKey] ?? [];
      const next = current.includes(optionValue)
        ? current.filter((v) => v !== optionValue)
        : [...current, optionValue];
      return { ...prev, [groupKey]: next };
    });
  }

  function clearAll() {
    const empty: FilterValue = {};
    for (const g of groups) empty[g.key] = [];
    setDraft(empty);
  }

  function apply() {
    onApply(draft);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('gap-2', className)}
          aria-label="Filtrlarni ochish"
        >
          <Filter className="size-4" aria-hidden="true" />
          {triggerLabel}
          {appliedCount > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
              {appliedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <FilterBody
          groups={groups}
          draft={draft}
          searches={searches}
          setSearches={setSearches}
          onToggle={toggle}
        />
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={countSelected(draft) === 0}
          >
            Hammasini tozalash
          </Button>
          <Button type="button" size="sm" onClick={apply}>
            Qo‘llash
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface FilterBodyProps {
  groups: FilterGroup[];
  draft: FilterValue;
  searches: Record<string, string>;
  setSearches: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onToggle: (groupKey: string, optionValue: string) => void;
}

function FilterBody({
  groups,
  draft,
  searches,
  setSearches,
  onToggle,
}: FilterBodyProps) {
  const [activeKey, setActiveKey] = useState(groups[0]?.key ?? '');
  const single = groups.length === 1;

  // Keep the active tab valid if the group set changes between renders.
  useEffect(() => {
    if (!groups.some((g) => g.key === activeKey)) {
      setActiveKey(groups[0]?.key ?? '');
    }
  }, [groups, activeKey]);

  const active = single
    ? groups[0]
    : (groups.find((g) => g.key === activeKey) ?? groups[0]);

  // Tab labels carry a per-group selected-count suffix.
  const tabOptions = groups.map((g) => {
    const n = (draft[g.key] ?? []).length;
    return { value: g.key, label: n > 0 ? `${g.label} (${n})` : g.label };
  });

  return (
    <div className="space-y-3 p-3">
      {!single && (
        <Tabs
          value={activeKey}
          onValueChange={setActiveKey}
          options={tabOptions}
          ariaLabel="Filter turkumlari"
          className="w-full"
        />
      )}
      {active && (
        <GroupPanel
          group={active}
          selected={draft[active.key] ?? []}
          search={searches[active.key] ?? ''}
          onSearch={(s) =>
            setSearches((p) => ({ ...p, [active.key]: s }))
          }
          onToggle={(v) => onToggle(active.key, v)}
        />
      )}
    </div>
  );
}

interface GroupPanelProps {
  group: FilterGroup;
  selected: string[];
  search: string;
  onSearch: (s: string) => void;
  onToggle: (value: string) => void;
}

function GroupPanel({
  group,
  selected,
  search,
  onSearch,
  onToggle,
}: GroupPanelProps) {
  const showSearch = group.searchable ?? group.options.length > 6;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === '') return group.options;
    return group.options.filter((o) => o.label.toLowerCase().includes(q));
  }, [group.options, search]);

  return (
    <div className="space-y-2">
      {showSearch && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Qidirish…"
            aria-label={`${group.label} ichida qidirish`}
            className="h-9 pl-8"
          />
        </div>
      )}
      <ul className="max-h-56 space-y-0.5 overflow-y-auto" role="group" aria-label={group.label}>
        {filtered.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            Natija topilmadi.
          </li>
        )}
        {filtered.map((o) => {
          const checked = selected.includes(o.value);
          return (
            <li key={o.value}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => onToggle(o.value)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input',
                  )}
                  aria-hidden="true"
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
