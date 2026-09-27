import { describe, expect, it } from "vitest";
import { roundedMetricDelta } from "../dashboardCardBreakdown";
import { mainValueForNavChild, requireNavCardMetrics } from "../portfolioNavDashboardCards";
import { dashPickForNavStrip } from "../queries/fetchers";
import type { DashboardAccountRow, DashboardNavSnapshotResponse, NavTreeNodeDto } from "../types";
import { perturbDashboardNavSnapshot } from "./perturbCachedAmount";

const retirementChild: NavTreeNodeDto = {
  node_id: "ret",
  slug: "retirement",
  label: "Retiro",
  label_i18n_key: null,
  route_path: "/group/retirement",
  active_prefix: "/group/retirement",
  nav_end: false,
  show_leaf_hyphen: false,
  account_id: null,
  portfolio_group_id: 1,
  expense_account_id: null,
  expense_account_slug: null,
  asset_group_slug: "retirement",
  kind_slug: null,
  dashboard_bucket_slug: "retirement",
  api_group: "retirement",
  api_subgroup: null,
  color_rgb: null,
  color: null,
  group_kind: "bucket",
  children: [
    {
      node_id: "acc-1",
      slug: "acc-1",
      label: "APV",
      label_i18n_key: null,
      route_path: "/account/1",
      active_prefix: null,
      nav_end: true,
      show_leaf_hyphen: false,
      account_id: 1,
      portfolio_group_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: "retirement",
      kind_slug: "apv",
      dashboard_bucket_slug: "retirement",
      api_group: null,
      api_subgroup: null,
      color_rgb: null,
      color: null,
      group_kind: "bucket",
      children: [],
    },
  ],
};

function row(p: Partial<DashboardAccountRow>): DashboardAccountRow {
  return {
    account_id: 1,
    name: "APV",
    group_slug: "retirement",
    group_label: "Retiro",
    category_slug: "apv",
    category_label: "apv",
    deposits_clp: 0,
    delta_month_clp: -594_703,
    delta_year_clp: -594_703,
    delta_total_clp: 49_710_689,
    prior_month_close_clp: 35_490_000,
    prior_year_close_clp: 30_000_000,
    current_value_clp: 36_076_883,
    deposits_month_clp: 0,
    valuation_as_of: null,
    ...p,
  } as DashboardAccountRow;
}

describe("loading PL placeholder repro", () => {
  it("period PL stays near the cached delta_month, not the full balance", () => {
    const periodMetrics = {
      deposits_clp: 0,
      deposits_usd: null,
      delta_total_clp: 49_710_689,
      delta_total_usd: null,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: -594_703,
      delta_period_usd: null,
    };
    const variant = {
      day: periodMetrics,
      month: periodMetrics,
      year: periodMetrics,
    };
    const buckets = {
      net_worth_clp: 36_076_883,
      real_estate_clp: 0,
      retirement_clp: 36_076_883,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
    };
    const raw: DashboardNavSnapshotResponse = {
      accounts: [row({})],
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        ...buckets,
        prior_closes: {
          month_end: "2026-05-31",
          year_end: "2025-12-31",
          month: { ...buckets, net_worth_clp: 35_490_000, retirement_clp: 35_490_000 },
          year: { ...buckets, net_worth_clp: 30_000_000, retirement_clp: 30_000_000 },
        },
      },
      card_metrics_by_slug: { retirement: { child: variant, parent: variant } },
    };
    const perturbed = perturbDashboardNavSnapshot(raw);
    const dash = dashPickForNavStrip({ ...perturbed, overviewPoints: [] });
    const { clp } = mainValueForNavChild(dash, retirementChild, false);
    const metrics = requireNavCardMetrics(dash, retirementChild).child.month;
    const periodPl = roundedMetricDelta(metrics, false, "period");
    const cachedDelta = perturbed.accounts[0]!.delta_month_clp!;

    expect(Math.abs(periodPl!)).toBeLessThan(clp * 0.1);
    expect(Math.abs(periodPl! - cachedDelta)).toBeLessThan(Math.abs(cachedDelta) * 0.5);
  });
});
