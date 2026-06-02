import { describe, expect, it } from "vitest";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  accountCardPerformanceMetricsFromPerf,
  accountPriorPeriodCloseFromPerf,
} from "./dashboardAccountCardMetrics.js";

function perfRow(
  partial: Partial<AccountMonthlyPerformanceRow> & Pick<AccountMonthlyPerformanceRow, "as_of_date">
): AccountMonthlyPerformanceRow {
  return {
    closing_value: 100,
    prior_closing: 90,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: 10,
    pct_month: null,
    ytd_nominal_pl: 10,
    cumulative_nominal_pl: 10,
    unit: "clp",
    ...partial,
  };
}

describe("accountCardPerformanceMetricsFromPerf", () => {
  const today = "2026-05-27";

  it("uses current calendar month nominal_pl for delta_month", () => {
    const perf = {
      monthly: [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 42, cumulative_nominal_pl: 500 }),
        perfRow({ as_of_date: "2026-04-30", nominal_pl: 10, cumulative_nominal_pl: 458 }),
      ],
    };
    const m = accountCardPerformanceMetricsFromPerf(perf, today);
    expect(m.delta_month).toBe(42);
    expect(m.delta_total).toBe(500);
  });

  it("returns null delta_month on month rollover when perf has no current-month row", () => {
    const perf = {
      monthly: [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 2_371_544, cumulative_nominal_pl: 500 }),
        perfRow({ as_of_date: "2026-04-30", nominal_pl: 10, cumulative_nominal_pl: 458 }),
      ],
    };
    const m = accountCardPerformanceMetricsFromPerf(perf, "2026-06-01");
    expect(m.delta_month).toBeNull();
    expect(m.delta_total).toBe(500);
  });

  it("sums nominal_pl in the current calendar year for delta_year", () => {
    const perf = {
      monthly: [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 5, cumulative_nominal_pl: 15 }),
        perfRow({ as_of_date: "2026-03-31", nominal_pl: 7, cumulative_nominal_pl: 10 }),
        perfRow({ as_of_date: "2025-12-31", nominal_pl: 100, cumulative_nominal_pl: 100 }),
      ],
    };
    const m = accountCardPerformanceMetricsFromPerf(perf, today);
    expect(m.delta_year).toBe(12);
  });
});

describe("accountPriorPeriodCloseFromPerf", () => {
  const today = "2026-05-27";

  it("returns prior calendar month close when present", () => {
    const perf = {
      monthly: [
        perfRow({ as_of_date: "2026-05-31", closing_value: 200 }),
        perfRow({ as_of_date: "2026-04-30", closing_value: 150 }),
      ],
    };
    expect(accountPriorPeriodCloseFromPerf(perf, "month", today)).toBe(150);
  });

  it("returns latest pre-year close for year period", () => {
    const perf = {
      monthly: [
        perfRow({ as_of_date: "2026-03-31", closing_value: 300 }),
        perfRow({ as_of_date: "2025-12-31", closing_value: 250 }),
        perfRow({ as_of_date: "2025-06-30", closing_value: 200 }),
      ],
    };
    expect(accountPriorPeriodCloseFromPerf(perf, "year", today)).toBe(250);
  });
});
