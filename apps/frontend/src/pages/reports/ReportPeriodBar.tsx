/**
 * The period picker shared by the Hisobotlar pages: from–to dates plus
 * Bugun / Kecha / 7 kun / Shu oy shortcuts. Dates are the viewer's local
 * calendar days (Tashkent), never the UTC day.
 */

/** YYYY-MM-DD in the viewer's local calendar (toISOString would give the UTC day). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return localIsoDate(new Date(y!, m! - 1, d! + days));
}

/** 2026-09-28 -> 28.09.2026 */
export const fmtDay = (iso: string) => iso.split('-').reverse().join('.');

export const fmtPeriod = (from: string, to: string) =>
  from === to ? fmtDay(from) : `${fmtDay(from)} — ${fmtDay(to)}`;

export function ReportPeriodBar({
  from,
  to,
  today,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  onChange: (from: string, to: string) => void;
}) {
  const quick = [
    { label: 'Bugun', from: today, to: today },
    { label: 'Kecha', from: shiftDays(today, -1), to: shiftDays(today, -1) },
    { label: '7 kun', from: shiftDays(today, -6), to: today },
    { label: 'Shu oy', from: `${today.slice(0, 8)}01`, to: today },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
      <label htmlFor="period-from" className="text-xs font-medium text-muted-foreground">Dan</label>
      <input
        id="period-from"
        type="date"
        value={from}
        onChange={(e) => e.target.value && onChange(e.target.value, to)}
        className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
      />
      <label htmlFor="period-to" className="text-xs font-medium text-muted-foreground">Gacha</label>
      <input
        id="period-to"
        type="date"
        value={to}
        onChange={(e) => e.target.value && onChange(from, e.target.value)}
        className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
      />
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => onChange(q.from, q.to)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              from === q.from && to === q.to
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>
      {from > to && (
        <p className="basis-full text-xs text-destructive">
          "Dan" sanasi "Gacha" sanasidan keyin bo'lmasligi kerak.
        </p>
      )}
    </div>
  );
}
