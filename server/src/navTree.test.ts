import { describe, expect, it } from "vitest";
import { accountChartInactive } from "./accountChartInactive.js";
import { db } from "./db.js";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";

function countNavAccounts(node: NavTreeNodeDto): number {
  let n = node.account_id != null ? 1 : 0;
  for (const child of node.children) n += countNavAccounts(child);
  return n;
}

function navTreeHasAccountId(node: NavTreeNodeDto, accountId: number): boolean {
  if (node.account_id === accountId) return true;
  return node.children.some((c) => navTreeHasAccountId(c, accountId));
}

describe("getNetWorthNavGroupNode", () => {
  it("includes chart-inactive accounts when requested for panel tree", () => {
    const filtered = getNetWorthNavGroupNode();
    const full = getNetWorthNavGroupNode({ includeChartInactiveAccounts: true });
    if (!filtered || !full) return;

    expect(countNavAccounts(full)).toBeGreaterThanOrEqual(countNavAccounts(filtered));
  });

  it("keeps USD cash in sidebar nav when chart-inactive", () => {
    const row = db
      .prepare(
        `SELECT a.id
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes LIKE '%kind=usd%'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row || !isUsdCashAccount(row.id) || !accountChartInactive(row.id)) return;

    const filtered = getNetWorthNavGroupNode();
    if (!filtered) return;
    expect(navTreeHasAccountId(filtered, row.id)).toBe(true);
  });
});
