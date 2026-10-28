import { describe, expect, it } from "vitest";
import {
  cardMainBalanceFromMetrics,
  cardMetricsByPeriodForAccountRow,
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

/** Group metrics are the server's (dashboardNavCardMetrics.test.ts); one row is projected here. */
describe("cardMetricsByPeriodForAccountRow", () => {
  it("projects one row: a sold-out account keeps its deposits and lifetime P/L", () => {
    const soldOut = baseRow({
      account_id: 2,
      deposits_clp: 1_000_000,
      delta_total_clp: 968_035,
      deposits_month_clp: -2_719_944,
      delta_month_clp: -241_251,
      current_value_clp: null,
    });
    const { month, day } = cardMetricsByPeriodForAccountRow(soldOut);
    expect(roundedMetricDeposits(month, false, "total")).toBe(1_000_000);
    expect(roundedMetricDeposits(month, false, "period")).toBe(-2_719_944);
    expect(roundedMetricDelta(month, false, "period")).toBe(-241_251);
    expect(cardMainBalanceFromMetrics(month, false)).toBe(1_968_035);
    // no day fields on the row: deposits 0, P/L absent
    expect(day.deposits_period_clp).toBe(0);
    expect(day.delta_period_clp).toBeNull();
  });

  it("no row: zero deposits and absent P/L", () => {
    const { year } = cardMetricsByPeriodForAccountRow(null);
    expect(year.deposits_clp).toBe(0);
    expect(year.delta_total_clp).toBeNull();
    expect(year.deposits_usd).toBeNull();
  });
});
