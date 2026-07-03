import { describe, expect, it } from "vitest";
import { accountChartInactive } from "./accountChartInactive.js";
import { db } from "./db.js";
import { getNetWorthNavGroupNode, navGroupChartInactive, type NavTreeNodeDto } from "./navTree.js";
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

function navChildStub(overrides: Partial<NavTreeNodeDto>): NavTreeNodeDto {
  return {
    node_id: "stub",
    slug: "stub",
    label: "Stub",
    label_i18n_key: null,
    route_path: "/stub",
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: true,
    account_id: null,
    source_account_id: null,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    group_kind: "bucket",
    children: [],
    ...overrides,
  };
}

describe("navGroupChartInactive", () => {
  const activeAccount = navChildStub({ account_id: 7 });
  const inactiveGroup = navChildStub({ portfolio_group_id: 3, chart_inactive: true });
  const activeGroup = navChildStub({ portfolio_group_id: 4 });

  it("marks asset buckets with no active children (empty or all-inactive)", () => {
    expect(navGroupChartInactive("bucket", "mutual_funds", [])).toBe(true);
    expect(navGroupChartInactive("bucket", "mutual_funds", [inactiveGroup])).toBe(true);
    expect(navGroupChartInactive("bucket", "mutual_funds", [activeAccount])).toBe(false);
    expect(navGroupChartInactive("bucket", "brokerage", [inactiveGroup, activeGroup])).toBe(false);
  });

  it("keeps non-asset buckets (no kind_slug: flows/rates/links) visible when empty", () => {
    expect(navGroupChartInactive("bucket", null, [])).toBe(false);
  });

  it("collapses nav_bucket hubs only when all children are inactive", () => {
    expect(navGroupChartInactive("nav_bucket", null, [])).toBe(false);
    expect(navGroupChartInactive("nav_bucket", null, [inactiveGroup])).toBe(true);
    expect(navGroupChartInactive("nav_bucket", null, [inactiveGroup, activeGroup])).toBe(false);
  });

  it("never marks reference or liability groups", () => {
    expect(navGroupChartInactive("reference", "x", [])).toBe(false);
    expect(navGroupChartInactive("liability_group", "liabilities", [])).toBe(false);
  });
});

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
