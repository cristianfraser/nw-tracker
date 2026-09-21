import { describe, expect, it } from "vitest";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import {
  attachNetWorthAth,
  getNetWorthAllTimeHigh,
  pickAllTimeHigh,
  pickAllTimeHighOnCalendarGrid,
} from "./netWorthAllTimeHigh.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";

describe("pickAllTimeHigh", () => {
  it("picks the maximum finite value and skips null / non-finite days", () => {
    expect(
      pickAllTimeHigh([
        { as_of_date: "2026-01-01", value: 10 },
        { as_of_date: "2026-01-02", value: null },
        { as_of_date: "2026-01-03", value: Number.NaN },
        { as_of_date: "2026-01-04", value: 30 },
        { as_of_date: "2026-01-05", value: 20 },
      ])
    ).toEqual({ as_of_date: "2026-01-04", value: 30 });
  });

  it("resolves a tie to the earliest day regardless of input order", () => {
    const asc = [
      { as_of_date: "2026-02-01", value: 5 },
      { as_of_date: "2026-02-02", value: 9 },
      { as_of_date: "2026-02-03", value: 9 },
    ];
    expect(pickAllTimeHigh(asc)).toEqual({ as_of_date: "2026-02-02", value: 9 });
    expect(pickAllTimeHigh([...asc].reverse())).toEqual({ as_of_date: "2026-02-02", value: 9 });
  });

  it("is null when no day has a finite value", () => {
    expect(pickAllTimeHigh([])).toBeNull();
    expect(pickAllTimeHigh([{ as_of_date: "2026-01-01", value: null }])).toBeNull();
  });

  it("reads a live record day as today's ATH (last point wins when it is the max)", () => {
    expect(
      pickAllTimeHigh([
        { as_of_date: "2026-03-01", value: 1 },
        { as_of_date: "2026-03-02", value: 2 },
      ])
    ).toEqual({ as_of_date: "2026-03-02", value: 2 });
  });
});

describe("pickAllTimeHighOnCalendarGrid", () => {
  const rows = [
    { as_of_date: "2026-05-31", total_nw: 100 },
    // A mid-month snapshot above the month-end: the month grid plots the month-end, so the
    // snapshot must not win the month peak.
    { as_of_date: "2026-06-08", total_nw: 130 },
    { as_of_date: "2026-06-30", total_nw: 120 },
    { as_of_date: "2026-07-31", total_nw: 110 },
  ];

  it("month: the latest row of each month competes, reported with its own date", () => {
    expect(pickAllTimeHighOnCalendarGrid(rows, "total_nw", "month")).toEqual({
      as_of_date: "2026-06-30",
      value: 120,
    });
  });

  it("year: only the latest row of each year competes (the rollup's year-end value)", () => {
    const years = [
      { as_of_date: "2025-06-30", total_nw: 500 },
      { as_of_date: "2025-12-31", total_nw: 200 },
      { as_of_date: "2026-03-31", total_nw: 300 },
    ];
    expect(pickAllTimeHighOnCalendarGrid(years, "total_nw", "year")).toEqual({
      as_of_date: "2026-03-31",
      value: 300,
    });
  });

  it("ignores rows without a date or a finite value", () => {
    expect(
      pickAllTimeHighOnCalendarGrid(
        [{ as_of_date: "", total_nw: 9 }, { as_of_date: "2026-01-31", total_nw: null }],
        "total_nw",
        "month"
      )
    ).toBeNull();
  });
});

describe("getNetWorthAllTimeHigh (test DB)", () => {
  it("is the peak of the full-history daily walk and is echoed on both dashboard payloads", () => {
    const daily = getDashboardOverviewDaily("clp", 0);
    const expected = pickAllTimeHigh(
      daily.points.map((p) => ({ as_of_date: p.as_of_date, value: p.net_worth }))
    );
    expect(expected).not.toBeNull();

    expect(getNetWorthAllTimeHigh("clp")).toEqual(expected);
    expect(daily.ath).toEqual(expected);

    const ts = attachNetWorthAth(getDashboardValuationTimeseries("clp"), "clp");
    expect(ts.overview.ath.day).toEqual(expected);
    // Month-end points are marks on days of the same daily grid, so none can exceed the peak
    // (a peso of rounding tolerated, as in the daily↔monthly parity test).
    for (const p of ts.overview.points) {
      const v = p.total_nw;
      if (typeof v === "number" && Number.isFinite(v)) {
        expect(v).toBeLessThanOrEqual(expected!.value + 2);
      }
    }
  });

  it("month and year peaks are plotted rows of the monthly chart, nested day ≥ month ≥ year", () => {
    const ts = attachNetWorthAth(getDashboardValuationTimeseries("clp"), "clp");
    const { day, month, year } = ts.overview.ath;
    expect(day).not.toBeNull();
    expect(month).not.toBeNull();
    expect(year).not.toBeNull();
    const byDate = new Map(ts.overview.points.map((p) => [String(p.as_of_date), p.total_nw]));
    // Each grain's peak is one of the chart's own points, at that point's value.
    expect(byDate.get(month!.as_of_date)).toBe(month!.value);
    expect(byDate.get(year!.as_of_date)).toBe(year!.value);
    // Year-end rows ⊂ month rows ⊂ daily grid days (a peso of rounding tolerated).
    expect(year!.value).toBeLessThanOrEqual(month!.value + 2);
    expect(month!.value).toBeLessThanOrEqual(day!.value + 2);
  });

  it("the USD peak converts each day at its own fx (its own day, its own value)", () => {
    const usd = getNetWorthAllTimeHigh("usd");
    expect(usd).not.toBeNull();
    expect(Number.isFinite(usd!.value)).toBe(true);
    const daily = getDashboardOverviewDaily("usd", 0);
    expect(daily.ath).toEqual(usd);
    expect(
      pickAllTimeHigh(daily.points.map((p) => ({ as_of_date: p.as_of_date, value: p.net_worth })))
    ).toEqual(usd);
  });
});
