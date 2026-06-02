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

import {
  monthEndCloseFromPerfRows,
  priorCloseFromPerfRows,
  priorPeriodEndYmd,
} from "./accountPeriodMarks.js";

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

describe("priorPeriodEndYmd", () => {
  it("MTD anchor is prior calendar month-end", () => {
    expect(priorPeriodEndYmd("mtd", "2026-06-01")).toBe("2026-05-31");
  });

  it("YTD anchor is prior calendar year-end", () => {
    expect(priorPeriodEndYmd("ytd", "2026-06-01")).toBe("2025-12-31");
  });

  it("DTD anchor is yesterday in Chile", () => {
    expect(priorPeriodEndYmd("dtd", "2026-06-01")).toBe("2026-05-31");
  });
});

describe("monthEndCloseFromPerfRows", () => {
  it("picks May 31 close over May 1 when both exist", () => {
    const monthly = [
      perfRow({ as_of_date: "2026-05-01", closing_value: 900_000 }),
      perfRow({ as_of_date: "2026-05-31", closing_value: 1_000_000 }),
    ];
    expect(monthEndCloseFromPerfRows(monthly, "2026-05")).toBe(1_000_000);
  });
});

describe("priorCloseFromPerfRows", () => {
  it("MTD uses prior month-end close not month-open", () => {
    chileToday.ymd = "2026-06-01";
    const monthly = [
      perfRow({ as_of_date: "2026-05-01", closing_value: 900_000 }),
      perfRow({ as_of_date: "2026-05-31", closing_value: 1_000_000 }),
    ];
    expect(priorCloseFromPerfRows(monthly, "mtd")).toBe(1_000_000);
  });

  it("YTD uses Dec 31 of prior year not mid-year row", () => {
    chileToday.ymd = "2026-06-01";
    const monthly = [
      perfRow({ as_of_date: "2025-06-30", closing_value: 200 }),
      perfRow({ as_of_date: "2025-12-31", closing_value: 250 }),
      perfRow({ as_of_date: "2026-05-31", closing_value: 300 }),
    ];
    expect(priorCloseFromPerfRows(monthly, "ytd")).toBe(250);
  });
});
