/**
 * The cash legs of the flows overview («caja» = the accounts under Checking accounts):
 * - {@link checkingCashByDay}: the combined value of those accounts per Chile calendar day in the
 *   unit — each account's quantity of what it holds (its ledger pesos, its ledger dollars; the
 *   balances the app displays, through the shared per-account mark cache) × that day's rate into
 *   the unit at the account's side (a dollar account's pesos at the sell rate, live today) — and,
 *   beside it, the day's fx leg: what the quantities held at the end of the previous day gained
 *   or lost from the rate's move, Σ qty(d − 1) × (rate(d) − rate(d − 1)) over the accounts whose
 *   currency is not the unit (in pesos the dollar accounts, in dollars the peso accounts) — the
 *   card's revaluation rule (`ccRevaluationCostByDate`) on the asset side. Value and leg share
 *   one quantity and one rate per account and day, so Δvalue = fx leg + the day's flows at the
 *   day's rate, and the days of a month add up to the month;
 * - {@link loadCardPaymentsFromChecking}: what the cards were paid out of those accounts —
 *   every transfer from a checking account into a card master (`pago_tarjeta`, the divisas
 *   payments at the pesos that left checking, a payment from the dollar account at its dollars),
 *   less every transfer from a card master into one (a card top-up, `carga_tarjeta`). A card
 *   paying another card moves no cash and is not here.
 */
import { bucketSlugForAccountId } from "./accountBucket.js";
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { accountValueSide } from "./accountMarkClpAtYmd.js";
import { accountValueCurrency } from "./accountValue.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { convertFlow, type CurrencyCode } from "./rates.js";
import { convertValue, pastValueRateLookup } from "./valueConvert.js";
import type { GastosUnit } from "./flowsExpensesGastos.js";

/** Ascending contiguous Chile calendar days `fromYmd..toYmd` inclusive. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): string[] {
  if (fromYmd > toYmd) throw new Error(`calendarDaysBetween: ${fromYmd} is after ${toYmd}`);
  const out: string[] = [];
  for (let d = fromYmd; d <= toYmd; d = chileCalendarAddDays(d, 1)) out.push(d);
  return out;
}

/** The checking accounts' value and fx leg per Chile day, in the unit (see the module comment). */
export type CheckingCashByDay = {
  /** Every day of the grid: Σ of the accounts' values. */
  value: Map<string, number>;
  /** Every day of the grid but the first: Σ qty(d − 1) × (rate(d) − rate(d − 1)); 0 on a day the rate did not move. */
  fx: Map<string, number>;
};

/**
 * @heavy The checking accounts' combined value in the unit for every day of `fromYmd..toYmd`
 * and the day's fx leg (the mark cache absorbs repeats). An account with no mark yet (not
 * opened) counts 0. A day whose rate is not on file throws, unless nothing was held.
 */
export function checkingCashByDay(
  checkingAccountIds: readonly number[],
  fromYmd: string,
  toYmd: string,
  unit: GastosUnit,
  now: Date = new Date()
): CheckingCashByDay {
  const grid = calendarDaysBetween(fromYmd, toYmd);
  const today = chileCalendarTodayYmd();
  // Σ of each account's value in the unit (a USD cash account: its ledger dollars), never
  // Σ pesos ÷ one rate.
  const value = new Array<number>(grid.length).fill(0);
  const fx = new Array<number>(grid.length).fill(0);
  const accountRow = db.prepare(`SELECT import_key, name FROM accounts WHERE id = ?`);
  for (const accountId of checkingAccountIds) {
    const bucketSlug = bucketSlugForAccountId(accountId);
    if (!bucketSlug) throw new Error(`checking account ${accountId} has no asset-group bucket`);
    const row = accountRow.get(accountId) as { import_key: string | null; name: string | null } | undefined;
    if (!row) throw new Error(`checking account ${accountId} not found`);
    const currency = accountValueCurrency(accountId);
    // The quantity held each day, in the account's own currency.
    const qty = accountValueSeriesOnGrid(
      { account_id: accountId, bucket_slug: bucketSlug, import_key: row.import_key, name: row.name },
      grid,
      currency
    );
    if (currency === unit) {
      for (let i = 0; i < grid.length; i++) value[i]! += qty[i] ?? 0;
      continue;
    }
    const side = accountValueSide(accountId);
    const pastRate = pastValueRateLookup(currency, unit, side);
    // A past day's stored rate (memoized in the history tier); today's rate live (`fxForLiveMtm`
    // through `rates.ts`, which reports the live read to the cache dependency node).
    const rateOn = (ymd: string): number | null =>
      ymd < today ? pastRate(ymd) : convertValue(1, currency, unit, ymd, side, now);
    let prevQty = 0;
    let prevRate: number | null = null;
    for (let i = 0; i < grid.length; i++) {
      const ymd = grid[i]!;
      const q = qty[i] ?? 0;
      const rate = rateOn(ymd);
      if (q !== 0) {
        if (rate == null || !Number.isFinite(rate)) {
          throw new Error(`checking account ${accountId}: no ${unit} rate on or before ${ymd}`);
        }
        value[i]! += q * rate;
      }
      if (i > 0 && prevQty !== 0) {
        if (prevRate == null || rate == null) {
          throw new Error(`checking account ${accountId}: no ${unit} rate for the fx leg on ${ymd}`);
        }
        fx[i]! += prevQty * (rate - prevRate);
      }
      prevQty = q;
      prevRate = rate;
    }
  }
  const out: CheckingCashByDay = { value: new Map(), fx: new Map() };
  for (let i = 0; i < grid.length; i++) {
    out.value.set(grid[i]!, value[i]!);
    if (i > 0) out.fx.set(grid[i]!, fx[i]!);
  }
  return out;
}

/** A card payment out of checking (positive) or a card top-up into checking (negative). */
export type CardPaymentFromChecking = {
  movement_id: number;
  occurred_on: string;
  /** What left (+) or entered (−) checking, in the checking leg's own currency. */
  amount: number;
  currency: CurrencyCode;
};

/** Every transfer between a checking account and a card master, signed from checking's side. */
export function loadCardPaymentsFromChecking(
  checkingAccountIds: readonly number[],
  cardMasterIds: readonly number[]
): CardPaymentFromChecking[] {
  if (checkingAccountIds.length === 0 || cardMasterIds.length === 0) return [];
  const ck = new Set(checkingAccountIds);
  const cards = new Set(cardMasterIds);
  const rows = db
    .prepare(
      `SELECT id, occurred_on, from_account_id, to_account_id, amount, currency
       FROM movements
       WHERE from_account_id IS NOT NULL AND to_account_id IS NOT NULL
       ORDER BY occurred_on, id`
    )
    .all() as {
    id: number;
    occurred_on: string;
    from_account_id: number;
    to_account_id: number;
    amount: number;
    currency: string;
  }[];
  const out: CardPaymentFromChecking[] = [];
  for (const r of rows) {
    let sign: 1 | -1;
    if (ck.has(r.from_account_id) && cards.has(r.to_account_id)) sign = 1;
    else if (cards.has(r.from_account_id) && ck.has(r.to_account_id)) sign = -1;
    else continue;
    // The from-leg carries the checking side's money for a payment; for a top-up (card → checking)
    // the card's charge equals what checking received in the same currency.
    out.push({ movement_id: r.id, occurred_on: r.occurred_on, amount: sign * r.amount, currency: r.currency });
  }
  return out;
}

/**
 * A card payment in the unit: a FLOW, so its own amount when the leg is in the unit, else that
 * amount at its own day's flow rate (`convertFlow`: pesos to dollars at the buy rate, as every
 * deposit and flow reader; any other pair at the day's mid). A missing rate throws.
 */
export function cardPaymentInUnit(p: CardPaymentFromChecking, unit: GastosUnit): number {
  return convertFlow(p.amount, p.currency, unit, p.occurred_on);
}
