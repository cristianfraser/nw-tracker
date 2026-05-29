import { describe, expect, it } from "vitest";
import {
  cardGroupMetricsForGroup,
  cardGroupMetricsFromAccounts,
  cardMainBalanceFromMetrics,
  cardMetricsMainBalanceDiff,
  cardPeriodChangeFromMetrics,
  cardGroupTitleBalanceDelta,
  subsetTitleBalanceDeltaRounded,
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

describe("dashboard card accounting identity", () => {
  it("unfiltered metrics over-count when an account has deposits but no live balance", () => {
    const withBalance = baseRow({
      account_id: 1,
      deposits_clp: 10_000,
      delta_total_clp: 5_000,
      current_value_clp: 15_000,
    });
    const noBalance = baseRow({
      account_id: 2,
      deposits_clp: 1_000_000,
      delta_total_clp: 968_035,
      current_value_clp: null,
    });
    const loose = cardGroupMetricsFromAccounts([withBalance, noBalance], "month");
    const mainClp = 15_000;
    expect(cardMetricsMainBalanceDiff(loose, mainClp, false)).toBe(-1_968_035);

    const strict = cardGroupMetricsFromAccounts([withBalance], "month");
    expect(cardMetricsMainBalanceDiff(strict, mainClp, false)).toBe(0);
  });

  it("cardGroupMetricsForGroup matches sum of current when rows are reconciled", () => {
    const accounts = [
      baseRow({
        account_id: 10,
        deposits_clp: 45_000_000,
        delta_total_clp: 48_000_000,
        current_value_clp: 93_000_000,
        prior_month_close_clp: 90_000_000,
        deposits_month_clp: 500_000,
        delta_month_clp: 2_500_000,
      }),
      baseRow({
        account_id: 11,
        deposits_clp: 138_555,
        delta_total_clp: 2_465_197,
        current_value_clp: 2_603_752,
        prior_month_close_clp: 2_550_000,
        deposits_month_clp: 10_000,
        delta_month_clp: 43_752,
      }),
    ];
    const metrics = cardGroupMetricsForGroup(accounts, "retirement", "month");
    const mainClp = 93_000_000 + 2_603_752;
    expect(cardMainBalanceFromMetrics(metrics, false)).toBe(mainClp);
    expect(cardMetricsMainBalanceDiff(metrics, mainClp, false)).toBe(0);
  });

  it("period deposits + period delta matches title balance delta when period deltas are reconciled", () => {
    const accounts = [
      baseRow({
        account_id: 20,
        deposits_clp: 1_000_000,
        delta_total_clp: 200_000,
        current_value_clp: 1_200_000,
        prior_month_close_clp: 1_100_000,
        deposits_month_clp: 50_000,
        delta_month_clp: 50_000,
      }),
      baseRow({
        account_id: 21,
        deposits_clp: 500_000,
        delta_total_clp: 100_000,
        current_value_clp: 600_000,
        prior_month_close_clp: 580_000,
        deposits_month_clp: 20_000,
        delta_month_clp: 0,
      }),
    ];
    const metrics = cardGroupMetricsForGroup(accounts, "retirement", "month");
    const titleDelta = cardGroupTitleBalanceDelta(
      accounts,
      {
        net_worth_clp: 0,
        real_estate_clp: 0,
        retirement_clp: 1_800_000,
        brokerage_clp: 0,
        cash_eqs_clp: 0,
      },
      [],
      "retirement",
      "month",
      false
    );
    expect(cardPeriodChangeFromMetrics(metrics, false)).toBe(titleDelta);
    expect(titleDelta).toBe(120_000);
  });

  it("sums period deposits without requiring a prior-month close", () => {
    const row = baseRow({
      account_id: 40,
      deposits_clp: 3_000_000,
      delta_total_clp: 41_502,
      current_value_clp: 3_041_502,
      deposits_month_clp: 3_000_000,
      delta_month_clp: undefined,
    });
    const metrics = cardGroupMetricsFromAccounts([row], "month");
    expect(metrics.deposits_period_clp).toBe(3_000_000);
  });

  it("subset title delta matches period metrics for nav-scoped rows", () => {
    const row = baseRow({
      account_id: 30,
      deposits_clp: 26_409_638,
      delta_total_clp: 1_243_298,
      current_value_clp: 27_652_936,
      prior_month_close_clp: 30_291_566,
      deposits_month_clp: -2_700_000,
      delta_month_clp: 61_370,
    });
    const metrics = cardGroupMetricsFromAccounts([row], "month");
    const title = subsetTitleBalanceDeltaRounded([row], "month", false, () => true);
    expect(cardPeriodChangeFromMetrics(metrics, false)).toBe(title);
  });
});
