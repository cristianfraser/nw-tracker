/**
 * The cash legs of the flows overview («caja» = the accounts under Checking accounts):
 * - {@link checkingValueByDay}: the combined ledger value of those accounts per Chile calendar
 *   day (`accountMarkClpAtYmd` through the shared per-account mark cache — the balances the app
 *   displays), each day converted to the unit at that day's rate;
 * - {@link loadCardPaymentsFromChecking}: what the cards were paid out of those accounts —
 *   every transfer from a checking account into a card master (`pago_tarjeta`, the divisas
 *   payments at the pesos that left checking, a payment from the dollar account at its dollars),
 *   less every transfer from a card master into one (a card top-up, `carga_tarjeta`). A card
 *   paying another card moves no cash and is not here.
 */
import { bucketSlugForAccountId } from "./accountBucket.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { accountValueClpToUnitAt, clpToUnitAt } from "./clpToUnitAt.js";
import type { GastosUnit } from "./flowsExpensesGastos.js";

/** Ascending contiguous Chile calendar days `fromYmd..toYmd` inclusive. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): string[] {
  if (fromYmd > toYmd) throw new Error(`calendarDaysBetween: ${fromYmd} is after ${toYmd}`);
  const out: string[] = [];
  for (let d = fromYmd; d <= toYmd; d = chileCalendarAddDays(d, 1)) out.push(d);
  return out;
}

/**
 * @heavy The checking accounts' combined value in the unit for every day of `fromYmd..toYmd`
 * (the mark cache absorbs repeats). An account with no mark yet (not opened) counts 0.
 */
export function checkingValueByDay(
  checkingAccountIds: readonly number[],
  fromYmd: string,
  toYmd: string,
  unit: GastosUnit,
  now: Date = new Date()
): Map<string, number> {
  const grid = calendarDaysBetween(fromYmd, toYmd);
  // Σ of each account's value in the unit (a USD cash account: its ledger dollars), never
  // Σ pesos ÷ one rate.
  const inUnit = new Array<number>(grid.length).fill(0);
  const accountRow = db.prepare(`SELECT import_key, name FROM accounts WHERE id = ?`);
  for (const accountId of checkingAccountIds) {
    const bucketSlug = bucketSlugForAccountId(accountId);
    if (!bucketSlug) throw new Error(`checking account ${accountId} has no asset-group bucket`);
    const row = accountRow.get(accountId) as { import_key: string | null; name: string | null } | undefined;
    if (!row) throw new Error(`checking account ${accountId} not found`);
    const series = accountMarkClpSeriesOnGrid(
      { account_id: accountId, bucket_slug: bucketSlug, import_key: row.import_key, name: row.name },
      grid
    );
    for (let i = 0; i < grid.length; i++) {
      const clp = series[i] ?? 0;
      const v = accountValueClpToUnitAt(accountId, clp, grid[i]!, unit, { now });
      if (v == null || !Number.isFinite(v)) {
        throw new Error(`checking account ${accountId}: no ${unit} rate on or before ${grid[i]}`);
      }
      inUnit[i]! += v;
    }
  }
  const out = new Map<string, number>();
  for (let i = 0; i < grid.length; i++) out.set(grid[i]!, inUnit[i]!);
  return out;
}

/** A card payment out of checking (positive) or a card top-up into checking (negative). */
export type CardPaymentFromChecking = {
  movement_id: number;
  occurred_on: string;
  /** Pesos that left (+) or entered (−) checking; a dollar leg at that day's rate. */
  amount_clp: number;
  /** The dollars when the checking leg is the dollar account; null for a peso leg. */
  amount_usd: number | null;
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
    if (r.currency === "clp") {
      out.push({ movement_id: r.id, occurred_on: r.occurred_on, amount_clp: sign * r.amount, amount_usd: null });
    } else if (r.currency === "usd") {
      const fx = fxRowOnOrBefore(r.occurred_on);
      if (!fx || !(fx.clp_per_usd > 0)) {
        throw new Error(`card payment ${r.id}: no USD rate on or before ${r.occurred_on}`);
      }
      out.push({
        movement_id: r.id,
        occurred_on: r.occurred_on,
        amount_clp: sign * r.amount * fx.clp_per_usd,
        amount_usd: sign * r.amount,
      });
    } else {
      throw new Error(`card payment ${r.id}: unexpected currency ${r.currency}`);
    }
  }
  return out;
}

/** A card payment in the unit: its dollars when the leg is in dollars, else its pesos at that day's rate. */
export function cardPaymentInUnit(p: CardPaymentFromChecking, unit: GastosUnit, now: Date = new Date()): number {
  if (unit === "usd" && p.amount_usd != null) return p.amount_usd;
  if (unit === "clp") return p.amount_clp;
  const v = clpToUnitAt(p.amount_clp, p.occurred_on, unit, { now });
  if (v == null || !Number.isFinite(v)) {
    throw new Error(`card payment ${p.movement_id}: no ${unit} rate on or before ${p.occurred_on}`);
  }
  return v;
}
