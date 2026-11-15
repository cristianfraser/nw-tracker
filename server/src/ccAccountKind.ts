/** Whether an account is a credit card, by its kind (a leaf: `ccAccountConfig.ts` re-exports it). */
import { accountKindSlugForAccountId } from "./accountBucket.js";

export function isCreditCardAccountId(accountId: number): boolean {
  if (!Number.isFinite(accountId) || accountId <= 0) return false;
  return accountKindSlugForAccountId(accountId) === "credit_card";
}
