import { accountBucketKindSlug } from "./accountBucket.js";
import { isForeignCashKindSlug } from "./cashCurrency.js";

/** A cash ledger held in a foreign currency (a `usd` leaf, the generic `foreign_cash` leaf). */
export function accountUsesForeignCashFlowKinds(account: { bucket_slug: string }): boolean {
  return isForeignCashKindSlug(accountBucketKindSlug(account.bucket_slug));
}
