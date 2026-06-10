import { describe, expect, it } from "vitest";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { nwDashboardMetricGroupForAccount } from "./portfolioGroupTree.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("dashboard card closing reconcile", () => {
  it("bucket totals and title Δ match summed account closes and deposits + P/L", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      for (const slug of ["retirement", "brokerage"] as const) {
        const rows = payload.accounts.filter(
          (a) =>
            nwDashboardMetricGroupForAccount(a.account_id) === slug &&
            a.exclude_from_group_totals !== 1 &&
            !a.chart_inactive &&
            a.current_value_clp != null
        );
        const sumCurrent = rows.reduce((s, a) => s + (a.current_value_clp ?? 0), 0);
        const sumPrior = rows.reduce((s, a) => s + (a.prior_month_close_clp ?? 0), 0);
        const sumDep = rows.reduce((s, a) => s + (a.deposits_month_clp ?? 0), 0);
        const sumPl = rows.reduce((s, a) => s + (a.delta_month_clp ?? 0), 0);

        const bucketCurrent = payload.totals[`${slug}_clp`];
        const bucketPrior = payload.totals.prior_closes.month[`${slug}_clp`];
        const titleDelta = bucketCurrent - bucketPrior;

        expect(Math.round(sumCurrent)).toBe(bucketCurrent);
        expect(Math.round(sumPrior)).toBe(bucketPrior);
        expect(Math.round(titleDelta)).toBe(Math.round(sumDep + sumPl));
        expect(Math.round(sumCurrent - sumPrior)).toBe(Math.round(sumDep + sumPl));
      }
    });
  });
});
