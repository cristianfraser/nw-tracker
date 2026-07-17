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
});
