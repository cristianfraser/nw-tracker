import { describe, expect, it } from "vitest";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { nwBucketSlugs } from "./navTreeModel.js";
import { portfolioGroupValueClpAt } from "./portfolioGroupValueAtDate.js";

describe("portfolioGroupValueClpAt", () => {
  it("page-bundle bucket totals match consolidated valuation marks", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload("clp");
      const asOf = chileCalendarTodayYmd();
      for (const slug of nwBucketSlugs()) {
        expect(payload.totals.buckets[slug]).toBe(portfolioGroupValueClpAt(slug, asOf));
      }
      // Headline total = round of the raw bucket sum (must equal the overview chart /
      // consolidated closing exactly — see netWorthConsolidation.test.ts). Cards are
      // rounded per bucket, so their sum may drift from the total by ±1 peso per bucket.
      const cardSum =
        payload.totals.buckets.real_estate! +
        payload.totals.buckets.retirement! +
        payload.totals.buckets.brokerage! +
        payload.totals.buckets.cash_eqs!;
      expect(Math.abs(payload.totals.net_worth! - cardSum)).toBeLessThanOrEqual(2);
    });
  });

  it("prior month net worth delta aligns with overview chart MoM", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload("clp");
      const priorEnd = priorPeriodEndYmd("mtd", chileCalendarTodayYmd());
      const cardDelta =
        payload.totals.net_worth! - payload.totals.prior_closes.month.net_worth!;

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
