/**
 * Interest / bank-paid yield (`savings_earnings`) and account-charged commissions (`cash_fee`)
 * on ledger cash accounts (pesos and any foreign currency).
 *
 * Both move the account balance (see `signedNativeDeltaForAccountMovement` / signed CLP) but are the
 * account's own rentability — **not** personal capital. So the "deposited" line for these accounts
 * is `balance − net interest` where net interest = Σ interest − Σ fees, making P/L = interest −
 * fees (in the account's native currency; the CLP display converts at the same rate as the
 * balance, so no phantom FX shows up as capital). Amounts are summed as ABS with the sign carried
 * by the kind: foreign single-leg rows are stored positive by convention, and a CLP fee row is stored
 * negative for the balance walk — either way the fee reduces net interest here.
 */
import { foreignCashCurrencyOf, foreignCashToClpAt } from "./foreignCashAccounts.js";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { isClpCashAccount } from "./clpCashAccounts.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";

export const SAVINGS_EARNINGS_FLOW_KIND = "savings_earnings";
/** Commission charged to the cash balance (Racional portafolio comisión) — P/L cost, not capital. */
export const CASH_FEE_FLOW_KIND = "cash_fee";

/** Σ interest − Σ fees on `accountId` through `asOfYmd`, in `currency` (its legs in it). */
export function foreignCashInterestThroughDate(
  accountId: number,
  asOfYmd: string,
  currency: string,
  dbHandle: Database = db
): number {
  const leg = "(CASE WHEN currency = @c THEN amount WHEN counter_currency = @c THEN counter_amount END)";
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN flow_kind = '${SAVINGS_EARNINGS_FLOW_KIND}'
                                THEN ABS(${leg})
                                ELSE -ABS(${leg}) END), 0) AS s
       FROM movements
       WHERE account_id = @a
         AND flow_kind IN ('${SAVINGS_EARNINGS_FLOW_KIND}', '${CASH_FEE_FLOW_KIND}')
         AND ${leg} IS NOT NULL
         AND occurred_on <= @d`
    )
    .get({ a: accountId, c: currency, d: asOfYmd }) as { s: number };
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
  const foreign = foreignCashCurrencyOf(accountId);
  if (foreign != null) {
    const native = foreignCashInterestThroughDate(accountId, asOfYmd, foreign);
    if (native === 0) return 0;
    return foreignCashToClpAt(native, foreign, asOfYmd, `cashInterestClp:${accountId}`);
  }
  if (isClpCashAccount(accountId)) {
    return clpCashInterestClpThroughDate(accountId, asOfYmd);
  }
  return 0;
}

/** Cumulative interest through `asOfYmd` of a foreign cash account, in its own currency (0 for others). */
export function cashInterestNativeThroughDate(accountId: number, asOfYmd: string): number {
  const foreign = foreignCashCurrencyOf(accountId);
  return foreign != null ? foreignCashInterestThroughDate(accountId, asOfYmd, foreign) : 0;
}
