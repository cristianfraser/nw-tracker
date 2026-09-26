import { describe, expect, it } from "vitest";
import { addCalendarMonths, monthEndUtcYmd } from "./calendarMonth";
import { rollupChartPointsByYear, sumChartPointsField } from "./flowsDisplay";
import { rollupDepositChartPointsByYear } from "./flowsDepositsAggregate";
import { rollupFlowsPlChartPointsByYear } from "./flowsPlAggregate";
import { clipMonthsThenRollup, clipPointsToTimeRange, timeRangeCutoffYmd } from "./timeRange";
import type { FlowDepositChartPoint, FlowsPlChartPoint } from "./types";

type Pt = { as_of_date: string; total: number };

const MONTHLY: Pt[] = [
  { as_of_date: "2024-01-31", total: 10 },
  { as_of_date: "2024-06-30", total: 20 },
  { as_of_date: "2025-01-31", total: 30 },
  { as_of_date: "2025-07-31", total: 40 },
];

/** One month-end row per month from `fromYm` through `toYm` (a densified monthly block). */
function denseMonths<T extends { as_of_date: string }>(
  fromYm: string,
  toYm: string,
  make: (asOf: string, ym: string) => T
): T[] {
  const out: T[] = [];
  for (let ym = fromYm; ym <= toYm; ym = addCalendarMonths(ym, 1)) {
    out.push(make(monthEndUtcYmd(ym), ym));
  }
  return out;
}

describe("flows Rango helpers", () => {
  it("clipPointsToTimeRange at 'total' returns identical content (Rango=Todo ≡ today)", () => {
    const clipped = clipPointsToTimeRange(MONTHLY, "total");
    expect(clipped).toEqual(MONTHLY);
    // and the range-scoped sum over all points equals the full-history figure
    expect(sumChartPointsField(clipped, "total")).toBe(sumChartPointsField(MONTHLY, "total"));
  });

  it("clipPointsToTimeRange filters to the range cutoff", () => {
    const today = "2025-07-31";
    const cutoff = timeRangeCutoffYmd("1y", today); // ~2024-07-31
    expect(cutoff).not.toBeNull();
    const clipped = clipPointsToTimeRange(MONTHLY, "1y", today);
    // 2024-01 and 2024-06 fall before the 1y cutoff; 2025-01 and 2025-07 remain
    expect(clipped.map((p) => p.as_of_date)).toEqual(["2025-01-31", "2025-07-31"]);
    expect(sumChartPointsField(clipped, "total")).toBe(70);
  });

  it("sumChartPointsField ignores non-numeric / missing fields", () => {
    const mixed = [
      { as_of_date: "2025-01-31", total: 5 },
      { as_of_date: "2025-02-28", total: Number.NaN },
      { as_of_date: "2025-03-31" } as Pt,
    ];
    expect(sumChartPointsField(mixed, "total")).toBe(5);
  });
});

describe("clipMonthsThenRollup — the one M/Y order", () => {
  const rollup = (rows: readonly Pt[]) => rollupChartPointsByYear(rows, ["total"]);
  // 1y back from 2025-05-15 is 2024-05-14: May 2024 (month-end 05-31) is the first month in.
  const TODAY = "2025-05-15";
  const months: Pt[] = [
    { as_of_date: "2024-02-29", total: 1_000 },
    { as_of_date: "2024-05-31", total: 3 },
    { as_of_date: "2024-11-30", total: 4 },
    { as_of_date: "2025-03-31", total: 5 },
  ];

  it("cuts the months at the Rango start before rolling up: a partial first year", () => {
    const years = clipMonthsThenRollup(months, "year", "1y", rollup, TODAY);
    expect(years).toEqual([
      { as_of_date: "2024-12-31", total: 7 },
      { as_of_date: "2025-12-31", total: 5 },
    ]);
    // Rolling up first would have kept 2024 whole (1_007) behind its Dec 31 label.
    expect(clipPointsToTimeRange(rollup(months), "1y", TODAY)[0]!.total).toBe(1_007);
  });

  it("returns the months themselves at month grain", () => {
    expect(clipMonthsThenRollup(months, "month", "1y", rollup, TODAY)).toEqual(months.slice(1));
  });

  it("keeps whole years under Todo", () => {
    expect(clipMonthsThenRollup(months, "year", "total", rollup, TODAY)).toEqual([
      { as_of_date: "2024-12-31", total: 1_007 },
      { as_of_date: "2025-12-31", total: 5 },
    ]);
  });
});

describe("deposits yearly chart under a Rango (the DepositsPage composition)", () => {
  const VALUES: Record<string, Partial<FlowDepositChartPoint>> = {
    "2024-02": { cash: 1_000 },
    "2024-06": { brokerage: 500 },
    "2024-07": { cash: 100 },
    "2024-11": { inversiones: 40, real_estate: 60 },
    "2025-03": { cash: 7 },
  };
  // The server's monthly block: densified month-ends, every category present.
  const monthly = denseMonths("2024-01", "2025-07", (as_of_date, ym): FlowDepositChartPoint => {
    const v = VALUES[ym] ?? {};
    const pt = {
      as_of_date,
      real_estate: v.real_estate ?? 0,
      cash: v.cash ?? 0,
      brokerage: v.brokerage ?? 0,
      inversiones: v.inversiones ?? 0,
    };
    return { ...pt, total: pt.real_estate + pt.cash + pt.brokerage + pt.inversiones };
  });
  // 1y back from 2025-07-31 is 2024-07-30: July 2024 is the first month in.
  const TODAY = "2025-07-31";

  it("gives a partial first year: the sum of that year's months inside the range", () => {
    const rows = (period: "month" | "year") =>
      clipMonthsThenRollup(monthly, period, "1y", rollupDepositChartPointsByYear, TODAY);
    const years = rows("year");
    expect(years[0]).toEqual({
      as_of_date: "2024-12-31",
      real_estate: 60,
      cash: 100,
      brokerage: 0,
      inversiones: 40,
      total: 200,
    });
    const months = rows("month");
    const monthsOf2024 = months.filter((p) => p.as_of_date.startsWith("2024-"));
    expect(monthsOf2024[0]!.as_of_date).toBe("2024-07-31");
    expect(years[0]!.total).toBe(sumChartPointsField(monthsOf2024, "total"));
    // Rolling up the full history keeps 2024 whole — what the chart used to plot.
    expect(rollupDepositChartPointsByYear(monthly)[0]!.total).toBe(1_700);
    // «En el rango» reads the same at year and month grain.
    expect(sumChartPointsField(years, "total")).toBe(sumChartPointsField(months, "total"));
    expect(sumChartPointsField(years, "total")).toBe(207);
  });
});

describe("rollupFlowsPlChartPointsByYear", () => {
  const PL: Record<string, Partial<FlowsPlChartPoint>> = {
    "2024-02": { brokerage: 10_000 },
    "2024-07": { brokerage: 5_000 },
    "2026-01": { retirement: -3_000 },
  };
  // The server's monthly block, running YTD / cumulative included.
  const monthly = (() => {
    let year = "";
    let ytd = 0;
    let cumulative = 0;
    return denseMonths("2024-02", "2026-01", (as_of_date, ym): FlowsPlChartPoint => {
      const v = PL[ym] ?? {};
      const brokerage = v.brokerage ?? 0;
      const retirement = v.retirement ?? 0;
      const total = brokerage + retirement;
      if (ym.slice(0, 4) !== year) {
        year = ym.slice(0, 4);
        ytd = 0;
      }
      ytd += total;
      cumulative += total;
      return {
        as_of_date,
        brokerage,
        retirement,
        cash: 0,
        total,
        ytd_total: ytd,
        cumulative_total: cumulative,
      };
    });
  })();

  it("sums the buckets per year; YTD is the year's total, cumulative the year-end level", () => {
    const years = rollupFlowsPlChartPointsByYear(monthly);
    expect(years.map((p) => p.as_of_date)).toEqual(["2024-12-31", "2025-12-31", "2026-12-31"]);
    expect(years[0]).toMatchObject({
      brokerage: 15_000,
      total: 15_000,
      ytd_total: 15_000,
      cumulative_total: 15_000,
    });
    expect(years[1]).toMatchObject({ total: 0, ytd_total: 0, cumulative_total: 15_000 });
    expect(years[2]).toMatchObject({
      retirement: -3_000,
      total: -3_000,
      ytd_total: -3_000,
      cumulative_total: 12_000,
    });
  });

  it("under a Rango: partial first-year bars, cumulative still in the full-history frame", () => {
    // 1y back from 2025-05-15 is 2024-05-14: February 2024 falls out, July stays.
    const years = clipMonthsThenRollup(
      monthly,
      "year",
      "1y",
      rollupFlowsPlChartPointsByYear,
      "2025-05-15"
    );
    expect(years[0]).toEqual({
      as_of_date: "2024-12-31",
      brokerage: 5_000,
      retirement: 0,
      cash: 0,
      total: 5_000,
      ytd_total: 5_000,
      // The monthly chart's own December 2024 cumulative — the level, never the clipped sum.
      cumulative_total: 15_000,
    });
    expect(years[0]!.cumulative_total).toBe(
      monthly.find((p) => p.as_of_date === "2024-12-31")!.cumulative_total
    );
  });
});
