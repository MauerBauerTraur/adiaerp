/**
 * EPIC 8.5 — kassa smenasi (cash shift) read service.
 *
 * Owner scenario (changes-2026-05-owner-feedback.md §8.5, image2 referens):
 *   Smena yopilganda kassir topshiradi → admin (egasi) ko'radigan kniжный/факт
 *   balans: itogo savdo, naqd, karta, rasxod, inkassatsiya, qoldiq + farq.
 *
 * Poster is the SOURCE — `finance.getCashshifts` (read-only, ADR-0002 §6, P8).
 * This service wraps the Poster client, maps each shift onto the frontend
 * `CashShift` contract (apps/frontend/src/lib/types.ts), resolves `spot_id`
 * onto the ADIA store, and derives the two values Poster does not emit
 * directly:
 *   - closing_balance      = cash_amount − expense_amount − collected_amount
 *                            (the till remainder the cashier should be holding).
 *   - balance_discrepancy  = amount_start + closing_balance − amount_end
 *                            (kniжный − факт: what the till SHOULD hold vs the
 *                            counted `amount_end`; non-zero = investigate).
 *
 * INVARIANTS: read-only — no Poster write-back, no stock mutation. Money is
 * normalised from tiyin to so'm via `tiyinToSom`.
 */
import { query } from '../db/index.js';
import type { PosterCashShift, PosterClient } from '../integrations/poster/client.js';
import { tiyinToSom } from '../integrations/poster/posterMoney.js';

export type CashShiftStatus = 'open' | 'closed';

/** Frontend `CashShift` contract shape. */
export type CashShiftDto = {
  readonly id: number;
  readonly store_id: number;
  readonly store_name: string;
  readonly status: CashShiftStatus;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly cashier_name: string | null;
  readonly total_sales: number;
  readonly card_amount: number;
  readonly cash_amount: number;
  readonly expense_amount: number;
  readonly collected_amount: number;
  readonly closing_balance: number;
  readonly balance_discrepancy: number;
};

/** Resolve every (poster_spot_id -> {store id, name}) for active stores. */
async function loadSpotToStore(): Promise<Map<number, { id: number; name: string }>> {
  const { rows } = await query<{ id: string; poster_spot_id: string | null; name: string }>(
    `SELECT id, poster_spot_id, name
       FROM locations
      WHERE type = 'store' AND is_active = TRUE AND poster_spot_id IS NOT NULL`,
  );
  const map = new Map<number, { id: number; name: string }>();
  for (const r of rows) {
    if (r.poster_spot_id !== null) {
      map.set(Number(r.poster_spot_id), { id: Number(r.id), name: r.name });
    }
  }
  return map;
}

/** ISO-normalise a Poster "YYYY-MM-DD HH:mm:ss" timestamp. Null/empty -> null. */
function posterDateToIso(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  // Poster local times have no tz; treat as UTC for a stable ISO string.
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure mapper — turn one Poster cash shift into the `CashShift` contract.
 * Exported for unit testing without a DB or network. A shift whose spot does
 * not resolve to an ADIA store yields store_id 0 / store_name '' (the caller
 * filters those out).
 */
export function mapCashShift(
  raw: PosterCashShift,
  store: { id: number; name: string } | undefined,
): CashShiftDto {
  const cash = tiyinToSom(raw.amount_sell_cash);
  const card = tiyinToSom(raw.amount_sell_card);
  const expense = tiyinToSom(raw.amount_debit);
  const collected = tiyinToSom(raw.amount_collection);
  const amountStart = tiyinToSom(raw.amount_start);
  const amountEnd = tiyinToSom(raw.amount_end);
  const closedAt = posterDateToIso(raw.date_end ?? null);
  const status: CashShiftStatus = closedAt === null ? 'open' : 'closed';

  // Till remainder the cashier should hold = float + cash sales − payouts −
  // collected. `amount_end` is the FACT (counted) cash. Discrepancy = book − fact.
  const closingBalance = round2(amountStart + cash - expense - collected);
  const discrepancy = status === 'closed' ? round2(closingBalance - amountEnd) : 0;

  return {
    id: Number(raw.cash_shift_id),
    store_id: store?.id ?? 0,
    store_name: store?.name ?? '',
    status,
    opened_at: posterDateToIso(raw.date_start ?? null) ?? new Date(0).toISOString(),
    closed_at: closedAt,
    cashier_name: raw.user_id !== undefined ? `Poster #${raw.user_id}` : null,
    total_sales: round2(cash + card),
    card_amount: card,
    cash_amount: cash,
    expense_amount: expense,
    collected_amount: collected,
    closing_balance: closingBalance,
    balance_discrepancy: discrepancy,
  };
}

export type ListCashShiftsArgs = {
  readonly dateFrom: string; // YYYYMMDD
  readonly dateTo: string; // YYYYMMDD
  /** RBAC: when set, only shifts for these ADIA store ids are returned. */
  readonly storeIds?: number[] | null;
};

/**
 * Fetch + map cash shifts from Poster for the date range, RBAC-scoped to
 * `storeIds` when provided. Shifts whose spot does not map to an active ADIA
 * store are dropped (store_id 0).
 */
export async function listCashShifts(
  poster: PosterClient,
  args: ListCashShiftsArgs,
): Promise<CashShiftDto[]> {
  const spotToStore = await loadSpotToStore();
  const raw = await poster.getCashShifts({ dateFrom: args.dateFrom, dateTo: args.dateTo });
  const allowed = args.storeIds == null ? null : new Set(args.storeIds);
  const out: CashShiftDto[] = [];
  for (const r of raw) {
    const spotId = r.spot_id === undefined ? null : Number(r.spot_id);
    const store = spotId !== null ? spotToStore.get(spotId) : undefined;
    if (store === undefined) continue; // unmapped spot — skip.
    if (allowed !== null && !allowed.has(store.id)) continue; // RBAC filter.
    out.push(mapCashShift(r, store));
  }
  // Newest first (by close, then open).
  out.sort((a, b) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at));
  return out;
}
