import { describe, expect, it } from "vitest";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { accountWithRoleOptional } from "./accountRoles.js";
/** The depto property and its loan (their roles). */
const deptoPropertyId = (): number => accountWithRoleOptional("property") ?? -1;


describe("buildDashboardAccountRows prior closes", () => {
  it("depto dashboard current and month delta match depto live mark and perf P/L", async () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%depto%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const depto = deptoAccountMarkClpAtYmd(deptoPropertyId(), chileCalendarTodayYmd());
    if (!depto) return;

    const perf = monthlyPerfForAccountId(row.id, "clp");
    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const cur = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (cur?.nominal_pl == null) return;

    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows("clp"));
    const dash = rows.find((r) => r.account_id === row.id);
    if (!dash) return;

    expect(dash.current_value).toBe(depto.value_clp);
    expect(dash.delta_month).toBe(cur.nominal_pl);
  });
});
