/**
 * What the money leaving a foreign cash account cost in pesos, traced through the client's own
 * foreign cash accounts — so a card's foreign debt paid in that currency (a `pago_tarjeta`
 * transfer from a foreign cash account in its own currency, no counter leg: the dollar account
 * paying the card's dollars) counts at the pesos that money was bought with, not at the day's rate.
 *
 * The walk is `foreignCashLotWalk.ts` (FIFO queues per account, Chile-date order with the stated
 * times, request-time reservations, own transfers carrying slices). This module sets its scope
 * and its prices:
 * - scope: the foreign cash accounts a card payment leaves from in their own currency, plus,
 *   recursively, every foreign cash account that sent money into one in scope (in either
 *   currency of the row — a conversion between two foreign currencies feeds the account too);
 * - a `purchase` (a transfer in with a CLP leg and a counter leg in the account's currency) is
 *   priced at its pesos; a `conversion` from another foreign currency at the pesos the slices it
 *   consumed carried (the cost passes through the conversion); a `market` inflow (dividends,
 *   sales, interest, plain deposits) at the stored mid of its currency on or before its date
 *   (`rates.ts`: the dollar's is the `fx_daily` close, the reference rate the dollar cash capital
 *   flows use for dollars with no pesos of their own); a missing rate throws.
 *
 * Each outflow lists the slices it consumed as lots: a slice still on the account that acquired
 * it is a `purchase` / `conversion` / `market` lot naming the acquisition; a slice that came
 * through an own transfer is an `own_transfer` lot naming the transfer (one lot per carried slice,
 * so a partial spend of a batch that spans two purchase rates is priced at the older rate first).
 */
import { foreignCashCurrencyOf } from "./cashCurrency.js";
import { db } from "./db.js";
import { movementLeg } from "./movementAmounts.js";
import { convertCurrency } from "./rates.js";

import {
  foreignCashScope,
  fromMinor,
  walkForeignCashLotsFromDb,
  type ForeignLotSlice,
  type ForeignWalkInput,
} from "./foreignCashLotWalk.js";

export type ForeignOutflowLotSource = "purchase" | "conversion" | "own_transfer" | "market";

export type ForeignOutflowLot = { source: ForeignOutflowLotSource; amount: number; clp: number; movement_id: number };

export type ForeignOutflowPesoCost = { currency: string; amount: number; clp: number; lots: ForeignOutflowLot[] };

/** The foreign cash accounts a card payment leaves from in their own currency (`pago_tarjeta`, no counter leg). */
function foreignCardPaymentSources(): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT from_account_id AS id, currency FROM movements
       WHERE flow_kind = 'pago_tarjeta' AND account_id IS NULL AND from_account_id IS NOT NULL
         AND counter_currency IS NULL`
    )
    .all() as { id: number; currency: string }[];
  return [...new Set(rows.filter((r) => foreignCashCurrencyOf(r.id) === r.currency).map((r) => r.id))];
}

/** The sources plus every foreign cash account that sent money into one already in scope. */
function scopeAccounts(sources: readonly number[]): Map<number, string> {
  const scope = foreignCashScope(sources);
  const feeders = db.prepare(
    `SELECT DISTINCT from_account_id AS id FROM movements
     WHERE account_id IS NULL AND from_account_id IS NOT NULL AND to_account_id = ?
       AND (currency = ? OR counter_currency = ?)`
  );
  const pending = [...scope.keys()];
  while (pending.length > 0) {
    const accountId = pending.pop()!;
    const currency = scope.get(accountId)!;
    for (const r of feeders.all(accountId, currency, currency) as { id: number }[]) {
      if (scope.has(r.id)) continue;
      const feederCurrency = foreignCashCurrencyOf(r.id);
      if (feederCurrency == null) continue;
      scope.set(r.id, feederCurrency);
      pending.push(r.id);
    }
  }
  return scope;
}

/** A market inflow's pesos: the stored mid of its currency on or before its day (the dollar's is the `fx_daily` close). */
function marketPesos(amount: number, currency: string, ymd: string, movementId: number): number {
  const clp = convertCurrency(amount, currency, "clp", ymd, { side: "mid", storedOnly: true });
  if (clp == null || !(clp >= 0)) {
    throw new Error(`movement ${movementId}: no ${currency.toUpperCase()}/CLP rate on or before ${ymd} to value it`);
  }
  return clp;
}

/** The tracer's prices: a purchase at its pesos, a conversion at the pesos it consumed, anything else at the stored rate of its day. */
export const tracerInflowPrice: ForeignWalkInput["priceInflow"] = ({ row, currency, minor, source, consumed }) => {
  if (source === "purchase") {
    const clp = Math.abs(movementLeg(row, "clp") ?? 0);
    if (!(clp > 0) || !(Math.abs(movementLeg(row, currency) ?? 0) > 0)) {
      throw new Error(`movement ${row.id}: a ${currency.toUpperCase()} purchase needs positive pesos and ${currency.toUpperCase()}`);
    }
    return clp;
  }
  if (source === "conversion") {
    if (!consumed) throw new Error(`movement ${row.id}: a conversion with no consumed lots`);
    return consumed.reduce((s, l) => s + l.clp, 0);
  }
  return marketPesos(fromMinor(minor, currency), currency, row.occurred_on, row.id);
};

function lotOut(slice: ForeignLotSlice, currency: string): ForeignOutflowLot {
  const amount = fromMinor(slice.minor, currency);
  return slice.carriedBy != null
    ? { source: "own_transfer", amount, clp: slice.clp, movement_id: slice.carriedBy }
    : { source: slice.source, amount, clp: slice.clp, movement_id: slice.acquireMovementId };
}

/**
 * Walks every foreign cash account in scope and returns the peso cost of each outflow from one of
 * them, by movement id (see the module doc). Empty when no card payment leaves a foreign cash
 * account in its own currency.
 */
export function foreignOutflowPesoCostByMovement(): Map<number, ForeignOutflowPesoCost> {
  const result = new Map<number, ForeignOutflowPesoCost>();
  const sources = foreignCardPaymentSources();
  if (sources.length === 0) return result;
  const walk = walkForeignCashLotsFromDb(scopeAccounts(sources), { priceInflow: tracerInflowPrice, feeCostToNet: true });
  for (const o of walk.outflows) {
    if (result.has(o.row.id)) throw new Error(`movement ${o.row.id}: money leaves two accounts in scope`);
    result.set(o.row.id, {
      currency: o.currency,
      amount: fromMinor(o.minor, o.currency),
      clp: o.slices.reduce((s, l) => s + l.clp, 0),
      lots: o.slices.map((s) => lotOut(s, o.currency)),
    });
  }
  return result;
}
