import { describe, expect, it } from "vitest";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { buildNetWorthConsolidatedMonthly } from "./netWorthConsolidation.js";
import { nwDashboardMetricGroupForAccount } from "./portfolioGroupTree.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("dashboard card closing reconcile", () => {
  it("consolidated NW month row matches bucket title delta and deposits", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      const mk = monthKeyFromYmd(chileCalendarTodayYmd());
      const row = buildNetWorthConsolidatedMonthly("clp").find(
        (r) => monthKeyFromYmd(r.as_of_date) === mk
      );
      if (!row || row.prior_closing == null || !Number.isFinite(row.prior_closing)) return;

      const titleDelta =
        payload.totals.net_worth_clp - payload.totals.prior_closes.month.net_worth_clp;
      expect(Math.round(titleDelta)).toBeCloseTo(
        Math.round(row.closing_value - row.prior_closing),
        0
      );
      const bucketDepSum = (["real_estate", "retirement", "brokerage", "cash_eqs"] as const).reduce(
        (s, slug) =>
          s +
          payload.accounts
            .filter(
              (a) =>
                a.dashboard_bucket_slug === slug && a.exclude_from_group_totals !== 1
            )
            .reduce((t, a) => t + (a.deposits_month_clp ?? 0), 0),
        0
      );
      expect(Math.round(row.net_capital_flow)).toBeCloseTo(bucketDepSum, 0);
    });
  });

  it("bucket totals and title Δ match summed account closes and deposits + P/L", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      for (const slug of ["retirement", "brokerage"] as const) {
        const rows = payload.accounts.filter(
          (a) =>
            nwDashboardMetricGroupForAccount(a.account_id) === slug &&
            a.exclude_from_group_totals !== 1
        );
        const sumCurrent = rows.reduce((s, a) => s + (a.current_value_clp ?? 0), 0);
        const sumPrior = rows.reduce((s, a) => s + (a.prior_month_close_clp ?? 0), 0);
        const sumDep = rows.reduce((s, a) => s + (a.deposits_month_clp ?? 0), 0);
        const sumPl = rows.reduce((s, a) => s + (a.delta_month_clp ?? 0), 0);

        const bucketCurrent = payload.totals[`${slug}_clp`];
        const bucketPrior = payload.totals.prior_closes.month[`${slug}_clp`];
        const titleDelta = bucketCurrent - bucketPrior;

        // Bucket totals are largest-remainder apportioned so cards sum EXACTLY to the
        // headline (see portfolioGroupValueAtDate.ts); each bucket may sit ±1 CLP from
        // its own independent rounding, and the delta compounds two apportioned values.
        expect(Math.abs(Math.round(sumCurrent) - bucketCurrent)).toBeLessThanOrEqual(1);
        expect(Math.abs(Math.round(sumPrior) - bucketPrior)).toBeLessThanOrEqual(1);
        expect(Math.abs(Math.round(titleDelta) - Math.round(sumDep + sumPl))).toBeLessThanOrEqual(2);
        expect(Math.round(sumCurrent - sumPrior)).toBe(Math.round(sumDep + sumPl));
      }
    });
  });
});
