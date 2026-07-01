/**
 * Interest / bank-paid yield (`savings_earnings`) on ledger cash accounts (USD and CLP).
 *
 * It raises the account balance (see `signedUsdDeltaForAccountMovement` / signed CLP), but is the
 * account's own rentability — **not** personal capital. So the "deposited" line for these accounts
 * is `balance − cumulative interest`, making P/L = interest (in the account's native currency; the
 * CLP display converts at the same rate as the balance, so no phantom FX shows up as capital).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { isClpCashAccount } from "./clpCashAccounts.js";
import { isUsdCashAccount, usdCashUsdToClpAt } from "./usdCashAccounts.js";

export const SAVINGS_EARNINGS_FLOW_KIND = "savings_earnings";

/** Σ interest `amount_usd` credited to a USD cash account through `asOfYmd`. */
export function usdCashInterestUsdThroughDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_usd)), 0) AS s
       FROM movements
       WHERE account_id = ?
         AND flow_kind = '${SAVINGS_EARNINGS_FLOW_KIND}'
         AND amount_usd IS NOT NULL
         AND occurred_on <= ?`
    )
    .get(accountId, asOfYmd) as { s: number };
  return row.s;
}

/** Σ interest `amount_clp` credited to a CLP cash account through `asOfYmd`. */
export function clpCashInterestClpThroughDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_clp)), 0) AS s
       FROM movements
       WHERE account_id = ?
         AND flow_kind = '${SAVINGS_EARNINGS_FLOW_KIND}'
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
