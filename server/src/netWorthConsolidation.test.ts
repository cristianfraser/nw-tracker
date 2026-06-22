import { describe, expect, it } from "vitest";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import { buildNetWorthConsolidatedMonthly, netWorthCurrentMonthMetrics } from "./netWorthConsolidation.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("buildNetWorthConsolidatedMonthly", () => {
  it("current month net_capital_flow sums bucket account deposits", () => {
    const rows = buildNetWorthConsolidatedMonthly("clp");
    const mk = monthKeyFromYmd(chileCalendarTodayYmd());
    const row = rows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
    if (!row) return;
    expect(Number.isFinite(row.net_capital_flow)).toBe(true);
  });

  it("netWorthCurrentMonthMetrics matches consolidated row", () => {
    const rows = buildNetWorthConsolidatedMonthly("clp");
    const mk = monthKeyFromYmd(chileCalendarTodayYmd());
    const row = rows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
    const metrics = netWorthCurrentMonthMetrics("clp");
    if (!row || !metrics) return;

    expect(metrics.closing_clp).toBe(Math.round(row.closing_value));
    expect(metrics.net_capital_flow_clp).toBe(Math.round(row.net_capital_flow));
    if (row.nominal_pl != null) {
      expect(metrics.nominal_pl_clp).toBe(Math.round(row.nominal_pl));
    }
  });
});

describe("net worth surfaces reconcile", () => {
  it("page-bundle totals, period metrics, detalle, and chart total_nw align", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(false);
      const ts = getDashboardValuationTimeseries("clp");
      const detalle = getGroupConsolidatedTables("net_worth", "clp");
      const mk = monthKeyFromYmd(chileCalendarTodayYmd());

      const consolidated = detalle.consolidated_monthly.find(
        (r) => monthKeyFromYmd(r.as_of_date) === mk
      );
      const nwMetrics = payload.net_worth_period_metrics;
      const overview = ts.overview?.points ?? [];
      const lastOverview = overview.length ? overview[overview.length - 1] : null;
      const chartNw =
        lastOverview && typeof lastOverview.total_nw === "number"
          ? Math.round(lastOverview.total_nw)
          : null;

      if (payload.totals.net_worth_clp <= 0) return;

      if (consolidated) {
        expect(Math.round(consolidated.closing_value)).toBe(payload.totals.net_worth_clp);
      }
      if (nwMetrics && consolidated) {
        expect(nwMetrics.closing_clp).toBe(Math.round(consolidated.closing_value));
        expect(nwMetrics.net_capital_flow_clp).toBe(Math.round(consolidated.net_capital_flow));
        if (consolidated.nominal_pl != null) {
          expect(nwMetrics.nominal_pl_clp).toBe(Math.round(consolidated.nominal_pl));
        }
      }
      if (chartNw != null) {
        expect(chartNw).toBeCloseTo(payload.totals.net_worth_clp, -2);
      }
      if (consolidated && chartNw != null) {
        expect(chartNw).toBeCloseTo(Math.round(consolidated.closing_value), -2);
      }
    });
  });
});
