import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { accountValueAt } from "./accountValue.js";
import { groupAccountIds, nwBucketSlugs } from "./navTreeModel.js";
import { linkedCardsOwedInUnit, nodeNetsLinkedCards } from "./nodeValue.js";
import { buildDashboardBucketValueTotalsInUnit, portfolioGroupValueClpAt } from "./portfolioGroupValueAtDate.js";

describe("portfolioGroupValueClpAt", () => {
  it("page-bundle bucket totals match consolidated valuation marks", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload("clp");
      const asOf = chileCalendarTodayYmd();
      for (const slug of nwBucketSlugs()) {
        expect(payload.totals.buckets[slug]).toBe(portfolioGroupValueClpAt(slug, asOf));
      }
      // Headline total = round of the raw bucket sum (must equal the overview chart's level
      // exactly — see netWorthConsolidation.test.ts). Cards are
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

  it("the headline at a prior close is the sum of its members' values, less the linked cards where it nets", () => {
    const today = chileCalendarTodayYmd();
    for (const asOf of [priorPeriodEndYmd("mtd", today), priorPeriodEndYmd("ytd", today)]) {
      for (const unit of ["clp", "usd"] as const) {
        const totals = buildDashboardBucketValueTotalsInUnit(asOf, unit);
        const coin = unit === "clp" ? 1 : 0.01;
        let membersNetWorth = 0;
        for (const slug of nwBucketSlugs()) {
          let members = 0;
          for (const id of groupAccountIds(slug, { forTotals: true })) {
            const excluded = db
              .prepare(`SELECT COALESCE(exclude_from_group_totals, 0) AS x FROM accounts WHERE id = ?`)
              .get(id) as { x: number };
            if (excluded.x === 1) continue;
            const v = accountValueAt(id, asOf, unit)?.value;
            if (v != null && Number.isFinite(v)) members += v;
          }
          if (nodeNetsLinkedCards(slug)) members -= linkedCardsOwedInUnit(asOf, unit);
          membersNetWorth += members;
          expect(Math.abs(totals.buckets[slug]! - members)).toBeLessThan(coin);
        }
        expect(Math.abs(totals.net_worth! - membersNetWorth)).toBeLessThan(coin);
      }
    }
  });
});
