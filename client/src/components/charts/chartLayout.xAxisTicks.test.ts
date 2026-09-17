import { describe, expect, it } from "vitest";
import {
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
} from "./chartLayout";

function monthEndSeries(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let [y, m] = fromYm.split("-").map(Number);
  const [y1, m1] = toYm.split("-").map(Number);
  for (let guard = 0; guard < 500; guard++) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`);
    if (y === y1 && m === m1) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

describe("computeRegularMonthXAxisTicks", () => {
  it("uses January year markers (not anchor month) for multi-year spans", () => {
    const dates = monthEndSeries("2017-05", "2026-06");
    const ticks = computeRegularMonthXAxisTicks(dates)!;

    expect(ticks.filter((d) => d.endsWith("-01-31")).length).toBeGreaterThanOrEqual(8);
    expect(ticks).not.toContain("2018-05-31");
    expect(ticks).not.toContain("2019-05-31");
  });

  it("adds first and last dates when there is room under maxTickCount", () => {
    const dates = monthEndSeries("2017-05", "2026-06");
    const ticks = computeRegularMonthXAxisTicks(dates)!;

    expect(ticks[0]).toBe("2017-05-31");
    expect(ticks[ticks.length - 1]).toBe("2026-06-30");
    expect(ticks).toContain("2026-01-31");
    expect(ticks).not.toContain("2025-12-31");
    expect(ticks.length).toBeLessThanOrEqual(14);
  });

  it("omits last boundary when includeLastDataPoint is false", () => {
    const dates = monthEndSeries("2017-05", "2026-06");
    const ticks = computeRegularMonthXAxisTicks(dates, { includeLastDataPoint: false })!;

    expect(ticks).toContain("2017-05-31");
    expect(ticks).not.toContain("2026-06-30");
    expect(ticks).toContain("2026-01-31");
  });

  it("keeps month-stride ticks for spans shorter than a year", () => {
    const dates = monthEndSeries("2024-03", "2024-11");
    const ticks = computeRegularMonthXAxisTicks(dates, { minTickCount: 4, maxTickCount: 8 })!;

    expect(ticks.some((d) => d.startsWith("2024-03"))).toBe(true);
    expect(ticks.every((d) => d.startsWith("2024-"))).toBe(true);
  });

  it("phases sub-year strides on January, not on the series' first month", () => {
    // A 3y P/L window starting in April: a walk from the first point read abr/ago/dic.
    const dates = monthEndSeries("2024-04", "2026-09");
    const ticks = computeRegularMonthXAxisTicks(dates)!;

    expect(ticks).toEqual([
      "2024-05-31",
      "2024-09-30",
      "2025-01-31",
      "2025-05-31",
      "2025-09-30",
      "2026-01-31",
      "2026-05-31",
      "2026-09-30",
    ]);
  });

  it("keeps every January on a 3-month stride too (ene/abr/jul/oct), whatever the start month", () => {
    // 28 months from June: a 4-month stride would leave 7 ticks, so the 3-month one is picked.
    const ticks = computeRegularMonthXAxisTicks(monthEndSeries("2024-06", "2026-09"), {
      includeLastDataPoint: false,
    })!;
    expect(ticks).toEqual([
      "2024-07-31",
      "2024-10-31",
      "2025-01-31",
      "2025-04-30",
      "2025-07-31",
      "2025-10-31",
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
    ]);
  });

  it("puts a daily grid's month ticks on the first day of the phased months", () => {
    const days: string[] = [];
    let t = Date.parse("2025-08-01T00:00:00Z");
    while (days.length < 800) {
      days.push(new Date(t).toISOString().slice(0, 10));
      t += 86_400_000;
    }
    const ticks = computeRegularMonthXAxisTicks(days, { includeLastDataPoint: false })!;
    expect(ticks[0]).toBe("2025-10-01");
    expect(ticks).toContain("2026-01-01");
    expect(ticks).toContain("2027-01-01");
    for (const tick of ticks) expect(tick.slice(8, 10)).toBe("01");
  });
});

describe("computeRegularYearXAxisTicks", () => {
  it("prefers January (then December) over arbitrary in-year dates", () => {
    const dates = [
      "2017-05-15",
      "2017-12-31",
      "2018-06-30",
      "2018-12-31",
      "2019-01-31",
      "2019-11-30",
      "2020-12-31",
    ];
    const ticks = computeRegularYearXAxisTicks(dates)!;

    // Head year has no January → covered by the first data point, not dic 2017.
    expect(ticks).toContain("2017-05-15");
    expect(ticks).not.toContain("2017-12-31");
    expect(ticks).toContain("2018-12-31");
    expect(ticks).toContain("2019-01-31");
    expect(ticks).toContain("2020-12-31");
    expect(ticks).not.toContain("2018-06-30");
  });

  it("phases multi-year strides on round years", () => {
    // 2013 → 2031: a 2-year stride marks even years, whatever year the series starts in.
    const dates: string[] = [];
    for (let y = 2013; y <= 2031; y++) dates.push(`${y}-01-31`, `${y}-12-31`);
    const ticks = computeRegularYearXAxisTicks(dates, {
      minTickCount: 8,
      maxTickCount: 14,
      includeLastDataPoint: false,
    })!;
    const years = ticks.map((d) => Number(d.slice(0, 4)));
    expect(ticks).toContain("2014-01-31");
    expect(ticks).toContain("2030-01-31");
    expect(ticks).not.toContain("2015-01-31");
    // Only the first-data-point push may sit off-phase.
    expect(years.filter((y) => y % 2 === 1)).toEqual([2013]);
  });
});
