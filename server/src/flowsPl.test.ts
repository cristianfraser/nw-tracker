import { afterAll, describe, expect, it, vi } from "vitest";

import * as chileDate from "./chileDate.js";

const realChileToday = chileDate.chileCalendarTodayYmd();

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-15" }));

const chileCalendarTodaySpy = vi
  .spyOn(chileDate, "chileCalendarTodayYmd")
  .mockImplementation(() => chileToday.ymd);

afterAll(() => {
  chileCalendarTodaySpy.mockRestore();
});

import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  assembleFlowsPlChartSeries,
  buildFlowsPlPayload,
  flowsPlAccountPerfSummary,
  FLOWS_PL_BUCKETS,
} from "./flowsPl.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";

function consolidatedRow(
  as_of_date: string,
  nominal_pl: number | null
): ConsolidatedMonthlyPerfRow {
  return {
    as_of_date,
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
  };
}

function perfRow(as_of_date: string, nominal_pl: number | null): AccountMonthlyPerformanceRow {
  return {
    as_of_date,
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
    unit: "clp",
  };
}

describe("assembleFlowsPlChartSeries", () => {
  it("unions bucket months with zero-fill and normalizes to month-end", () => {
    chileToday.ymd = "2026-06-15";
    const points = assembleFlowsPlChartSeries(
      {
        brokerage: [consolidatedRow("2026-03-31", 100_000), consolidatedRow("2026-06-15", 40_000)],
        retirement: [consolidatedRow("2026-04-30", -25_000)],
        cash: [],
      },
      "month"
    );
    expect(points.map((p) => p.as_of_date)).toEqual([
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(points[0]).toMatchObject({ brokerage: 100_000, retirement: 0, cash: 0, total: 100_000 });
    // Negative months are preserved (sign-stacked chart renders them below zero).
    expect(points[1]).toMatchObject({ brokerage: 0, retirement: -25_000, total: -25_000 });
    // Interior gap month zero-filled by densify.
    expect(points[2]).toMatchObject({ brokerage: 0, retirement: 0, cash: 0, total: 0 });
    // Current-month consolidated row carries today's date → normalized to month-end.
    expect(points[3]).toMatchObject({ brokerage: 40_000, total: 40_000 });
    // Running totals over the densified series (all 2026 → YTD == cumulative).
    expect(points.map((p) => p.ytd_total)).toEqual([100_000, 75_000, 75_000, 115_000]);
    expect(points.map((p) => p.cumulative_total)).toEqual([100_000, 75_000, 75_000, 115_000]);
  });

  it("resets ytd_total each January while cumulative_total keeps running", () => {
    const points = assembleFlowsPlChartSeries(
      {
        brokerage: [consolidatedRow("2025-12-31", 10_000), consolidatedRow("2026-01-31", 5_000)],
        retirement: [],
        cash: [],
      },
      "month"
    );
    expect(points.map((p) => p.ytd_total)).toEqual([10_000, 5_000]);
    expect(points.map((p) => p.cumulative_total)).toEqual([10_000, 15_000]);
  });

  it("rolls up years to YYYY-12-31 with per-year sums", () => {
    const points = assembleFlowsPlChartSeries(
      {
        brokerage: [consolidatedRow("2024-02-29", 10_000), consolidatedRow("2024-07-31", 5_000)],
        retirement: [consolidatedRow("2026-01-31", -3_000)],
        cash: [],
      },
      "year"
    );
    expect(points.map((p) => p.as_of_date)).toEqual(["2024-12-31", "2025-12-31", "2026-12-31"]);
    expect(points[0]).toMatchObject({ brokerage: 15_000, total: 15_000, ytd_total: 15_000 });
    expect(points[1]).toMatchObject({ total: 0, ytd_total: 0, cumulative_total: 15_000 });
    expect(points[2]).toMatchObject({
      retirement: -3_000,
      total: -3_000,
      ytd_total: -3_000,
      cumulative_total: 12_000,
    });
  });

  it("trims leading all-zero periods (accounts predate any P/L)", () => {
    const points = assembleFlowsPlChartSeries(
      {
        brokerage: [
          consolidatedRow("2016-01-31", null),
          consolidatedRow("2016-02-29", 0),
          consolidatedRow("2016-03-31", 50_000),
        ],
        retirement: [consolidatedRow("2016-01-31", null)],
        cash: [],
      },
      "month"
    );
    expect(points.map((p) => p.as_of_date)).toEqual(["2016-03-31"]);
    expect(points[0]).toMatchObject({ brokerage: 50_000, total: 50_000 });
    expect(
      assembleFlowsPlChartSeries(
        { brokerage: [consolidatedRow("2016-01-31", null)], retirement: [], cash: [] },
        "month"
      )
    ).toEqual([]);
  });

  it("throws on non-finite nominal_pl", () => {
    expect(() =>
      assembleFlowsPlChartSeries(
        {
          brokerage: [consolidatedRow("2026-03-31", Number.NaN)],
          retirement: [],
          cash: [],
        },
        "month"
      )
    ).toThrow(/non-finite/);
  });
});

describe("flowsPlAccountPerfSummary", () => {
  it("picks the representative current-month row and sums YTD/cumulative", () => {
    chileToday.ymd = "2026-06-15";
    const summary = flowsPlAccountPerfSummary([
      // Current month: today's live row wins over the future month-end snapshot.
      perfRow("2026-06-30", 999_999),
      perfRow("2026-06-15", 12_000),
      perfRow("2026-05-31", 8_000),
      perfRow("2026-01-31", -5_000),
      perfRow("2025-12-31", 100_000),
    ]);
    expect(summary.pl_month).toBe(12_000);
    expect(summary.pl_ytd).toBe(12_000 + 8_000 - 5_000);
    expect(summary.pl_cumulative).toBe(12_000 + 8_000 - 5_000 + 100_000);
  });

  it("returns YTD 0 when the account has no current-year rows", () => {
    chileToday.ymd = "2026-06-15";
    const summary = flowsPlAccountPerfSummary([
      perfRow("2024-11-30", 70_000),
      perfRow("2024-12-31", 30_000),
    ]);
    expect(summary.pl_month).toBe(0);
    expect(summary.pl_ytd).toBe(0);
    expect(summary.pl_cumulative).toBe(100_000);
  });

  it("treats null nominal_pl months as zero", () => {
    chileToday.ymd = "2026-06-15";
    const summary = flowsPlAccountPerfSummary([
      perfRow("2026-05-31", null),
      perfRow("2026-04-30", 4_000),
    ]);
    expect(summary.pl_ytd).toBe(4_000);
    expect(summary.pl_cumulative).toBe(4_000);
  });
});

describe("buildFlowsPlPayload (test DB invariants)", () => {
  it("chart point totals equal the bucket sum and blocks sum their account rows", () => {
    chileToday.ymd = realChileToday;
    const payload = buildFlowsPlPayload();

    for (const series of [
      payload.chart_monthly,
      payload.chart_yearly,
      payload.chart_monthly_usd,
      payload.chart_yearly_usd,
    ]) {
      let year = "";
      let ytd = 0;
      let cumulative = 0;
      for (const pt of series) {
        expect(pt.total).toBeCloseTo(pt.brokerage + pt.retirement + pt.cash, 6);
        for (const v of [pt.brokerage, pt.retirement, pt.cash, pt.total]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        const y = pt.as_of_date.slice(0, 4);
        if (y !== year) {
          year = y;
          ytd = 0;
        }
        ytd += pt.total;
        cumulative += pt.total;
        expect(pt.ytd_total).toBeCloseTo(ytd, 6);
        expect(pt.cumulative_total).toBeCloseTo(cumulative, 6);
      }
    }

    expect(payload.by_bucket.map((b) => b.slug)).toEqual(FLOWS_PL_BUCKETS.map((b) => b.slug));
    for (const block of payload.by_bucket) {
      const sum = (pick: (a: (typeof block.accounts)[number]) => number) =>
        block.accounts.reduce((s, a) => s + pick(a), 0);
      expect(block.total_month_clp).toBeCloseTo(sum((a) => a.pl_month_clp), 6);
      expect(block.total_ytd_clp).toBeCloseTo(sum((a) => a.pl_ytd_clp), 6);
      expect(block.total_cumulative_clp).toBeCloseTo(sum((a) => a.pl_cumulative_clp), 6);
      expect(block.total_month_usd).toBeCloseTo(sum((a) => a.pl_month_usd), 6);
      expect(block.total_ytd_usd).toBeCloseTo(sum((a) => a.pl_ytd_usd), 6);
      expect(block.total_cumulative_usd).toBeCloseTo(sum((a) => a.pl_cumulative_usd), 6);
    }
  });

  it("latest monthly chart point matches the blocks' current-month totals", () => {
    chileToday.ymd = realChileToday;
    const payload = buildFlowsPlPayload();
    if (!payload.chart_monthly.length) return;
    const last = payload.chart_monthly[payload.chart_monthly.length - 1]!;
    const currentMk = chileDate.chileCalendarTodayYmd().slice(0, 7);
    if (last.as_of_date.slice(0, 7) !== currentMk) return;
    const bySlug = new Map(payload.by_bucket.map((b) => [b.slug, b]));
    expect(last.brokerage).toBeCloseTo(bySlug.get("brokerage")!.total_month_clp, 6);
    expect(last.retirement).toBeCloseTo(bySlug.get("retirement")!.total_month_clp, 6);
    expect(last.cash).toBeCloseTo(bySlug.get("cash")!.total_month_clp, 6);
  });
});
