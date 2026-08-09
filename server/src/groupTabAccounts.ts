import { getCreditCardGroupBySlug } from "./creditCardTree.js";

/** Pasivos liability leaves resolve to master account ids. */
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
    return row.account_id;
  }
  return row.account_id;
}
