import { afterEach, describe, expect, it, vi } from "vitest";
import * as accountMarkModule from "./accountMarkClpAtYmd.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("buildDashboardAccountRows prior closes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests prior month and year marks via accountMarkClpAtYmd for every valued row", async () => {
    const markSpy = vi.spyOn(accountMarkModule, "accountMarkClpAtYmd");
    const rows = await buildDashboardAccountRows(false);
    const today = chileCalendarTodayYmd();
    const priorMonthEnd = priorPeriodEndYmd("mtd", today);
    const priorYearEnd = priorPeriodEndYmd("ytd", today);

    const valued = rows.filter(
      (r) => r.current_value_clp != null && Number.isFinite(r.current_value_clp)
    );
    expect(valued.length).toBeGreaterThan(0);

    for (const row of valued) {
      expect(
        markSpy.mock.calls.some(
          ([id, ymd]) => id === row.account_id && ymd === priorMonthEnd
        )
      ).toBe(true);
      expect(
        markSpy.mock.calls.some(
          ([id, ymd]) => id === row.account_id && ymd === priorYearEnd
        )
      ).toBe(true);
    }
  });

  it("suecia dashboard current and month delta match depto live mark and perf P/L", async () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const depto = deptoAccountMarkClpAtYmd("property", chileCalendarTodayYmd());
    if (!depto) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const cur = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (cur?.nominal_pl == null) return;

    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows(false));
    const dash = rows.find((r) => r.account_id === row.id);
    if (!dash) return;

    expect(dash.current_value_clp).toBe(depto.value_clp);
    expect(dash.delta_month_clp).toBe(cur.nominal_pl);
  });

  it("sets prior_year_close_clp when accountMarkClpAtYmd returns a year-end mark", async () => {
    const today = chileCalendarTodayYmd();
    const priorYearEnd = priorPeriodEndYmd("ytd", today);
    const markSpy = vi.spyOn(accountMarkModule, "accountMarkClpAtYmd");
    markSpy.mockImplementation((accountId, ymd, _kind, _opts) => {
      if (ymd === priorYearEnd && accountId === 1) {
        return { value_clp: 11_610_000, as_of_date: priorYearEnd };
      }
      return null;
    });

    const rows = await buildDashboardAccountRows(false);
    const hit = rows.find((r) => r.account_id === 1);
    if (hit?.current_value_clp != null) {
      expect(hit.prior_year_close_clp).toBe(11_610_000);
    }
  });
});
