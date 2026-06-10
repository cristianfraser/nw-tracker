import { describe, expect, it } from "vitest";
import {
  cardGroupMetricsForDashboardBucket,
  cardGroupMetricsForGroup,
  cardGroupMetricsFromAccounts,
  cardMainBalanceFromMetrics,
  cardMetricsMainBalanceDiff,
  cardPeriodChangeFromMetrics,
  cardGroupTitleBalanceDelta,
  roundedMetricDelta,
  subsetTitleBalanceDeltaRounded,
  type DashboardBucketTotals,
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
        group_slug: "retirement",
        dashboard_bucket_slug: "retirement",
        deposits_clp: 1_000_000,
        delta_total_clp: 200_000,
        current_value_clp: 1_200_000,
        prior_month_close_clp: 1_100_000,
        deposits_month_clp: 50_000,
        delta_month_clp: 50_000,
      }),
      baseRow({
        account_id: 21,
        group_slug: "retirement",
        dashboard_bucket_slug: "retirement",
        deposits_clp: 500_000,
        delta_total_clp: 100_000,
        current_value_clp: 600_000,
        prior_month_close_clp: 580_000,
        deposits_month_clp: 20_000,
        delta_month_clp: 0,
      }),
    ];
    const totals: DashboardBucketTotals = {
      net_worth_clp: 1_800_000,
      real_estate_clp: 0,
      retirement_clp: 1_800_000,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
      prior_closes: {
        month_end: "2026-05-31",
        year_end: "2025-12-31",
        month: {
          net_worth_clp: 1_680_000,
          real_estate_clp: 0,
          retirement_clp: 1_680_000,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
        year: {
          net_worth_clp: 0,
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
      },
    };
    const metrics = cardGroupMetricsForGroup(accounts, "retirement", "month", undefined, totals);
    const titleDelta = cardGroupTitleBalanceDelta(accounts, totals, [], "retirement", "month", false);
    expect(roundedMetricDelta(metrics, false, "period")).toBe(50_000);
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

  it("title balance change differs from period P/L when period deposits are non-zero", () => {
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
    expect(roundedMetricDelta(metrics, false, "period")).toBe(61_370);
    expect(title).toBe(-2_638_630);
    expect(title).not.toBe(roundedMetricDelta(metrics, false, "period"));
  });
});

describe("cardGroupMetricsForDashboardBucket period delta", () => {
  it("period Δ is summed from server account rows, not recomputed from bucket totals", () => {
    const totals: DashboardBucketTotals = {
      net_worth_clp: 1_000,
      real_estate_clp: 0,
      retirement_clp: 1_000,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
      prior_closes: {
        month_end: "2026-05-31",
        year_end: "2025-12-31",
        month: {
          net_worth_clp: 500,
          real_estate_clp: 0,
          retirement_clp: 500,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
        year: {
          net_worth_clp: 0,
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
      },
    };
    const row = baseRow({
      account_id: 99,
      group_slug: "retirement",
      dashboard_bucket_slug: "retirement",
      current_value_clp: 800,
      prior_month_close_clp: 500,
      deposits_month_clp: 0,
      delta_month_clp: 250,
    });
    const metrics = cardGroupMetricsForDashboardBucket(totals, "retirement", [row], "month", false);
    expect(roundedMetricDelta(metrics, false, "period")).toBe(250);
  });

  it("title closing Δ equals deposits + P/L when totals sum the same account rows", () => {
    const row = baseRow({
      account_id: 99,
      group_slug: "retirement",
      dashboard_bucket_slug: "retirement",
      current_value_clp: 96_517_783,
      prior_month_close_clp: 95_651_400,
      deposits_month_clp: 0,
      delta_month_clp: 866_383,
    });
    const totals: DashboardBucketTotals = {
      net_worth_clp: 96_517_783,
      real_estate_clp: 0,
      retirement_clp: 96_517_783,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
      prior_closes: {
        month_end: "2026-05-31",
        year_end: "2025-12-31",
        month: {
          net_worth_clp: 95_651_400,
          real_estate_clp: 0,
          retirement_clp: 95_651_400,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
        year: {
          net_worth_clp: 0,
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 0,
        },
      },
    };
    const metrics = cardGroupMetricsForDashboardBucket(totals, "retirement", [row], "month", false);
    const titleDelta = cardGroupTitleBalanceDelta([row], totals, [], "retirement", "month", false);
    expect(roundedMetricDelta(metrics, false, "period")).toBe(866_383);
    expect(titleDelta).toBe(866_383);
    expect(cardPeriodChangeFromMetrics(metrics, false)).toBe(titleDelta);
  });
});

describe("cash_eqs bucket CC period P/L decoupling", () => {
  function cashRow(
    partial: Partial<DashboardAccountRow> & Pick<DashboardAccountRow, "account_id" | "current_value_clp">
  ): DashboardAccountRow {
    return {
      name: "Reserva",
      group_slug: "cash_eqs",
      group_label: "Cash",
      dashboard_bucket_slug: "cash_eqs",
      bucket_slug: "cash_eqs__cash_savings",
      category_slug: "fondo_reserva",
      deposits_clp: 0,
      exclude_from_group_totals: 0,
      ...partial,
    } as DashboardAccountRow;
  }

  const totals: DashboardBucketTotals = {
    net_worth_clp: 13_008_459,
    real_estate_clp: 0,
    retirement_clp: 0,
    brokerage_clp: 0,
    cash_eqs_clp: 13_008_459,
    prior_closes: {
      month_end: "2026-05-31",
      year_end: "2025-12-31",
      month: {
        net_worth_clp: 12_830_422,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 12_830_422,
      },
      year: {
        net_worth_clp: 0,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 0,
      },
    },
  };

  it("title delta uses CC-adjusted bucket totals; period P/L uses savings accounts only", () => {
    const reserva = cashRow({
      account_id: 1,
      current_value_clp: 24_415_248,
      prior_month_close_clp: 24_403_210,
      deposits_month_clp: 1_000_000,
      delta_month_clp: 12_038,
    });
    const accounts = [reserva];

    const metrics = cardGroupMetricsForDashboardBucket(
      totals,
      "cash_eqs",
      accounts,
      "month",
      false
    );
    const titleDelta = cardGroupTitleBalanceDelta(
      accounts,
      totals,
      [],
      "cash_eqs",
      "month",
      false
    );

    expect(titleDelta).toBe(178_037);
    expect(roundedMetricDelta(metrics, false, "period")).toBe(12_038);
    expect(cardPeriodChangeFromMetrics(metrics, false)).not.toBe(titleDelta);
  });
});
