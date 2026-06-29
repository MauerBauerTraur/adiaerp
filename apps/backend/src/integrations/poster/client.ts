/**
 * Typed Poster POS API client (read-only — Faza-1 / ADR-0002 §6).
 *
 * Wraps the small slice of Poster endpoints M7 needs:
 *   - access.getSpots             — 5 retail spots
 *   - storage.getStorages         — 25 storages
 *   - storage.getStorageLeftovers — current on-hand qty per storage
 *   - menu.getIngredients         — raw ingredients (375 in production)
 *   - menu.getProducts            — menu products (293 in production)
 *   - menu.getProduct             — single menu product with BOM (`ingredients`)
 *   - menu.getPrepacks            — 1121 prepacks with their BOMs
 *   - dash.getTransactions        — sales check list (fallback poll)
 *   - dash.getTransaction         — one check with line products
 *
 * Cross-cutting behaviour:
 *   - rate limit ~5 req/sec via a serial gate + minimum 200ms gap;
 *   - per-call timeout (default 10s) via `AbortController`;
 *   - secrets (token) NEVER appear in thrown errors or log lines —
 *     we strip the `token` query param from any URL we surface.
 *
 * The client is a class with a `.fetch()` injection point so tests can mock the
 * network without an HTTP server. Production code constructs it via
 * `createPosterClientFromConfig()` and reuses the singleton.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../config/index.js';
import { AppError } from '../../errors/index.js';

// -----------------------------------------------------------------------------
// Response row shapes — keys present in real Poster responses (2026-05-23).
// All numeric-looking fields arrive as strings; we keep them as strings here
// and parse at the boundary inside each sync service.
// -----------------------------------------------------------------------------

export type PosterSpot = {
  spot_id: string;
  name: string;
  spot_name?: string;
  spot_adress?: string;
};

export type PosterStorage = {
  storage_id: string;
  storage_name: string;
  storage_adress?: string;
  delete?: string;
};

export type PosterLeftover = {
  ingredient_id: string;
  ingredient_name: string;
  ingredient_left: string;
  /** Per-storage on-hand qty. May be NEGATIVE (Poster bookkeeping artefact). */
  storage_ingredient_left: string;
  storage_ingredient_sum?: string;
  prime_cost?: string;
  ingredient_unit: string;
  /** "1" = raw ingredient, "2" = finished good (G/P). Both keyed by ingredient_id. */
  ingredients_type: string;
  limit_value?: string;
  hidden?: string;
};

export type PosterIngredient = {
  ingredient_id: number | string;
  ingredient_name: string;
  ingredient_unit: string;
  ingredients_type?: number | string;
  limit_value?: number | string;
};

export type PosterWorkshop = {
  workshop_id: string | number;
  workshop_name: string;
  /** Optional: Poster storage associated with this workshop. */
  ingredients_storage_id?: string | number;
};

export type PosterMenuProductRow = {
  product_id: string;
  product_name: string;
  /** "2" = stocked menu item, "3" = configured-via-modifications. */
  type: string;
  ingredient_id?: string;
  unit?: string;
  menu_category_id?: string;
  /** BOM-calculated cost from Poster (in UZS). */
  cost?: string;
  /** Workshop (цех) this product is prepared in. */
  workshop?: string | number;
};

export type PosterRecipeIngredient = {
  structure_id: string;
  ingredient_id: string;
  /** Quantity unit of the brutto/netto values: typically "g" or "kg". */
  structure_unit: string;
  /** "1" = raw, "2" = prepack (semi). */
  structure_type: string;
  structure_brutto: number | string;
  structure_netto: number | string;
  ingredient_name: string;
  ingredient_unit: string;
};

export type PosterMenuProductFull = PosterMenuProductRow & {
  ingredients?: PosterRecipeIngredient[];
  /** Per-spot selling prices: { "1": "630000", "2": "630000", ... } */
  price?: Record<string, string> | null;
};

export type PosterPrepack = {
  product_id: string;
  ingredient_id: string;
  product_name: string;
  /** Yield of one batch — used to normalise BOM qty per produced unit. */
  out: number | string;
  ingredients: PosterRecipeIngredient[];
  /** Workshop (цех) this prepack is produced in. */
  workshop_id?: string | number;
};

export type PosterTransactionLine = {
  product_id: string;
  modification_id?: string;
  num: string;
  product_price: string;
  payed_sum?: string;
};

export type PosterTransactionSummary = {
  transaction_id: string;
  spot_id: string;
  date_close?: string;
  status?: string;
  sum?: string;
};

export type PosterTransactionFull = PosterTransactionSummary & {
  products?: PosterTransactionLine[];
};

/**
 * Sub-task #7 — row shape returned by `dash.getPaymentsReport`. Aggregates
 * sales by payment method for a date range. Poster groups by day-and-method;
 * `payment_count`/`payment_sum` are strings (Poster numeric convention).
 *
 * Fields seen in real responses:
 *   date          — YYYY-MM-DD
 *   spot_id       — present when `spot_id` parameter was set
 *   payment_id    — built-in 1=cash, 2=card; custom methods get next free int
 *   payment_title — operator-chosen label ("Payme", "Click", "Naqd")
 *   payment_count — integer string ("17")
 *   payment_sum   — money string in the venue's currency ("1234500")
 */
export type PosterPaymentReportRow = {
  date?: string;
  spot_id?: string | number;
  payment_id: string | number;
  payment_title: string;
  payment_count: string | number;
  payment_sum: string | number;
};

/**
 * Real `dash.getPaymentsReport` response shape verified against the live
 * `adia` Poster account on 2026-05-28. Poster does NOT emit an array of
 * `{payment_id, payment_title, payment_sum}` rows — it emits a single
 * aggregate object with a per-day breakdown and a grand `total` block.
 * Money is in tiyin (1 so'm = 100). All numeric-looking fields may arrive
 * as either strings or numbers — Poster is inconsistent across endpoints.
 */
export type PosterPaymentDay = {
  date: string;
  payed_cash_sum?: string | number;
  payed_card_sum?: string | number;
  payed_cert_in_sum?: string | number;
  payed_cert_out_sum?: string | number;
  payed_bonus_sum?: string | number;
  payed_third_party_sum?: string | number;
  payed_ewallet_sum?: string | number;
  payed_sum_sum?: string | number;
  round_sum?: string | number;
};

export type PosterPaymentTotal = {
  payed_cash_sum?: string | number;
  payed_card_sum?: string | number;
  payed_cert_in_sum?: string | number;
  payed_cert_out_sum?: string | number;
  payed_bonus_sum?: string | number;
  payed_third_party_sum?: string | number;
  payed_ewallet_sum?: string | number;
  payed_sum_sum?: string | number;
  transactions_count?: string | number;
};

export type PosterPaymentReport = {
  days?: PosterPaymentDay[];
  total: PosterPaymentTotal;
};

/**
 * EPIC 0.1 / 0.2 / P4 — `dash.getAnalytics` response (doc §5.1).
 *
 * UNIT NOTE: unlike `getPaymentsReport` (tiyin), the analytics `data` series
 * and `counters.revenue` are ALREADY in so'm — verified live 2026-05-29:
 * the 2026-05-29 daily revenue was "19553300.0000" (so'm) here vs
 * 1955330000 (tiyin) in getPaymentsReport. So NO ÷100 for analytics values.
 *
 * `data` is the per-interval series (one entry per day when
 * `interpolate=day`). Values are decimal strings ("31059707.0000").
 */
export type PosterAnalyticsCounters = {
  revenue?: string | number;
  profit?: string | number;
  transactions?: string | number;
  visitors?: string | number;
  average_receipt?: string | number;
  average_time?: string | number;
};

export type PosterAnalytics = {
  data?: Array<string | number>;
  data_hourly?: Array<string | number>;
  data_weekday?: Array<string | number>;
  counters?: PosterAnalyticsCounters;
};

/**
 * EPIC 8.5 / P8 — `finance.getCashshifts` row (kassa smenasi). One row per
 * opened/closed cash-register shift. Money fields are in TIYIN (Poster finance
 * convention — divide by 100 via `tiyinToSom`). Field names follow Poster's
 * public finance schema; all numeric fields may arrive as string or number.
 *
 *   cash_shift_id     — shift id.
 *   spot_id           — the retail spot (maps to an ADIA store).
 *   amount_start      — opening till float.
 *   amount_end        — closing till count (factual cash counted).
 *   amount_sell_cash  — cash sales during the shift.
 *   amount_sell_card  — card / non-cash sales during the shift.
 *   amount_debit      — pay-outs from the till (rasxod / expenses).
 *   amount_collection — cash collected up the chain (inkassatsiya).
 *   date_start/end    — open/close timestamps ("YYYY-MM-DD HH:mm:ss").
 *   user_id           — cashier (Poster employee id).
 */
export type PosterCashShift = {
  cash_shift_id: string | number;
  spot_id?: string | number;
  amount_start?: string | number;
  amount_end?: string | number;
  amount_sell_cash?: string | number;
  amount_sell_card?: string | number;
  amount_debit?: string | number;
  amount_collection?: string | number;
  date_start?: string;
  date_end?: string | null;
  user_id?: string | number;
};

/**
 * M10 — `storage.getSupplies` list row.
 * `supply_sum` is in TIYIN in the list response; the sync service divides by 100.
 */
export type PosterSupplyRow = {
  supply_id: string | number;
  storage_id: string | number;
  supplier_id?: string | number;
  supplier_name?: string;
  storage_name?: string;
  date: string;
  supply_sum: string | number;
  supply_sum_netto?: string | number;
  supply_comment?: string;
  delete?: string | number;
  account_id?: string | number;
};

/** M10 — one ingredient line inside `storage.getSupply` detail. */
export type PosterSupplyIngredient = {
  ingredient_id: number | string;
  supply_ingredient_num: number | string;
  supply_ingredient_sum: string | number;   // so'm (not tiyin)
  supply_ingredient_sum_netto?: string | number;
  ingredient_name: string;
  ingredient_unit: string;
  pack_id?: number;
  type?: number;
  ing_delete?: number;
};

/** M10 — full `storage.getSupply` response (header + ingredients). */
export type PosterSupplyDetail = {
  supply_id: number | string;
  storage_id: number | string;
  supplier_id?: number | string;
  supplier_name?: string;
  date: string;
  supply_sum: string | number;   // so'm (not tiyin)
  supply_comment?: string;
  ingredients?: PosterSupplyIngredient[];
};

/**
 * EPIC 8.7 / P8 — `finance.getTransactions` row (moliyaviy operatsiya). A safe
 * (seyf) income/expense entry. `type` 0 = expense (rasxod), 1 = income; we
 * surface expenses for the safe-expense view. `amount` is in TIYIN.
 *
 *   transaction_id  — finance transaction id.
 *   account_id      — the money account (the safe).
 *   category_id     — expense/income category id.
 *   category_name   — category label ("Ijara", "Maosh"…).
 *   type            — "0" expense, "1" income.
 *   amount          — money in tiyin (positive).
 *   date            — "YYYY-MM-DD HH:mm:ss".
 *   user_id         — who recorded it.
 *   comment         — free-text note.
 */
export type PosterFinanceTransaction = {
  transaction_id: string | number;
  account_id?: string | number;
  category_id?: string | number;
  category_name?: string;
  type?: string | number;
  amount?: string | number;
  date?: string;
  user_id?: string | number;
  comment?: string | null;
};

// -----------------------------------------------------------------------------
// Client options + errors
// -----------------------------------------------------------------------------

export type PosterClientOptions = {
  /** Personal Integration token (account:32hex). REQUIRED for any call. */
  readonly token: string;
  /** Override the base URL (used by tests). Defaults to the public Poster host. */
  readonly baseUrl?: string;
  /**
   * Per-call timeout in ms. Default: 20_000 (20s).
   *
   * I9 (Sprint 3 audit P2): Poster's first call after a cold idle window is
   * 4–5s; the previous 10s default left almost no headroom and the FIRST
   * `menu.getIngredients` after process start surfaced as `fetch failed`.
   * 20s gives a comfortable margin while still bounding a stuck request.
   */
  readonly timeoutMs?: number;
  /** Minimum gap between calls in ms. Default: 220 (≈4.5 req/sec, under 5). */
  readonly minIntervalMs?: number;
  /** Injection point for tests — default is the global `fetch`. */
  readonly fetcher?: typeof fetch;
  /**
   * Transient-failure retry attempts. Default: 1 (so up to 2 total attempts).
   * Only `AbortError` (timeout) and bare `fetch failed` / network errors are
   * retried — 4xx/5xx Poster envelopes pass through untouched. Backoff is a
   * fixed 300ms gap before the retry.
   */
  readonly transientRetries?: number;
};

export class PosterApiError extends Error {
  public override readonly name = 'PosterApiError';
  public readonly method: string;
  public readonly status: number | undefined;
  public readonly posterCode: number | undefined;

  constructor(
    method: string,
    message: string,
    opts: { status?: number; posterCode?: number } = {},
  ) {
    super(`[poster:${method}] ${message}`);
    this.method = method;
    this.status = opts.status;
    this.posterCode = opts.posterCode;
  }
}

// -----------------------------------------------------------------------------
// Client implementation
// -----------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://joinposter.com/api';

/**
 * The typed Poster client. One instance per process is enough; construct via
 * `createPosterClientFromConfig()` so the token is read from validated config.
 */
export class PosterClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly fetcher: typeof fetch;
  private readonly transientRetries: number;
  /** Serial gate — every call awaits this chain so requests run one at a time. */
  private gate: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(opts: PosterClientOptions) {
    if (typeof opts.token !== 'string' || opts.token.trim() === '') {
      throw new PosterApiError(
        '<init>',
        'Poster token is missing — set POSTER_TOKEN in .env before using the client.',
      );
    }
    this.token = opts.token.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.minIntervalMs = opts.minIntervalMs ?? 220;
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.transientRetries = opts.transientRetries ?? 1;
  }

  // --- Public API methods --------------------------------------------------

  async getSpots(): Promise<PosterSpot[]> {
    const r = await this.call<PosterSpot[]>('access.getSpots');
    return r ?? [];
  }

  async getStorages(): Promise<PosterStorage[]> {
    const r = await this.call<PosterStorage[]>('storage.getStorages');
    return r ?? [];
  }

  async getStorageLeftovers(storageId: number): Promise<PosterLeftover[]> {
    const r = await this.call<PosterLeftover[]>('storage.getStorageLeftovers', {
      storage_id: String(storageId),
    });
    return r ?? [];
  }

  async getIngredients(): Promise<PosterIngredient[]> {
    const r = await this.call<PosterIngredient[]>('menu.getIngredients');
    return r ?? [];
  }

  async getProducts(): Promise<PosterMenuProductRow[]> {
    const r = await this.call<PosterMenuProductRow[]>('menu.getProducts');
    return r ?? [];
  }

  async getProduct(productId: number): Promise<PosterMenuProductFull | null> {
    const r = await this.call<PosterMenuProductFull | PosterMenuProductFull[]>(
      'menu.getProduct',
      { product_id: String(productId) },
    );
    if (r === null || r === undefined) return null;
    return Array.isArray(r) ? (r[0] ?? null) : r;
  }

  async getPrepacks(): Promise<PosterPrepack[]> {
    const r = await this.call<PosterPrepack[]>('menu.getPrepacks');
    return r ?? [];
  }

  async getWorkshops(): Promise<PosterWorkshop[]> {
    const r = await this.call<PosterWorkshop[]>('menu.getWorkshops');
    return r ?? [];
  }

  /**
   * M10 — Fetch supply (Поставки) list for a date range.
   * `dateFrom`/`dateTo` are `YYYYMMDD` strings (Poster convention).
   * Returns list-level rows; `supply_sum` is in TIYIN — divide by 100 for so'm.
   */
  async getSupplies(params: {
    dateFrom: string;
    dateTo: string;
    page?: number;
    perPage?: number;
  }): Promise<PosterSupplyRow[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.page !== undefined) qs.page = String(params.page);
    if (params.perPage !== undefined) qs.per_page = String(params.perPage);
    const r = await this.call<PosterSupplyRow[]>('storage.getSupplies', qs);
    return r ?? [];
  }

  /**
   * M10 — Fetch a single supply with its ingredient lines.
   * `supply_sum` and `supply_ingredient_sum` are in SO'M (not tiyin).
   */
  async getSupply(supplyId: number): Promise<PosterSupplyDetail | null> {
    return this.call<PosterSupplyDetail>('storage.getSupply', {
      supply_id: String(supplyId),
    });
  }

  /**
   * Fetch a sales check list. `dateFrom`/`dateTo` are `YYYY-MM-DD HH:mm:ss`
   * strings (Poster accepts them for `dash.getTransactions`).
   */
  async getTransactions(params: {
    dateFrom: string;
    dateTo: string;
    spotId?: number;
    num?: number;
  }): Promise<PosterTransactionSummary[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    if (params.num !== undefined) qs.num = String(params.num);
    const r = await this.call<PosterTransactionSummary[]>('dash.getTransactions', qs);
    return r ?? [];
  }

  /**
   * Sub-task #7 — sales aggregated by payment method.
   * Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getPaymentsReport(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string;   // YYYYMMDD
    spotId?: number;
  }): Promise<PosterPaymentReportRow[] | PosterPaymentReport> {
    // Poster returns ONE of two shapes here:
    //   • the real `{days, total}` aggregate (production today);
    //   • a legacy/synthetic per-method row array (used by older tests).
    // We return the raw response and let the caller branch on shape — that
    // way a future Poster format change touches one place, not every caller.
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterPaymentReportRow[] | PosterPaymentReport>(
      'dash.getPaymentsReport',
      qs,
    );
    return r ?? [];
  }

  /**
   * EPIC 0.1 / 0.2 — `dash.getAnalytics`: revenue/profit/transactions series.
   * The single authoritative revenue source (already in so'm — see
   * `PosterAnalytics`). Used by the dashboard chart + historical backfill so
   * the 30-day chart reflects Poster instead of the locally-corrupted `sales`
   * aggregate. Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getAnalytics(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    interpolate?: 'day' | 'week' | 'month';
    select?: 'revenue' | 'profit' | 'transactions' | 'visitors' | 'average_receipt';
    spotId?: number;
  }): Promise<PosterAnalytics> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      interpolate: params.interpolate ?? 'day',
      select: params.select ?? 'revenue',
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterAnalytics>('dash.getAnalytics', qs);
    return r ?? {};
  }

  async getTransaction(transactionId: number): Promise<PosterTransactionFull | null> {
    const r = await this.call<PosterTransactionFull | PosterTransactionFull[]>(
      'dash.getTransaction',
      { transaction_id: String(transactionId), include_products: 'true' },
    );
    if (r === null || r === undefined) return null;
    return Array.isArray(r) ? (r[0] ?? null) : r;
  }

  /**
   * EPIC 8.5 — cash-register shifts in a date range (read-only). Date strings
   * follow Poster's `YYYYMMDD` convention. Returns `[]` when none.
   */
  async getCashShifts(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    spotId?: number;
  }): Promise<PosterCashShift[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterCashShift[]>('finance.getCashshifts', qs);
    return r ?? [];
  }

  /**
   * EPIC 8.7 — finance transactions (safe income/expense) in a date range
   * (read-only). Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getFinanceTransactions(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    accountId?: number;
  }): Promise<PosterFinanceTransaction[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.accountId !== undefined) qs.account_id = String(params.accountId);
    const r = await this.call<PosterFinanceTransaction[]>('finance.getTransactions', qs);
    return r ?? [];
  }

  // --- Internal: throttled, timed-out, parameterized call -----------------

  private async call<T>(
    method: string,
    params: Readonly<Record<string, string>> = {},
  ): Promise<T | null> {
    // Serial gate — every call waits for the previous chain to settle, then
    // ensures we are at least `minIntervalMs` past the previous call's start.
    const ticket = this.gate.then(async () => {
      const gap = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (gap > 0) await delay(gap);
      this.lastCallAt = Date.now();
    });
    // Chain regardless of outcome — a slow/failed call must NOT block the gate.
    this.gate = ticket.catch(() => undefined);
    await ticket;

    // I9 (Sprint 3 audit P2): retry once on transient network failures
    // (`fetch failed` from undici, `AbortError` from our own timeout). Poster
    // HTTP 4xx/5xx envelopes and `error: {...}` envelopes are NOT retried —
    // they are deterministic API responses and a retry would be wasted work.
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.transientRetries; attempt += 1) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (err) {
        lastErr = err;
        if (!this.isTransient(err) || attempt === this.transientRetries) {
          throw err;
        }
        // Fixed 300ms backoff — the rate-limit gate already enforces 220ms.
        await delay(300);
      }
    }
    // Unreachable — the loop either returns or throws.
    throw lastErr;
  }

  /** Single HTTP attempt. The outer `call()` wraps this with retry. */
  private async callOnce<T>(
    method: string,
    params: Readonly<Record<string, string>>,
  ): Promise<T | null> {
    const url = this.buildUrl(method, params);
    const ctrl = new AbortController();
    const t = globalThis.setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) {
        // Do not leak the token in error messages — surface just the method.
        throw new PosterApiError(method, `HTTP ${res.status} ${res.statusText}`, {
          status: res.status,
        });
      }
      const body = (await res.json()) as
        | { response: T }
        | { error: { code: number; message: string } };
      if ('error' in body) {
        throw new PosterApiError(method, body.error.message, { posterCode: body.error.code });
      }
      return body.response ?? null;
    } catch (err) {
      if (err instanceof PosterApiError) throw err;
      const msg = (err as Error)?.message ?? String(err);
      // AbortError from the timeout has its own name; surface it cleanly.
      if ((err as Error)?.name === 'AbortError') {
        throw new PosterApiError(method, `request timed out after ${this.timeoutMs}ms`);
      }
      throw new PosterApiError(method, msg);
    } finally {
      globalThis.clearTimeout(t);
    }
  }

  /**
   * Decide whether an error is worth retrying. Transient = the call never
   * reached a real Poster response (network drop, DNS, our own timeout).
   * A `PosterApiError` with `status` set means we got an HTTP response from
   * Poster (4xx/5xx) — that is NOT transient. A `PosterApiError` with
   * `posterCode` set means Poster returned an `{error}` envelope — also
   * not transient. Only timeouts and bare network failures retry.
   */
  private isTransient(err: unknown): boolean {
    if (err instanceof PosterApiError) {
      if (err.status !== undefined || err.posterCode !== undefined) return false;
      const m = err.message ?? '';
      return /timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m);
    }
    const e = err as { name?: string; message?: string };
    if (e?.name === 'AbortError') return true;
    return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e?.message ?? '');
  }

  private buildUrl(method: string, params: Readonly<Record<string, string>>): string {
    const url = new URL(`${this.baseUrl}/${method}`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }
}

/**
 * Lazy singleton — built from validated config on first access. Throws clearly
 * when `POSTER_TOKEN` is empty in `.env`.
 */
let cached: PosterClient | undefined;

export function createPosterClientFromConfig(): PosterClient {
  if (cached !== undefined) return cached;
  const cfg = loadConfig();
  if (cfg.poster.token === '') {
    throw AppError.internal(
      'POSTER_TOKEN is not configured — set it in .env before using Poster integration.',
    );
  }
  cached = new PosterClient({ token: cfg.poster.token });
  return cached;
}

/** TEST-ONLY — reset the singleton between suites. */
export function resetPosterClientCache(): void {
  cached = undefined;
}

/** TEST-ONLY — install a specific instance as the singleton. */
export function setPosterClientForTests(client: PosterClient | undefined): void {
  cached = client;
}
