import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { sumClpThroughDate } from "./movementTransfer.js";

/**
 * Ledger (flows-based) CLP cash accounts: balance = Σ signed CLP movements/transfer legs
 * through a date (parity with USD cash in `usdCashAccounts.ts`, but CLP is the base
 * currency so there is no FX conversion). Asset-group leaf is `brokerage_cash__clp`
 * (bucket kind `clp`); no `valuations` snapshots are stored for these accounts.
 */
export function isClpCashKindSlug(kindSlug: string): boolean {
  return kindSlug === "clp";
}

export function isClpCashAccount(accountId: number): boolean {
  const slug = bucketSlugForAccountId(accountId);
  if (!slug) return false;
  return isClpCashKindSlug(accountBucketKindSlug(slug));
}

export function clpCashBalanceClpAt(accountId: number, asOfYmd: string): number {
  if (!isClpCashAccount(accountId)) {
    throw new Error(`account ${accountId} is not a CLP cash account`);
  }
  return sumClpThroughDate(accountId, asOfYmd);
}

export function clpCashBalanceLive(accountId: number): { value_clp: number; as_of_date: string } {
  const asOf = chileCalendarTodayYmd();
  return { value_clp: clpCashBalanceClpAt(accountId, asOf), as_of_date: asOf };
}
