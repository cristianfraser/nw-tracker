import { describe, expect, it } from "vitest";
import {
  accountInDashboardGroupDisplayScope,
  accountInDashboardGroupScope,
  cardGroupMetricsFromAccounts,
  cardMainBalanceFromMetrics,
  roundedMetricDelta,
  roundedMetricDeposits,
} from "./dashboardCardBreakdown";
import type { DashboardAccountRow } from "./types";

function baseRow(overrides: Partial<DashboardAccountRow> & Pick<DashboardAccountRow, "account_id">): DashboardAccountRow {
  return {
    name: "Test",
    group_slug: "retirement",
    group_label: "Retiro",
    category_slug: "apv",
    category_label: "APV",
    deposits_clp: 0,
    deposits_month_clp: 0,
    deposits_year_clp: 0,
    current_value_clp: 0,
    valuation_as_of: null,
    ...overrides,
  };
}

describe("roundedMetricDelta USD cents", () => {
  const metrics = {
    deposits_clp: 0,
    delta_total_clp: null,
    deposits_period_clp: 0,
    delta_period_clp: null,
    delta_total_usd: 4.567,
    delta_period_usd: -54.327,
  };

  it("USD always keeps cents; CLP stays whole", () => {
    expect(roundedMetricDelta(metrics, true, "total")).toBe(4.57);
    expect(roundedMetricDelta(metrics, true, "period")).toBe(-54.33);
    expect(roundedMetricDelta({ ...metrics, delta_total_usd: 772.444 }, true, "total")).toBe(772.44);
    expect(roundedMetricDelta({ ...metrics, delta_total_usd: 4478.409 }, true, "total")).toBe(4478.41);
    expect(roundedMetricDelta({ ...metrics, delta_total_clp: 772.4 }, false, "total")).toBe(772);
  });
});

describe("dashboard card accounting identity", () => {
  it("sold-out account deposits count in metrics while live balance sums as 0", () => {
    const withBalance = baseRow({
      account_id: 1,
      deposits_clp: 10_000,
      delta_total_clp: 5_000,
      current_value_clp: 15_000,
    });
    const soldOut = baseRow({
      account_id: 2,
      deposits_clp: 1_000_000,
      delta_total_clp: 968_035,
      current_value_clp: null,
    });
    const metrics = cardGroupMetricsFromAccounts([withBalance, soldOut], "month");
    expect(roundedMetricDeposits(metrics, false, "total")).toBe(1_010_000);
    expect(cardMainBalanceFromMetrics(metrics, false)).toBe(1_983_035);
  });

});

describe("accountInDashboardGroupScope", () => {
  it("includes sold-out account in metrics scope; display scope hides it", () => {
    const soldOut = baseRow({
      account_id: 60,
      group_slug: "brokerage_acciones__oilk",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: null,
      delta_month_clp: -241_251,
      delta_year_clp: -267_541,
      deposits_clp: 500_000,
      deposits_month_clp: -2_719_944,
      delta_total_clp: -267_541,
    });
    const open = baseRow({
      account_id: 85,
      group_slug: "brokerage_acciones__spy",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: 689_768,
      delta_month_clp: -1_586,
    });

    expect(accountInDashboardGroupScope(soldOut, "brokerage")).toBe(true);
    expect(accountInDashboardGroupDisplayScope(soldOut, "brokerage")).toBe(false);

    const zeroBalance = baseRow({
      account_id: 61,
      group_slug: "brokerage_acciones__oilk",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: 0,
    });
    expect(accountInDashboardGroupDisplayScope(zeroBalance, "brokerage")).toBe(false);

    const metrics = cardGroupMetricsFromAccounts(
      [soldOut, open].filter((a) => accountInDashboardGroupScope(a, "brokerage")),
      "month"
    );
    expect(roundedMetricDelta(metrics, false, "period")).toBe(-242_837);
    expect(roundedMetricDeposits(metrics, false, "period")).toBe(-2_719_944);
    expect(roundedMetricDeposits(metrics, false, "total")).toBe(500_000);
  });

  it("nets stock_sell outflows from sold-out accounts against open-position buys", () => {
    const soldOut = baseRow({
      account_id: 60,
      group_slug: "brokerage_acciones__oilk",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: null,
      deposits_month_clp: -2_719_944,
      delta_month_clp: -241_251,
    });
    const ccj = baseRow({
      account_id: 92,
      group_slug: "brokerage_acciones__ccj",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: 2_723_617,
      deposits_month_clp: 2_719_944,
      delta_month_clp: 3_673,
    });
    const linde = baseRow({
      account_id: 91,
      group_slug: "brokerage_acciones__linde",
      dashboard_bucket_slug: "brokerage",
      current_value_clp: 1_175_645,
      deposits_month_clp: 1_192_782,
      delta_month_clp: -17_138,
    });

    const metrics = cardGroupMetricsFromAccounts(
      [soldOut, ccj, linde].filter((a) => accountInDashboardGroupScope(a, "brokerage")),
      "month"
    );
    expect(roundedMetricDeposits(metrics, false, "period")).toBe(1_192_782);
  });
});
