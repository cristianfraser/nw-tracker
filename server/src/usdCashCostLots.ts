/**
 * What the dollars leaving a USD cash account cost in pesos, traced through the client's own
 * dollar accounts — so a card's dollar debt paid in DOLLARS (a `pago_tarjeta` transfer from a USD
 * cash account, `currency = 'usd'`, no counter leg) counts at the pesos those dollars were bought
 * with, not at the day's rate.
 *
 * The walk is `usdCashLotWalk.ts` (FIFO queues per account, Chile-date order with the stated
 * times, request-time reservations, own transfers carrying slices). This module sets its scope
 * and its prices:
 * - scope: the USD cash accounts a dollar card payment leaves from, plus, recursively, every USD
 *   cash account that transferred dollars into one in scope;
 * - a `purchase` (a transfer in with a CLP leg and a USD counter leg) is priced at its pesos; a
 *   `market` inflow (dividends, sales, interest, plain deposits) at the stored USD/CLP close on or
 *   before its date (`fxRowOnOrBefore`, the reference rate the USD-cash capital flows use for
 *   dollars with no pesos of their own; a missing rate throws).
 *
 * Each outflow lists the slices it consumed as lots: a slice still on the account that acquired
 * it is a `purchase` / `market` lot naming the acquisition; a slice that came through an own
 * transfer is an `own_transfer` lot naming the transfer (one lot per carried slice, so a partial
 * spend of a batch that spans two purchase rates is priced at the older rate first).
 */
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { movementClpLegOrZero, movementUsdLeg } from "./movementAmounts.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { walkUsdCashLotsFromDb, type UsdLotSlice, type UsdWalkInput } from "./usdCashLotWalk.js";

export type UsdLotSource = "purchase" | "own_transfer" | "market";

export type UsdOutflowLot = { source: UsdLotSource; usd: number; clp: number; movement_id: number };

export type UsdOutflowPesoCost = { usd: number; clp: number; lots: UsdOutflowLot[] };

/** The USD cash accounts a dollar card payment leaves from (`pago_tarjeta`, USD, no counter leg). */
function dollarCardPaymentSources(): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT from_account_id AS id FROM movements
       WHERE flow_kind = 'pago_tarjeta' AND account_id IS NULL AND from_account_id IS NOT NULL
         AND currency = 'usd' AND counter_currency IS NULL`
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id).filter((id) => isUsdCashAccount(id));
}

/** The sources plus every USD cash account that sent dollars into one already in scope. */
function scopeAccounts(sources: readonly number[]): Set<number> {
  const scope = new Set(sources);
  const feeders = db.prepare(
    `SELECT DISTINCT from_account_id AS id FROM movements
     WHERE account_id IS NULL AND from_account_id IS NOT NULL AND to_account_id = ?
       AND (currency = 'usd' OR counter_currency = 'usd')`
  );
  const pending = [...sources];
  while (pending.length > 0) {
    const accountId = pending.pop()!;
    for (const r of feeders.all(accountId) as { id: number }[]) {
      if (scope.has(r.id) || !isUsdCashAccount(r.id)) continue;
      scope.add(r.id);
      pending.push(r.id);
    }
  }
  return scope;
}

/** The tracer's prices: a purchase at its pesos, anything else at the stored rate of its day. */
export const tracerInflowPrice: UsdWalkInput["priceInflow"] = ({ row, cents, source }) => {
  if (source === "purchase") {
    const clp = Math.abs(movementClpLegOrZero(row));
    if (!(clp > 0) || !(Math.abs(movementUsdLeg(row) ?? 0) > 0)) {
      throw new Error(`movement ${row.id}: a dollar purchase needs positive pesos and dollars`);
    }
    return clp;
  }
  const fx = fxRowOnOrBefore(row.occurred_on);
  if (!fx || !(fx.clp_per_usd > 0)) {
    throw new Error(`movement ${row.id}: no USD/CLP rate on or before ${row.occurred_on} to value its dollars`);
  }
  return (cents / 100) * fx.clp_per_usd;
};

function lotOut(slice: UsdLotSlice): UsdOutflowLot {
  return slice.carriedBy != null
    ? { source: "own_transfer", usd: slice.cents / 100, clp: slice.clp, movement_id: slice.carriedBy }
    : { source: slice.source, usd: slice.cents / 100, clp: slice.clp, movement_id: slice.acquireMovementId };
}

/**
 * Walks every USD cash account in scope and returns the peso cost of each dollar outflow from one
 * of them, by movement id (see the module doc). Empty when no dollar card payment exists.
 */
export function usdOutflowPesoCostByMovement(): Map<number, UsdOutflowPesoCost> {
  const result = new Map<number, UsdOutflowPesoCost>();
  const sources = dollarCardPaymentSources();
  if (sources.length === 0) return result;
  const walk = walkUsdCashLotsFromDb(scopeAccounts(sources), { priceInflow: tracerInflowPrice, feeCostToNet: true });
  for (const o of walk.outflows) {
    if (result.has(o.row.id)) throw new Error(`movement ${o.row.id}: dollars leave two accounts in scope`);
    result.set(o.row.id, { usd: o.cents / 100, clp: o.slices.reduce((s, l) => s + l.clp, 0), lots: o.slices.map(lotOut) });
  }
  return result;
}
