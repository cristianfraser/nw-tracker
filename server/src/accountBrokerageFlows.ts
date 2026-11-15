import type { AccountRow } from "./movementAccountRow.js";

const BROKERAGE_BUCKET_SLUGS = new Set(["brokerage_acciones", "brokerage_crypto"]);

/** Brokerage share ledger: an account with an `equity_ticker`, or one placed on a brokerage bucket itself. */
export function accountUsesBrokerageFlowKinds(account: AccountRow): boolean {
  if (account.equity_ticker?.trim()) return true;
  return BROKERAGE_BUCKET_SLUGS.has(account.bucket_slug);
}

