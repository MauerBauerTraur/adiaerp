import { useEffect, useState } from 'react';
import { DayPicker, type DateRange as RDPDateRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { format, startOfMonth } from 'date-fns';
import { uz } from 'date-fns/locale';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Selected date range — used by the executive dashboard to scope every
 * KPI / chart endpoint. Backend contract:
 *   ?range=today|week|month|6m|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export type DateRangePreset = 'today' | 'week' | 'month' | '6m' | 'custom';

export interface DateRangeValue {
  range: DateRangePreset;
  /** Required when `range === 'custom'`. ISO `YYYY-MM-DD`. */
  from?: string;
  /** Required when `range === 'custom'`. ISO `YYYY-MM-DD`. */
  to?: string;
}

/** Serialise a `DateRangeValue` into the `?range=…&from=…&to=…` query string. */
export function dateRangeToQuery(value: DateRangeValue): string {
  if (value.range === 'custom' && value.from && value.to) {
    return `range=custom&from=${value.from}&to=${value.to}`;
  }
  return `range=${value.range}`;
}

interface Props {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
}

const PRESETS: { id: DateRangePreset; label: string }[] = [
  { id: 'today', label: 'Bugun' },
  { id: 'week', label: 'Bu hafta' },
  { id: 'month', label: 'Bu oy' },
  { id: '6m', label: '6 oy' },
];

/** Uzbek 2–3 letter weekday codes the owner specified. Order = Mon..Sun. */
const UZ_WEEKDAY_CODES = ['DU', 'SE', 'CHO', 'PA', 'JU', 'SHA', 'YA'] as const;

function isoDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function parseIso(d: string | undefined): Date | undefined {
  if (d === undefined || d === '') return undefined;
  const parts = d.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return undefined;
  const [y, m, day] = parts as [number, number, number];
  return new Date(y, m - 1, day);
}

export function DateRangeFilter({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);

  // Draft range while the popover is open. Committed only on "Qo'llash".
  const [draft, setDraft] = useState<RDPDateRange | undefined>(undefined);
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()));

  // Sync draft with current value whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    if (value.range === 'custom' && value.from && value.to) {
      const from = parseIso(value.from);
      const to = parseIso(value.to);
      setDraft({ from, to });
      if (from) setMonth(startOfMonth(from));
    } else {
      setDraft(undefined);
      setMonth(startOfMonth(new Date()));
    }
  }, [open, value]);

  function selectPreset(preset: DateRangePreset) {
    onChange({ range: preset });
  }

  function applyDraft() {
    if (!draft?.from || !draft?.to) return;
    onChange({
      range: 'custom',
      from: isoDate(draft.from),
      to: isoDate(draft.to),
    });
    setOpen(false);
  }

  function clearDraft() {
    setDraft(undefined);
  }

  const customLabel =
    value.range === 'custom' && value.from && value.to
      ? `${value.from} — ${value.to}`
      : "Sana oralig'i";
  const customActive = value.range === 'custom';
  const canApply = Boolean(draft?.from && draft?.to);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="date-range-filter"
    >
      <div
        role="tablist"
        aria-label="Sana oralig'i tanlash"
        className="inline-flex items-center rounded-md border border-border bg-card p-0.5 shadow-sm"
      >
        {PRESETS.map((preset) => {
          const active = value.range === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-state={active ? 'active' : 'inactive'}
              onClick={() => selectPreset(preset.id)}
              className={cn(
                'h-8 rounded-sm px-3 text-xs font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={customActive ? 'default' : 'outline'}
            size="sm"
            data-state={customActive ? 'active' : 'inactive'}
            aria-label="Sana oralig'i — kalendar"
          >
            <CalendarIcon className="size-4" aria-hidden="true" />
            {customActive ? customLabel : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[320px] p-0"
          data-testid="date-range-picker"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Sana oralig'i</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-sm text-muted-foreground hover:text-foreground"
              aria-label="Yopish"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="px-3 py-3">
            <DayPicker
              mode="range"
              locale={uz}
              weekStartsOn={1}
              showOutsideDays
              month={month}
              onMonthChange={setMonth}
              selected={draft}
              onSelect={setDraft}
              formatters={{
                formatWeekdayName: (date) =>
                  UZ_WEEKDAY_CODES[(date.getDay() + 6) % 7] ?? '',
                formatCaption: (date) =>
                  format(date, 'LLLL yyyy', { locale: uz }).replace(/^./, (c) =>
                    c.toUpperCase(),
                  ),
              }}
              components={{
                Chevron: ({ orientation }) =>
                  orientation === 'left' ? (
                    <ChevronLeft className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  ),
              }}
              classNames={{
                root: 'rdp-adia relative',
                months: 'flex flex-col',
                month: 'space-y-3',
                month_caption: 'flex items-center justify-center pt-1 pb-2 text-sm font-semibold',
                caption_label: 'text-sm font-semibold',
                nav: 'absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-1',
                button_previous:
                  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
                button_next:
                  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
                month_grid: 'w-full border-collapse',
                weekdays: '',
                weekday:
                  'size-9 py-1 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground',
                week: '',
                day: 'p-0 text-center align-middle',
                day_button:
                  'inline-flex size-9 items-center justify-center rounded-md text-sm font-normal text-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                today: 'font-semibold text-primary',
                selected:
                  'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground rounded-md',
                range_start: 'rounded-l-md bg-primary text-primary-foreground',
                range_end: 'rounded-r-md bg-primary text-primary-foreground',
                range_middle: 'rounded-none bg-primary/15 text-foreground',
                outside: 'text-muted-foreground/40',
                disabled: 'opacity-40',
              }}
            />
          </div>

          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={clearDraft}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Tozalash
            </button>
            <Button
              type="button"
              size="sm"
              onClick={applyDraft}
              disabled={!canApply}
            >
              Qo'llash
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
