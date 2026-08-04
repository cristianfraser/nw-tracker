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

/** Σ reference CLP of all dividends received (`dividend_payout` transfers). Informational. */
export function totalDividendsClpForAccount(accountId: number): number {
  if (!Number.isFinite(accountId) || accountId <= 0 || !accountUsesEquityMtm(accountId)) return 0;
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
  let sum = 0;
  for (const r of rows) {
    const clp = usdToClpReferenceRounded(Math.abs(movementUsdLeg(r) ?? 0), r.occurred_on);
    if (clp != null && Number.isFinite(clp)) sum += clp;
  }
  return sum;
}

export type EquityReturnSnapshot = {
  /** Total dividends received as payouts (already netted in `total_return_clp`). */
  dividends_clp: number;
  total_return_clp: number | null;
  return_on_deposited_pct: number | null;
};

export function equityReturnSnapshot(
  accountId: number,
  depositedClp: number,
  valueClp: number | null
): EquityReturnSnapshot | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const total_return_clp =
    valueClp != null && Number.isFinite(valueClp) ? valueClp - depositedClp : null;
  const return_on_deposited_pct =
    total_return_clp != null &&
    depositedClp > 0 &&
    Number.isFinite(total_return_clp / depositedClp)
      ? total_return_clp / depositedClp
      : null;
  return {
    dividends_clp: totalDividendsClpForAccount(accountId),
    total_return_clp,
    return_on_deposited_pct,
  };
}
