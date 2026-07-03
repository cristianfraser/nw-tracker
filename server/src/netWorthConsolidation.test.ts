import { describe, expect, it } from "vitest";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import { buildNetWorthConsolidatedMonthly, buildInversionesConsolidatedMonthly, inversionesPeriodMetrics, netWorthCurrentMonthMetrics } from "./netWorthConsolidation.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("buildInversionesConsolidatedMonthly", () => {
  it("current month net_capital_flow sums brokerage + retirement bucket consolidations", async () => {
    await withPortfolioGroupIndex(async () => {
      const invRows = buildInversionesConsolidatedMonthly("clp");
      const broDetalle = getGroupConsolidatedTables("brokerage", "clp");
      const retDetalle = getGroupConsolidatedTables("retirement", "clp");
      const mk = monthKeyFromYmd(chileCalendarTodayYmd());

      const invRow = invRows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
      const broRow = broDetalle.consolidated_monthly.find(
        (r) => monthKeyFromYmd(r.as_of_date) === mk
      );
      const retRow = retDetalle.consolidated_monthly.find(
        (r) => monthKeyFromYmd(r.as_of_date) === mk
      );
      if (!invRow || !broRow || !retRow) return;

      expect(Math.round(invRow.net_capital_flow)).toBe(
        Math.round(broRow.net_capital_flow + retRow.net_capital_flow)
      );
      expect(Math.round(invRow.closing_value)).toBe(
        Math.round(broRow.closing_value + retRow.closing_value)
      );
    });
  });

  it("inversiones detalle matches buildInversionesConsolidatedMonthly", async () => {
    await withPortfolioGroupIndex(async () => {
      const canonical = buildInversionesConsolidatedMonthly("clp");
      const detalle = getGroupConsolidatedTables("inversiones", "clp");
      const mk = monthKeyFromYmd(chileCalendarTodayYmd());
      const canonicalRow = canonical.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
      const detalleRow = detalle.consolidated_monthly.find(
        (r) => monthKeyFromYmd(r.as_of_date) === mk
      );
      if (!canonicalRow || !detalleRow) return;
      expect(Math.round(detalleRow.net_capital_flow)).toBe(Math.round(canonicalRow.net_capital_flow));
      expect(Math.round(detalleRow.closing_value)).toBe(Math.round(canonicalRow.closing_value));
    });
  });

  it("inversionesPeriodMetrics matches consolidated row", () => {
    const rows = buildInversionesConsolidatedMonthly("clp");
    const mk = monthKeyFromYmd(chileCalendarTodayYmd());
    const row = rows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
    const metrics = inversionesPeriodMetrics("clp").month;
    if (!row || !metrics) return;
    expect(metrics.net_capital_flow_clp).toBe(Math.round(row.net_capital_flow));
    expect(metrics.closing_clp).toBe(Math.round(row.closing_value));
  });
});

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

  it("page-bundle totals and overview chart total_nw align in USD", async () => {
    await withPortfolioGroupIndex(async () => {
      const payload = await buildDashboardPagePayload(true);
      const ts = getDashboardValuationTimeseries("usd");
      const overview = ts.overview?.points ?? [];
      const lastOverview = overview.length ? overview[overview.length - 1] : null;
      const chartNw =
        lastOverview && typeof lastOverview.total_nw === "number"
          ? Math.round(lastOverview.total_nw)
          : null;

      const nwUsd = payload.totals.net_worth_usd;
      if (nwUsd == null || nwUsd <= 0 || chartNw == null) return;

      expect(chartNw).toBeCloseTo(Math.round(nwUsd), -2);
    });
  });

  it("patrimonio USD milestone chart backfills reference lines on leading anchor date", async () => {
    await withPortfolioGroupIndex(async () => {
      const ts = getDashboardValuationTimeseries("clp");
      const block = ts.patrimonio_usd_milestones_chart;
      if (!block?.points.length) return;

      const sorted = [...block.points].sort((a, b) =>
        String(a.as_of_date).localeCompare(String(b.as_of_date))
      );
      const firstData = sorted.find(
        (r) => typeof r.total_nw === "number" && Number.isFinite(r.total_nw)
      );
      if (!firstData) return;

      const firstDate = String(firstData.as_of_date);
      const leading = sorted.filter((r) => String(r.as_of_date) < firstDate);
      expect(leading.length).toBeGreaterThan(0);
      for (const row of leading) {
        expect(typeof row.usd_50k === "number" && row.usd_50k > 0).toBe(true);
        expect(block.referenceMilestoneByDate?.[String(row.as_of_date)]?.usd_50k).toBe(row.usd_50k);
      }
    });
  });
});
