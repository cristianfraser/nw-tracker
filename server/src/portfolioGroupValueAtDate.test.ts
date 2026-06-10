import { describe, expect, it } from "vitest";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("portfolioGroupValueClpAt", () => {
  it("page-bundle bucket totals match summed dashboard account rows", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      const { nwDashboardMetricGroupForAccount } = await import("./portfolioGroupTree.js");
      for (const slug of ["real_estate", "retirement", "brokerage", "cash_eqs"] as const) {
        const sum = payload.accounts
          .filter(
            (a) =>
              nwDashboardMetricGroupForAccount(a.account_id) === slug &&
              a.exclude_from_group_totals !== 1 &&
              !a.chart_inactive &&
              a.current_value_clp != null
          )
          .reduce((s, a) => s + (a.current_value_clp ?? 0), 0);
        expect(Math.round(sum)).toBe(payload.totals[`${slug}_clp`]);
      }
      expect(payload.totals.net_worth_clp).toBe(
        payload.totals.real_estate_clp +
          payload.totals.retirement_clp +
          payload.totals.brokerage_clp +
          payload.totals.cash_eqs_clp
      );
    });
  });

  it("prior month net worth delta aligns with overview chart MoM", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      const priorEnd = priorPeriodEndYmd("mtd", chileCalendarTodayYmd());
      const cardDelta =
        payload.totals.net_worth_clp - payload.totals.prior_closes.month.net_worth_clp;

      const ts = getDashboardValuationTimeseries("clp");
      const points = ts.overview?.points ?? [];
      const sorted = [...points].sort((a, b) =>
        String(a.as_of_date).localeCompare(String(b.as_of_date))
      );
      const todayPt = sorted.find((p) => String(p.as_of_date) === chileCalendarTodayYmd());
      const priorPt = sorted.find((p) => String(p.as_of_date) === priorEnd);
      if (
        !todayPt ||
        !priorPt ||
        typeof todayPt.total_nw !== "number" ||
        typeof priorPt.total_nw !== "number"
      ) {
        return;
      }
      const chartDelta = Math.round(todayPt.total_nw - priorPt.total_nw);
      expect(Math.abs(cardDelta - chartDelta)).toBeLessThanOrEqual(1);
    });
  });
});
