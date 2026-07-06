/**
 * Equity MTM returns: dividends are investment return, not capital.
 *
 * Cost basis = deposited capital. A reinvested dividend (`dividend_usd`, units on the
 * row) is a −dividend +reinvestment pair on one row → net-zero capital; a cash payout
 * (`dividend_payout`) reduces the deposited line as a negative capital flow
 * (see `equityBrokerageCapitalFlows.ts`). Total return = value − deposited.
 */

import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

/** Σ reference CLP of all dividends received (DRIP `dividend_usd` + cash `dividend_payout`). Informational. */
export function totalDividendsClpForAccount(accountId: number): number {
  if (!Number.isFinite(accountId) || accountId <= 0 || !accountUsesEquityMtm(accountId)) return 0;
  const rows = db
    .prepare(
      `SELECT occurred_on, amount_usd
       FROM movements
       WHERE ((account_id = ? AND flow_kind = 'dividend_usd')
           OR (account_id IS NULL AND from_account_id = ? AND flow_kind = 'dividend_payout'))
         AND amount_usd IS NOT NULL
         AND amount_usd != 0
       ORDER BY occurred_on, id`
    )
    .all(accountId, accountId) as { occurred_on: string; amount_usd: number }[];
  let sum = 0;
  for (const r of rows) {
    const clp = usdToClpReferenceRounded(Math.abs(r.amount_usd), r.occurred_on);
    if (clp != null && Number.isFinite(clp)) sum += clp;
  }
  return sum;
}

export type EquityReturnSnapshot = {
  /** Total dividends received, DRIP + payouts (already netted in `total_return_clp`). */
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
