import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getGroupConsolidatedMonthlyPerfForRows } from "./groupMonthlyPerfConsolidation.js";
import { getDashboardValuationTimeseries, getGroupValuationTimeseries, listAccountsForGroupTab } from "./valuationTimeseries.js";

describe("cash_eqs net in dashboard charts", () => {
  it("overview cash at today matches consolidated cash_eqs cierre", () => {
    const asOf = chileCalendarTodayYmd();
    const tsDash = getDashboardValuationTimeseries("clp");
    const pt = tsDash.overview?.points.find((p) => String(p.as_of_date) === asOf);
    if (!pt || typeof pt.cash !== "number" || !Number.isFinite(pt.cash)) return;

    const tabRows = listAccountsForGroupTab("cash_eqs");
    const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, "cash_eqs", "clp");
    const curMk = monthKeyFromYmd(asOf);
    const row = consolidated.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!row) return;

    expect(pt.cash).toBeCloseTo(row.closing_value, 0);
  });

  it("overview cash and cash_eqs class-tab Total match on the live point", () => {
    // The overview dates its live point today; the class tab dates the same live point at the
    // current month's end.
    const asOf = chileCalendarTodayYmd();
    const ovPt = getDashboardValuationTimeseries("clp").overview?.points.at(-1);
    expect(ovPt?.as_of_date).toBe(asOf);
    expect(typeof ovPt?.cash).toBe("number");

    const cashPt = getGroupValuationTimeseries("cash_eqs", "clp").accounts_in_group?.points.at(-1);
    expect(monthKeyFromYmd(String(cashPt?.as_of_date))).toBe(monthKeyFromYmd(asOf));
    expect(typeof cashPt?.__group_val_total).toBe("number");

    expect(ovPt!.cash).toBeCloseTo(cashPt!.__group_val_total as number, 0);
  });
});
