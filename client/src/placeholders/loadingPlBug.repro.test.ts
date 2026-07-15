import { describe, expect, it } from "vitest";
import { roundedMetricDelta } from "../dashboardCardBreakdown";
import {
  mainValueAndMetricsForNavChild,
  titleBalanceDeltaForNavChild,
} from "../portfolioNavDashboardCards";
import { dashPickForNavStrip } from "../queries/fetchers";
import type { CachedDashboardNavSnapshot, DashboardAccountRow, NavTreeNodeDto } from "../types";
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
  source_account_id: null,
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
      source_account_id: null,
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

const netWorthRoot: NavTreeNodeDto = {
  node_id: "nw",
  slug: "net_worth",
  label: "Patrimonio",
  label_i18n_key: null,
  route_path: "/",
  active_prefix: "/",
  nav_end: false,
  show_leaf_hyphen: false,
  account_id: null,
  portfolio_group_id: null,
  source_account_id: null,
  expense_account_id: null,
  expense_account_slug: null,
  asset_group_slug: "net_worth",
  kind_slug: null,
  dashboard_bucket_slug: "net_worth",
  api_group: null,
  api_subgroup: null,
  color_rgb: null,
  color: null,
  group_kind: "bucket",
  children: [retirementChild],
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
  it("without nw_bucket_totals period PL stays near cached delta_month not full balance", () => {
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
      month: periodMetrics,
      year: periodMetrics,
      title_delta: { month_clp: null, month_usd: null, year_clp: null, year_usd: null },
    };
    const raw: CachedDashboardNavSnapshot = {
      accounts: [row({})],
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      card_metrics_by_slug: { retirement: { child: variant, parent: variant } },
    };
    const perturbed = perturbDashboardNavSnapshot(raw);
    const dash = dashPickForNavStrip({ ...perturbed, overviewPoints: [] }, netWorthRoot);
    const { clp, metrics } = mainValueAndMetricsForNavChild(dash, retirementChild, "month", false);
    const periodPl = roundedMetricDelta(metrics, false, "period");
    titleBalanceDeltaForNavChild(dash, retirementChild, "month", false);
    const cachedDelta = perturbed.accounts[0]!.delta_month_clp!;

    expect(dash.totals.prior_closes.month_end).toBe("");
    expect(Math.abs(periodPl!)).toBeLessThan(clp * 0.1);
    expect(Math.abs(periodPl! - cachedDelta)).toBeLessThan(Math.abs(cachedDelta) * 0.5);
  });
});
