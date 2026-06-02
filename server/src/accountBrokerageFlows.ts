import { accountBucketKindSlug } from "./accountBucket.js";
import type { AccountRow } from "./movementUnitsPolicy.js";

const BROKERAGE_BUCKET_SLUGS = new Set(["brokerage_acciones", "brokerage_crypto"]);
const LEGACY_EQUITY_LEAF_KINDS = new Set(["spy", "vea", "oilk"]);

/** Brokerage share ledger (panel stocks, legacy SPY/VEA/OILK, or any account with `equity_ticker`). */
export function accountUsesBrokerageFlowKinds(account: AccountRow): boolean {
  if (account.equity_ticker?.trim()) return true;
  if (BROKERAGE_BUCKET_SLUGS.has(account.bucket_slug)) return true;
  return LEGACY_EQUITY_LEAF_KINDS.has(accountBucketKindSlug(account.bucket_slug));
}
