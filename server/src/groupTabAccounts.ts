import { resolveOperationalAccountId } from "./accountSource.js";

/** Pasivos liability_view leaves: valuations/CC ledger live on `source_account_id`. */
export function seriesAccountIdForGroupTab(
  row: { account_id: number },
  groupSlug: string
): number {
  if (groupSlug === "liabilities") {
    return resolveOperationalAccountId(row.account_id);
  }
  return row.account_id;
}
