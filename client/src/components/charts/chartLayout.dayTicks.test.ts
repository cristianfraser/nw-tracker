import { describe, expect, it } from "vitest";
import { computeRegularDayXAxisTicks, resolvePeriodXAxis } from "./chartLayout";
import { formatDayMonthShortLabel, formatMonthYearShortLabel } from "../../formatDateLabel";

function calendarDays(startYmd: string, count: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${startYmd}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

describe("computeRegularDayXAxisTicks", () => {
  it("puts a tick on the first day of each month", () => {
    const dates = calendarDays("2026-01-15", 150); // mid-Jan → mid-Jun
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(false); // month labels, not day-precision
    expect(ticks).toEqual(["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
  });

  it("thins to every Nth month start on a long window, keeping the newest tick", () => {
    const dates = calendarDays("2020-01-01", 1200); // ~39 months
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(false);
    expect(ticks!.length).toBeLessThanOrEqual(12);
    // Every tick is still a month start, ascending and unique.
    for (const tick of ticks!) expect(tick.slice(8, 10)).toBe("01");
    expect([...ticks!].sort()).toEqual(ticks);
    expect(new Set(ticks).size).toBe(ticks!.length);
    // Evenly spaced in months, and the last month start in the grid is labelled.
    expect(ticks![ticks!.length - 1]).toBe("2023-04-01");
    const labels = ticks!.map(formatMonthYearShortLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels a 1y window at every month start", () => {
    const dates = calendarDays("2025-07-25", 366);
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(false);
    expect(ticks!.length).toBeLessThanOrEqual(12);
    for (const tick of ticks!) expect(tick.slice(8, 10)).toBe("01");
    const labels = ticks!.map(formatMonthYearShortLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to a day stride when the window holds too few month starts", () => {
    // 30d ranges span one month boundary at most — month ticks would leave the axis bare.
    const dates = calendarDays("2026-06-24", 31);
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(true);
    expect(ticks!.length).toBeGreaterThan(2);
    for (const tick of ticks!) expect(dates).toContain(tick);
    const labels = ticks!.map(formatDayMonthShortLabel);
    expect(new Set(labels).size).toBe(labels.length);
    // The newest day is always labelled.
    expect(ticks![ticks!.length - 1]).toBe(dates[dates.length - 1]);
  });

  it("handles a single-day grid", () => {
    const { ticks, withDay } = computeRegularDayXAxisTicks(["2026-07-24"]);
    expect(ticks).toEqual(["2026-07-24"]);
    expect(withDay).toBe(true);
  });
});

describe("resolvePeriodXAxis", () => {
  it("day: date-precision tick labels + ISO tooltip titles", () => {
    const dates = calendarDays("2026-05-01", 60);
    const axis = resolvePeriodXAxis(dates, "day");
    expect(axis.formatTick("2026-05-16")).toBe(formatDayMonthShortLabel("2026-05-16"));
    expect(axis.formatTick("2026-05-16")).toMatch(/\d+$/); // carries the day number
    expect(axis.formatTooltipTitle("2026-05-16")).toBe("2026-05-16");
  });

  it("month/year keep their existing boundary ticks and labels", () => {
    const monthEnds = ["2026-01-31", "2026-02-28", "2026-03-31"];
    const axis = resolvePeriodXAxis(monthEnds, "month");
    expect(axis.formatTick("2026-01-31")).not.toMatch(/ 31$/);
    const yearly = resolvePeriodXAxis(["2024-12-31", "2025-12-31"], "year");
    expect(yearly.formatTick("2025-12-31")).toBe("2025");
  });
});
