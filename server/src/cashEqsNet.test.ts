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

  it("overview cash and cash_eqs class-tab Total match at today", () => {
    const asOf = chileCalendarTodayYmd();
    const tsDash = getDashboardValuationTimeseries("clp");
    const ovPt = tsDash.overview?.points.find((p) => String(p.as_of_date) === asOf);
    if (!ovPt || typeof ovPt.cash !== "number" || !Number.isFinite(ovPt.cash)) return;

    const tsCash = getGroupValuationTimeseries("cash_eqs", "clp");
    const cashPt = tsCash.accounts_in_group?.points.find((p) => String(p.as_of_date) === asOf);
    if (!cashPt) return;

    const tabTotal = cashPt.__group_val_total;
    if (typeof tabTotal !== "number" || !Number.isFinite(tabTotal)) return;

    expect(ovPt.cash).toBeCloseTo(tabTotal, 0);
  });
});
