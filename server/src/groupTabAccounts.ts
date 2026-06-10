import { resolveOperationalAccountId } from "./accountSource.js";
import { getCreditCardGroupBySlug } from "./creditCardTree.js";

/** Pasivos liability_view leaves: valuations/CC ledger live on `source_account_id`. */
export function seriesAccountIdForGroupTab(
  row: { account_id: number },
  groupSlug: string
): number {
  if (
    groupSlug === "liabilities" ||
    groupSlug === "liabilities_credit_card" ||
    groupSlug === "liabilities_mortgage" ||
    getCreditCardGroupBySlug(groupSlug)
  ) {
    return resolveOperationalAccountId(row.account_id);
  }
  return row.account_id;
}
