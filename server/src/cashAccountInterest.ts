/**
 * Interest / bank-paid yield (`savings_earnings`) and account-charged commissions (`cash_fee`)
 * on ledger cash accounts (USD and CLP).
 *
 * Both move the account balance (see `signedUsdDeltaForAccountMovement` / signed CLP) but are the
 * account's own rentability — **not** personal capital. So the "deposited" line for these accounts
 * is `balance − net interest` where net interest = Σ interest − Σ fees, making P/L = interest −
 * fees (in the account's native currency; the CLP display converts at the same rate as the
 * balance, so no phantom FX shows up as capital). Amounts are summed as ABS with the sign carried
 * by the kind: USD single-leg rows are stored positive by convention, and a CLP fee row is stored
 * negative for the balance walk — either way the fee reduces net interest here.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { isClpCashAccount } from "./clpCashAccounts.js";
import { MOVEMENT_CLP_LEG_SQL, MOVEMENT_USD_LEG_SQL } from "./movementAmounts.js";
import { isUsdCashAccount, usdCashUsdToClpAt } from "./usdCashAccounts.js";

export const SAVINGS_EARNINGS_FLOW_KIND = "savings_earnings";
/** Commission charged to the cash balance (Racional portafolio comisión) — P/L cost, not capital. */
export const CASH_FEE_FLOW_KIND = "cash_fee";

/** Σ interest − Σ fees, USD, on a USD cash account through `asOfYmd`. */
export function usdCashInterestUsdThroughDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN flow_kind = '${SAVINGS_EARNINGS_FLOW_KIND}'
                                THEN ABS(${MOVEMENT_USD_LEG_SQL})
                                ELSE -ABS(${MOVEMENT_USD_LEG_SQL}) END), 0) AS s
       FROM movements
       WHERE account_id = ?
         AND flow_kind IN ('${SAVINGS_EARNINGS_FLOW_KIND}', '${CASH_FEE_FLOW_KIND}')
         AND ${MOVEMENT_USD_LEG_SQL} IS NOT NULL
         AND occurred_on <= ?`
    )
    .get(accountId, asOfYmd) as { s: number };
  return row.s;
}

/** Σ interest − Σ fees, CLP, on a CLP cash account through `asOfYmd`. */
export function clpCashInterestClpThroughDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN flow_kind = '${SAVINGS_EARNINGS_FLOW_KIND}'
                                THEN ABS(${MOVEMENT_CLP_LEG_SQL})
                                ELSE -ABS(${MOVEMENT_CLP_LEG_SQL}) END), 0) AS s
       FROM movements
       WHERE account_id = ?
         AND flow_kind IN ('${SAVINGS_EARNINGS_FLOW_KIND}', '${CASH_FEE_FLOW_KIND}')
         AND occurred_on <= ?`
    )
    .get(accountId, asOfYmd) as { s: number };
  return row.s;
}

/** Cumulative interest through `asOfYmd` in CLP for any ledger cash account (0 for others). */
export function cashInterestClpThroughDate(accountId: number, asOfYmd: string): number {
  if (isUsdCashAccount(accountId)) {
    const usd = usdCashInterestUsdThroughDate(accountId, asOfYmd);
    if (usd === 0) return 0;
    return usdCashUsdToClpAt(usd, asOfYmd, `cashInterestClp:${accountId}`);
  }
  if (isClpCashAccount(accountId)) {
    return clpCashInterestClpThroughDate(accountId, asOfYmd);
  }
  return 0;
}

/** Cumulative interest through `asOfYmd` in USD for a USD cash account (0 for others). */
export function cashInterestUsdThroughDate(accountId: number, asOfYmd: string): number {
  if (isUsdCashAccount(accountId)) return usdCashInterestUsdThroughDate(accountId, asOfYmd);
  return 0;
}
