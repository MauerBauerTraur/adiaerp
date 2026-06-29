/**
 * Locale-aware number and date formatting.
 * Numbers and dates are shown in local (uz-UZ) format (CLAUDE.md §2).
 */

const numberFormatter = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 3,
});

const dateTimeFormatter = new Intl.DateTimeFormat('uz-UZ', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Format a numeric quantity with local grouping (e.g. `1 250,5`).
 *
 * Guards against `NaN`/`Infinity`/`undefined`-coerced inputs so a bad
 * value never renders as `NaN` on a dashboard — returns the em-dash
 * placeholder instead (matching `formatCurrencyCompact`).
 */
export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

/**
 * Format a plain number with local (uz-UZ) grouping and NO fractional
 * digits — for integer-ish counters (open POs, expected qty, below-min
 * counts). Same `NaN`/`Infinity` guard as `formatQty`.
 *
 * This is the single shared helper for all "bare integer with grouping"
 * rendering on the dashboard; prefer it over inline `Intl.NumberFormat`
 * / `toLocaleString()` copies so the locale (space grouping) and the
 * non-finite guard stay consistent everywhere.
 */
const plainNumberFormatter = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 0,
});

export function formatPlainNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return plainNumberFormatter.format(Math.round(value));
}

/**
 * EPIC 8 — full money amount with local grouping and the "so'm" suffix,
 * no abbreviation. Use for kassa / nakladnoy / seyf rows where the exact
 * value matters (a smena close-out, a safe withdrawal). For at-a-glance
 * dashboard KPIs prefer the abbreviated `formatCurrencyCompact`.
 */
export function formatSom(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${plainNumberFormatter.format(Math.round(value))} so‘m`;
}

/** Format an ISO timestamp as a local date-time string. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

/**
 * Format an ISO timestamp as a relative Uzbek string ("hozir",
 * "5 daqiqa oldin", "2 soat oldin", "3 kun oldin"). Falls back to
 * `formatDateTime` when the input is invalid or the gap is older than
 * a week. `now` parameter is overridable for deterministic tests.
 */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = now.getTime() - date.getTime();
  const futureLabel = diffMs < 0 ? 'keyin' : 'oldin';
  const abs = Math.abs(diffMs);

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  if (abs < 30 * SEC) return 'hozir';
  if (abs < HOUR) {
    const m = Math.max(1, Math.floor(abs / MIN));
    return `${m} daqiqa ${futureLabel}`;
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    return `${h} soat ${futureLabel}`;
  }
  if (abs < WEEK) {
    const d = Math.floor(abs / DAY);
    return `${d} kun ${futureLabel}`;
  }
  return formatDateTime(iso);
}

/**
 * F4.7 — Compact currency formatter for hero KPI cards.
 *
 * Renders a large monetary value as a short executive-glanceable string:
 *   2_400_000        → "2.4M"
 *   1_250_000_000    → "1.25mlrd"
 *   980_000          → "980K"
 *   1_500            → "1 500"   (no abbreviation — full local grouping)
 *
 * Uses uz-UZ locale grouping below the abbreviation threshold; above it,
 * suffixes are Uzbek (`K`, `M`, `mlrd`) so they read naturally on a
 * boshliq dashboard.
 */
const compactFormatter = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 2,
});

export function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    return `${sign}${compactFormatter.format(round(abs / 1_000_000_000, 2))}mlrd`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${compactFormatter.format(round(abs / 1_000_000, 1))}M`;
  }
  if (abs >= 10_000) {
    return `${sign}${compactFormatter.format(round(abs / 1_000, 0))}K`;
  }
  return `${sign}${compactFormatter.format(Math.round(abs))}`;
}

function round(n: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * F4.7 — Long Uzbek date string for the executive HeaderStrip.
 *
 * Format: "24-may 2026, yakshanba".
 * Accepts an ISO `YYYY-MM-DD` or full timestamp; falls back to the raw
 * input on invalid dates.
 */
const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentyabr',
  'oktyabr',
  'noyabr',
  'dekabr',
];

const UZ_WEEKDAYS = [
  'yakshanba',
  'dushanba',
  'seshanba',
  'chorshanba',
  'payshanba',
  'juma',
  'shanba',
];

export function formatDateLong(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getDate();
  const month = UZ_MONTHS[date.getMonth()];
  const year = date.getFullYear();
  const weekday = UZ_WEEKDAYS[date.getDay()];
  return `${day}-${month} ${year}, ${weekday}`;
}

/**
 * F4.7 — Time-of-day Uzbek greeting for the executive HeaderStrip.
 *
 *   04:00–11:59 → "Xayrli tong"
 *   12:00–17:59 → "Xayrli kun"
 *   18:00–22:59 → "Xayrli kech"
 *   23:00–03:59 → "Xayrli tun"
 */
export function getGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 4 && hour < 12) return 'Xayrli tong';
  if (hour >= 12 && hour < 18) return 'Xayrli kun';
  if (hour >= 18 && hour < 23) return 'Xayrli kech';
  return 'Xayrli tun';
}
