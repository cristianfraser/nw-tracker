import { describe, expect, it } from "vitest";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import {
  NW_DASHBOARD_BUCKET_SLUGS,
  portfolioGroupValueClpAt,
} from "./portfolioGroupValueAtDate.js";

describe("portfolioGroupValueClpAt", () => {
  it("page-bundle bucket totals match consolidated valuation marks", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      const asOf = chileCalendarTodayYmd();
      for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
        expect(payload.totals[`${slug}_clp`]).toBe(portfolioGroupValueClpAt(slug, asOf));
      }
      // Headline total = round of the raw bucket sum (must equal the overview chart /
      // consolidated closing exactly — see netWorthConsolidation.test.ts). Cards are
      // rounded per bucket, so their sum may drift from the total by ±1 peso per bucket.
      const cardSum =
        payload.totals.real_estate_clp +
        payload.totals.retirement_clp +
        payload.totals.brokerage_clp +
        payload.totals.cash_eqs_clp;
      expect(Math.abs(payload.totals.net_worth_clp - cardSum)).toBeLessThanOrEqual(2);
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
