import { accountBucketKindSlug } from "./accountBucket.js";
import type { AccountRow } from "./movementUnitsPolicy.js";
import { isClpCashKindSlug } from "./clpCashAccounts.js";

/** CLP-denominated ledger cash account (`kind_slug` = `clp`). Parity with USD cash, base currency. */
export function accountUsesClpCashFlowKinds(account: AccountRow): boolean {
  return isClpCashKindSlug(accountBucketKindSlug(account.bucket_slug));
}
