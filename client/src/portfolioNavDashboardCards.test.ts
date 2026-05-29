import { describe, expect, it } from "vitest";
import {
  mainValueAndMetricsForNavChild,
  navLeafAccountIdSet,
  titleDeltaModelForNavChild,
} from "./portfolioNavDashboardCards";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

function leafAccount(id: number): NavTreeNodeDto {
  return {
    slug: `acc-${id}`,
    label: `Account ${id}`,
    route_path: `/accounts/${id}`,
    account_id: id,
    children: [],
  };
}

describe("navLeafAccountIdSet", () => {
  it("includes leaf account ids and excludes group-only nodes", () => {
    const node: NavTreeNodeDto = {
      slug: "retirement",
      label: "Retiro",
      route_path: "/retirement",
      children: [leafAccount(1), leafAccount(2)],
    };
    const ids = navLeafAccountIdSet(node);
    expect(ids.has(1)).toBe(true);
    expect(ids.has(2)).toBe(true);
    expect(ids.size).toBe(2);
  });
});

function dashRow(id: number, clp: number, groupSlug: string): DashboardAccountRow {
  return {
    account_id: id,
    name: `Account ${id}`,
    category_slug: "mutual_fund",
    category_label: "Fund",
    group_slug: groupSlug,
    group_label: groupSlug,
    current_value_clp: clp,
    current_value_usd: null,
    deposits_clp: 0,
    exclude_from_group_totals: 0,
  } as DashboardAccountRow;
}

describe("titleDeltaModelForNavChild", () => {
  it("uses dashboard bucket mode only for top-level bucket nodes", () => {
    expect(
      titleDeltaModelForNavChild({
        slug: "brokerage",
        label: "Brokerage",
        asset_group_slug: "brokerage",
        children: [],
      }).mode
    ).toBe("dashboard_group");
    expect(
      titleDeltaModelForNavChild({
        slug: "brokerage_mutual_funds",
        label: "Mutual funds",
        api_group: "brokerage",
        api_subgroup: "mutual_funds",
        children: [leafAccount(10)],
      }).mode
    ).toBe("subset");
    expect(
      titleDeltaModelForNavChild({
        slug: "retirement_afp_afc",
        label: "AFP",
        api_group: "retirement",
        children: [leafAccount(20)],
      }).mode
    ).toBe("subset");
  });
});

describe("mainValueAndMetricsForNavChild", () => {
  it("sums subtree accounts for brokerage subgroups, not the whole bucket", () => {
    const mutualFundsNode: NavTreeNodeDto = {
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      children: [leafAccount(1)],
    };
    const dash: Pick<DashboardResponse, "accounts" | "totals"> = {
      accounts: [dashRow(1, 10_000_000, "brokerage_mutual_funds"), dashRow(2, 5_000_000, "brokerage_crypto")],
      totals: {
        net_worth_clp: 15_000_000,
        deposits_clp: 0,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 15_000_000,
        cash_eqs_clp: 0,
        liabilities_clp: 0,
      },
    };
    const { clp } = mainValueAndMetricsForNavChild(dash, mutualFundsNode, "month", false);
    expect(clp).toBe(10_000_000);
  });
});

