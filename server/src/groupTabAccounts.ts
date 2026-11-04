/** Pasivos liability leaves resolve to master account ids. */
export function seriesAccountIdForGroupTab(
  row: { account_id: number },
  groupSlug: string
): number {
  if (
    groupSlug === "liabilities" ||
    groupSlug === "liabilities_credit_card" ||
    groupSlug === "liabilities_mortgage"
  ) {
    return row.account_id;
  }
  return row.account_id;
}
