import { resolveOperationalAccountId } from "./accountSource.js";
import { getCreditCardGroupBySlug } from "./creditCardTree.js";

/** Pasivos liability leaves: CC uses master id; mortgage may still use liability_view. */
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
