import { describe, expect, it } from "vitest";
import {
  getGroupConsolidatedMonthlyPage,
  getGroupConsolidatedTables,
  rollupConsolidatedMonthlyYearly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupConsolidatedTables.js";

function monthRow(overrides: Partial<ConsolidatedMonthlyPerfRow> & { as_of_date: string }): ConsolidatedMonthlyPerfRow {
  return {
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: null,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
    ...overrides,
  };
}

describe("rollupConsolidatedMonthlyYearly", () => {
  it("returns empty for no rows", () => {
    expect(rollupConsolidatedMonthlyYearly([])).toEqual([]);
  });

  it("sums flows/P-L per year, compounds pct, and takes closing/cumulative from the latest month", () => {
    const rows = [
      // newest-first, as produced by the consolidation builders
      monthRow({
        as_of_date: "2025-02-28",
        closing_value: 1200,
        net_capital_flow: 100,
        nominal_pl: 20,
        pct_month: 0.02,
        cumulative_nominal_pl: 70,
      }),
      monthRow({
        as_of_date: "2025-01-31",
        closing_value: 1080,
        net_capital_flow: 50,
        nominal_pl: 30,
        pct_month: 0.03,
        cumulative_nominal_pl: 50,
      }),
      monthRow({
        as_of_date: "2024-12-31",
        closing_value: 1000,
        net_capital_flow: 900,
        nominal_pl: 20,
        pct_month: 0.01,
        cumulative_nominal_pl: 20,
      }),
    ];

    const yearly = rollupConsolidatedMonthlyYearly(rows);
    expect(yearly.map((r) => r.as_of_date)).toEqual(["2025-12-31", "2024-12-31"]);

    const y2025 = yearly[0]!;
    expect(y2025.net_capital_flow).toBe(150);
    expect(y2025.nominal_pl).toBe(50);
    expect(y2025.closing_value).toBe(1200);
    expect(y2025.cumulative_nominal_pl).toBe(70);
    expect(y2025.pct_month).toBeCloseTo(1.03 * 1.02 - 1, 12);

    const y2024 = yearly[1]!;
    expect(y2024.net_capital_flow).toBe(900);
    expect(y2024.nominal_pl).toBe(20);
  });

  it("resets the decade-to-date running P/L on years ending in 0", () => {
    const rows = [
      monthRow({ as_of_date: "2020-06-30", nominal_pl: 7 }),
      monthRow({ as_of_date: "2019-06-30", nominal_pl: 5 }),
      monthRow({ as_of_date: "2018-06-30", nominal_pl: 3 }),
    ];

    const yearly = rollupConsolidatedMonthlyYearly(rows);
    expect(yearly.map((r) => [r.as_of_date.slice(0, 4), r.ytd_nominal_pl])).toEqual([
      ["2020", 7], // new decade: running sum restarts
      ["2019", 8], // 3 + 5 within 2010-2019
      ["2018", 3],
    ]);
  });

  it("treats null pct months as flat when compounding", () => {
    const rows = [
      monthRow({ as_of_date: "2025-02-28", pct_month: null }),
      monthRow({ as_of_date: "2025-01-31", pct_month: 0.05 }),
    ];
    expect(rollupConsolidatedMonthlyYearly(rows)[0]!.pct_month).toBeCloseTo(0.05, 12);
  });
});

describe("getGroupConsolidatedMonthlyPage", () => {
  it("net_worth pages slice the same consolidated series consolidated-tables returns", () => {
    const full = getGroupConsolidatedTables("net_worth", "clp").consolidated_monthly;
    const page1 = getGroupConsolidatedMonthlyPage("net_worth", "clp", "month", 1, 12);

    expect(page1.total).toBe(full.length);
    expect(page1.page).toBe(1);
    expect(page1.page_size).toBe(12);
    expect(page1.rows).toEqual(full.slice(0, 12));

    const page2 = getGroupConsolidatedMonthlyPage("net_worth", "clp", "month", 2, 12);
    expect(page2.rows).toEqual(full.slice(12, 24));
  });

  it("year period paginates the yearly rollup of the same series", () => {
    const full = getGroupConsolidatedTables("net_worth", "clp").consolidated_monthly;
    const yearly = rollupConsolidatedMonthlyYearly(full);
    const page1 = getGroupConsolidatedMonthlyPage("net_worth", "clp", "year", 1, 12);

    expect(page1.period).toBe("year");
    expect(page1.total).toBe(yearly.length);
    expect(page1.rows).toEqual(yearly.slice(0, 12));
  });

  it("clamps past-the-end pages to the last page", () => {
    const page = getGroupConsolidatedMonthlyPage("net_worth", "clp", "month", 9999, 12);
    const totalPages = Math.max(1, Math.ceil(page.total / 12));
    expect(page.page).toBe(totalPages);
  });
});
