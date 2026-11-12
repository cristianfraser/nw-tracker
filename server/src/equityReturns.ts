/**
 * Equity MTM returns: dividends are investment return, not capital.
 *
 * Cost basis = deposited capital. A cash payout (`dividend_payout` transfer, stock →
 * USD cash) reduces the deposited line as a negative capital flow; a reinvestment is a
 * separate `stock_buy` that nets it out (see `equityBrokerageCapitalFlows.ts`).
 * Total return = value − deposited.
 */

import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { usdToClpReferenceRounded } from "./fxRates.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  MOVEMENT_USD_LEG_SQL,
  movementUsdLeg,
  type MovementAmountFields,
} from "./movementAmounts.js";
import { flowAdjustedPct } from "./periodReturns.js";
import { flowEventInUnit, type DisplayUnitCode } from "./rates.js";

/** Every dividend received (`dividend_payout` transfers): its dollars and their reference pesos. */
function dividendEventsForAccount(accountId: number): { occurred_on: string; amt: number; amt_usd: number }[] {
  if (!Number.isFinite(accountId) || accountId <= 0 || !accountUsesEquityMtm(accountId)) return [];
  const rows = db
    .prepare(
      `SELECT occurred_on, ${MOVEMENT_AMOUNT_COLUMNS_SQL}
       FROM movements
       WHERE account_id IS NULL
         AND from_account_id = ?
         AND flow_kind = 'dividend_payout'
         AND ${MOVEMENT_USD_LEG_SQL} IS NOT NULL
         AND ${MOVEMENT_USD_LEG_SQL} != 0
       ORDER BY occurred_on, id`
    )
    .all(accountId) as ({ occurred_on: string } & MovementAmountFields)[];
  const out: { occurred_on: string; amt: number; amt_usd: number }[] = [];
  for (const r of rows) {
    const usd = Math.abs(movementUsdLeg(r) ?? 0);
    const clp = usdToClpReferenceRounded(usd, r.occurred_on);
    if (clp != null && Number.isFinite(clp)) out.push({ occurred_on: r.occurred_on, amt: clp, amt_usd: usd });
  }
  return out;
}

/** Σ reference CLP of all dividends received (`dividend_payout` transfers). Informational. */
export function totalDividendsClpForAccount(accountId: number): number {
  let sum = 0;
  for (const e of dividendEventsForAccount(accountId)) sum += e.amt;
  return sum;
}

/** Σ of the dividends received in `unit`, each at its own day's rate (its dollars in USD). */
export function totalDividendsInUnitForAccount(accountId: number, unit: DisplayUnitCode): number {
  let sum = 0;
  for (const e of dividendEventsForAccount(accountId)) sum += flowEventInUnit(e, unit);
  return sum;
}

export type EquityReturnSnapshot = {
  /** Total dividends received as payouts (already netted in `total_return`), in the unit. */
  dividends: number;
  total_return: number | null;
  return_on_deposited_pct: number | null;
};

/** An equity position's returns in `unit`; `deposited` and `value` are in `unit`. */
export function equityReturnSnapshot(
  accountId: number,
  deposited: number | null,
  value: number | null,
  unit: DisplayUnitCode
): EquityReturnSnapshot | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const total_return =
    value != null && Number.isFinite(value) && deposited != null ? value - deposited : null;
  // Lifetime return on the capital deposited — the shared rule's prior-less frame, so a
  // position sold off (bought and sold within its lifetime) reads null, not −100%.
  const return_on_deposited_pct =
    deposited == null ? null : flowAdjustedPct(total_return, null, deposited, value, unit);
  return {
    dividends: totalDividendsInUnitForAccount(accountId, unit),
    total_return,
    return_on_deposited_pct,
  };
}
