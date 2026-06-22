import { describe, expect, it } from "vitest";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";

function countNavAccounts(node: NavTreeNodeDto): number {
  let n = node.account_id != null ? 1 : 0;
  for (const child of node.children) n += countNavAccounts(child);
  return n;
}

describe("getNetWorthNavGroupNode", () => {
  it("includes chart-inactive accounts when requested for panel tree", () => {
    const filtered = getNetWorthNavGroupNode();
    const full = getNetWorthNavGroupNode({ includeChartInactiveAccounts: true });
    if (!filtered || !full) return;

    expect(countNavAccounts(full)).toBeGreaterThanOrEqual(countNavAccounts(filtered));
  });
});
