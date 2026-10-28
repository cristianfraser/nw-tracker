import { describe, expect, it } from "vitest";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  accountPeriodMetricsFromMonthlyRows,
  pickMonthlyPerfRowsByMonth,
} from "./accountPeriodMetrics.js";

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

describe("pickMonthlyPerfRowsByMonth", () => {
  it("keeps one row per month, the representative snapshot with the month's flows summed", () => {
    const picked = pickMonthlyPerfRowsByMonth([
      perfRow({ as_of_date: "2026-05-31", nominal_pl: 42, net_capital_flow: 5 }),
      perfRow({ as_of_date: "2026-05-12", nominal_pl: 7, net_capital_flow: 100 }),
      perfRow({ as_of_date: "2026-04-30", nominal_pl: 10, net_capital_flow: 1 }),
    ]);
    expect([...picked.keys()]).toEqual(["2026-04", "2026-05"]);
    expect(picked.get("2026-05")!.nominal_pl).toBe(42);
    expect(picked.get("2026-05")!.net_capital_flow).toBe(105);
  });
});

describe("accountPeriodMetricsFromMonthlyRows", () => {
  const today = "2026-05-27";

  it("month = the current calendar month's row; lifetime = every month summed", () => {
    const m = accountPeriodMetricsFromMonthlyRows(
      [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 42, net_capital_flow: 5 }),
        perfRow({ as_of_date: "2026-04-30", nominal_pl: 10, net_capital_flow: 20 }),
      ],
      today
    );
    expect(m.delta_month).toBe(42);
    expect(m.deposits_month).toBe(5);
    expect(m.delta_total).toBe(52);
    expect(m.deposits_total).toBe(25);
  });

  it("null delta_month on month rollover when there is no current-month row", () => {
    const m = accountPeriodMetricsFromMonthlyRows(
      [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 2_371_544 }),
        perfRow({ as_of_date: "2026-04-30", nominal_pl: 10 }),
      ],
      "2026-06-01"
    );
    expect(m.delta_month).toBeNull();
    expect(m.deposits_month).toBe(0);
    expect(m.delta_total).toBe(2_371_554);
  });

  it("year = the current calendar year's months summed, flows included", () => {
    const m = accountPeriodMetricsFromMonthlyRows(
      [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: 5, net_capital_flow: 1 }),
        perfRow({ as_of_date: "2026-03-31", nominal_pl: 7, net_capital_flow: 2 }),
        perfRow({ as_of_date: "2025-12-31", nominal_pl: 100, net_capital_flow: 50 }),
      ],
      today
    );
    expect(m.delta_year).toBe(12);
    expect(m.deposits_year).toBe(3);
    expect(m.delta_total).toBe(112);
    expect(m.deposits_total).toBe(53);
  });

  it("no rows: deposits 0, deltas null (loading is not absence, absence is null)", () => {
    const m = accountPeriodMetricsFromMonthlyRows([], today);
    expect(m).toEqual({
      deposits_month: 0,
      delta_month: null,
      deposits_year: 0,
      delta_year: null,
      deposits_total: 0,
      delta_total: null,
    });
  });

  it("a month whose P/L is null still counts its flows and leaves the sums to the other months", () => {
    const m = accountPeriodMetricsFromMonthlyRows(
      [
        perfRow({ as_of_date: "2026-05-31", nominal_pl: null, net_capital_flow: 9 }),
        perfRow({ as_of_date: "2026-04-30", nominal_pl: 4, net_capital_flow: 1 }),
      ],
      today
    );
    expect(m.delta_month).toBeNull();
    expect(m.deposits_month).toBe(9);
    expect(m.delta_year).toBe(4);
    expect(m.deposits_year).toBe(10);
  });
});
