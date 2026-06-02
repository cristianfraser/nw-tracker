import { describe, expect, it, vi } from "vitest";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-01" }));

vi.mock("./chileDate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chileDate.js")>();
  return {
    ...actual,
    chileCalendarTodayYmd: () => chileToday.ymd,
  };
});

import { patchOrInsertLiveCurrentMonthPerfRows } from "./accountPerformance.js";

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

describe("patchOrInsertLiveCurrentMonthPerfRows", () => {
  it("inserts a June row when today is June 1 and perf ends in May", () => {
    chileToday.ymd = "2026-06-01";

    const mayOnly = [
      perfRow({ as_of_date: "2026-04-30", closing_value: 90, prior_closing: 80, nominal_pl: 5 }),
      perfRow({
        as_of_date: "2026-05-31",
        closing_value: 1_000_000,
        prior_closing: 90,
        nominal_pl: 2_371_544,
      }),
    ];

    const out = patchOrInsertLiveCurrentMonthPerfRows(1, "apv", mayOnly, "clp", () => 1_000_500);

    const june = out.find((r) => r.as_of_date.startsWith("2026-06"));
    expect(june).toBeDefined();
    expect(june!.as_of_date).toBe("2026-06-01");
    expect(june!.prior_closing).toBe(1_000_000);
    expect(june!.closing_value).toBe(1_000_500);
    expect(june!.nominal_pl).toBe(500);
    expect(june!.net_capital_flow).toBe(0);
  });

  it("uses May month-end prior close when May has both month-open and month-end rows", () => {
    chileToday.ymd = "2026-06-01";

    const mayWithOpenAndClose = [
      perfRow({ as_of_date: "2026-05-01", closing_value: 900_000, prior_closing: 800_000 }),
      perfRow({
        as_of_date: "2026-05-31",
        closing_value: 1_000_000,
        prior_closing: 900_000,
        nominal_pl: 100_000,
      }),
    ];

    const out = patchOrInsertLiveCurrentMonthPerfRows(1, "apv", mayWithOpenAndClose, "clp", () => 1_000_100);

    const june = out.find((r) => r.as_of_date.startsWith("2026-06"));
    expect(june!.prior_closing).toBe(1_000_000);
    expect(june!.nominal_pl).toBe(100);
  });
});
