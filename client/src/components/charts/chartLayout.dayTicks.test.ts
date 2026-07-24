import { describe, expect, it } from "vitest";
import { computeRegularDayXAxisTicks, resolvePeriodXAxis } from "./chartLayout";
import { formatDayMonthShortLabel } from "../../formatDateLabel";

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
  it("spaces ticks by whole days so every label is a distinct date", () => {
    const dates = calendarDays("2026-05-01", 90);
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(true);
    expect(ticks!.length).toBeLessThanOrEqual(12);
    expect(ticks!.length).toBeGreaterThan(2);
    // Every tick is a real grid day, ascending, with no repeats.
    for (const tick of ticks!) expect(dates).toContain(tick);
    expect([...ticks!].sort()).toEqual(ticks);
    expect(new Set(ticks).size).toBe(ticks!.length);
    // The rendered labels are distinct too (the bug: month labels repeated per tick).
    const labels = ticks!.map(formatDayMonthShortLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps labels distinct across a 1y daily window", () => {
    const dates = calendarDays("2025-07-25", 366);
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(true);
    const labels = ticks!.map(formatDayMonthShortLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(ticks!.length).toBeLessThanOrEqual(12);
  });

  it("falls back to month boundaries beyond the day-label span", () => {
    const dates = calendarDays("2020-01-01", 1200);
    const { ticks, withDay } = computeRegularDayXAxisTicks(dates);
    expect(withDay).toBe(false);
    expect(ticks!.length).toBeGreaterThan(0);
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
