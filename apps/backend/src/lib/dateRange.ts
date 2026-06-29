/**
 * F4.9 — Dashboard `?range` query parser.
 *
 * The dashboard endpoints accept one of two shapes:
 *
 *   - `?range=today|week|month` (preset, server-evaluated)
 *   - `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (custom window)
 *
 * Default is `today` (TZ section 4.8 — "operator sees today's pulse first").
 *
 * The parser returns a half-open interval `[from, to)` in absolute Date
 * values so SQL filters can use `>= $from AND < $to`. This avoids the
 * timezone trap of comparing TIMESTAMPTZ columns to bare DATE strings.
 *
 * Inputs are validated at the boundary (security-and-hardening): unknown
 * `range` -> 422; malformed `from`/`to` -> 422; reversed window -> 422.
 */
import { AppError } from '../errors/index.js';

/** Allowed preset values. `custom` requires `from` and `to`. */
export const RANGE_PRESETS = ['today', 'week', 'month', '6m', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export type DateRange = {
  /** Inclusive lower bound (UTC instant). */
  from: Date;
  /** Exclusive upper bound (UTC instant). */
  to: Date;
  /** Echo of the resolved preset — useful for response metadata. */
  preset: RangePreset;
};

/**
 * Parse the `req.query` shape into a concrete window. The caller passes
 * whatever Express handed it; this function tolerates `undefined` and the
 * Express `string | ParsedQs | (string | ParsedQs)[]` union by demanding
 * strings only.
 */
export function parseDateRange(query: {
  range?: unknown;
  from?: unknown;
  to?: unknown;
}): DateRange {
  const rangeRaw = typeof query.range === 'string' ? query.range : 'today';
  if (!(RANGE_PRESETS as readonly string[]).includes(rangeRaw)) {
    throw AppError.validation(
      `"range" must be one of: ${RANGE_PRESETS.join(', ')}.`,
    );
  }
  const preset = rangeRaw as RangePreset;
  // Anchor on "now" so the window slides with the request — cheaper than
  // truncating in SQL (every sub-query reuses the same instant).
  const now = new Date();

  if (preset === 'custom') {
    const fromRaw = typeof query.from === 'string' ? query.from : '';
    const toRaw = typeof query.to === 'string' ? query.to : '';
    if (fromRaw === '' || toRaw === '') {
      throw AppError.validation(
        '"from" and "to" are required when range=custom.',
      );
    }
    const from = parseDateOnly(fromRaw, 'from');
    // `to` is the END of the day inclusive — turn it into the next day's
    // 00:00 so the SQL filter `< to` covers all of `to`.
    const toStart = parseDateOnly(toRaw, 'to');
    const to = new Date(toStart.getTime() + 24 * 60 * 60 * 1000);
    if (from >= to) {
      throw AppError.validation('"from" must be earlier than "to".');
    }
    return { from, to, preset };
  }

  if (preset === 'today') {
    // [start of today (UTC), now)
    const from = startOfUtcDay(now);
    return { from, to: now, preset };
  }
  if (preset === 'week') {
    // Last 7 full days including today.
    const from = new Date(startOfUtcDay(now).getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from, to: now, preset };
  }
  if (preset === 'month') {
    // Last 30 days including today.
    const from = new Date(startOfUtcDay(now).getTime() - 29 * 24 * 60 * 60 * 1000);
    return { from, to: now, preset };
  }
  // 6m — last 6 calendar months including today. UTC arithmetic so DST
  // never shifts the window by an hour.
  const today = startOfUtcDay(now);
  const from = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, today.getUTCDate()),
  );
  return { from, to: now, preset };
}

/**
 * Date -> Poster `YYYYMMDD` (the format Poster's report endpoints expect).
 * Uses the UTC date so it agrees with the half-open `[from, to)` windows above.
 */
export function toPosterDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function parseDateOnly(raw: string, label: string): Date {
  // Strict YYYY-MM-DD only — Date(raw) accepts too many shapes.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppError.validation(`"${label}" must be YYYY-MM-DD.`);
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation(`"${label}" is not a valid date.`);
  }
  return d;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
