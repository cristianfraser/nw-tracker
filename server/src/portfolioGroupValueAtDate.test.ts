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
import { buildDashboardBucketValueTotalsInUnit } from "./portfolioGroupValueAtDate.js";

describe("the headline's bucket totals", () => {
  it("the page bundle serves the headline, and its cards add up to it exactly", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload("clp");
      const headline = buildDashboardBucketValueTotalsInUnit(chileCalendarTodayYmd(), "clp");
      for (const slug of nwBucketSlugs()) {
        expect(payload.totals.buckets[slug]).toBe(headline.buckets[slug]);
      }
      expect(payload.totals.net_worth).toBe(headline.net_worth);
      // Headline total = the exact bucket sum rounded once (the overview chart's level — see
      // netWorthConsolidation.test.ts); the cards are apportioned to it, so they add up exactly.
      const cardSum = nwBucketSlugs().reduce((s, slug) => s + (payload.totals.buckets[slug] ?? 0), 0);
      expect(cardSum).toBe(payload.totals.net_worth);
    });
  });

  it("in another unit the cards, the net-worth card and every prior close add up at the cent", async () => {
    await withPortfolioGroupIndex(async () => {
      for (const unit of ["usd", "eur"] as const) {
        const payload = await buildDashboardPagePayload(unit);
        const cents = (v: number) => Math.round(v * 100);
        const closes = [payload.totals, payload.totals.prior_closes.day, payload.totals.prior_closes.month, payload.totals.prior_closes.year];
        for (const close of closes) {
          let sum = 0;
          for (const slug of nwBucketSlugs()) {
            const v = close.buckets[slug];
            if (v == null) continue;
            // A whole number of cents.
            expect(Math.abs(v * 100 - cents(v))).toBeLessThan(1e-6);
            sum += cents(v);
          }
          expect(sum).toBe(cents(close.net_worth!));
        }
        // The net-worth card is the headline, and each bucket card its bucket.
        expect(payload.card_metrics_by_slug.net_worth!.value.parent).toBe(payload.totals.net_worth);
        for (const slug of nwBucketSlugs()) {
          expect(payload.card_metrics_by_slug[slug]!.value.child).toBe(payload.totals.buckets[slug]);
        }
        // The value map's root is the headline too, and its bucket frames the bucket cards.
        expect(payload.value_map.value).toBe(payload.totals.net_worth);
      }
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
