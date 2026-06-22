import { accountBucketKindSlug } from "./accountBucket.js";
import type { AccountRow } from "./movementUnitsPolicy.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";

/** USD-denominated cash account under cash_savings (`kind_slug` = `usd`). */
export function accountUsesUsdCashFlowKinds(account: AccountRow): boolean {
  return isUsdCashKindSlug(accountBucketKindSlug(account.bucket_slug));
}
