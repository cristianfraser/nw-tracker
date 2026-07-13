import { describe, expect, it } from "vitest";
import { PERCENTILE_LOG_TOP_PCT_FLOOR, percentileLogAxisFor, topPercentOf } from "./percentileLogAxis";

describe("topPercentOf", () => {
  it("maps a percentile to its distance from 100", () => {
    expect(topPercentOf(50)).toBe(50);
    expect(topPercentOf(90)).toBe(10);
    expect(topPercentOf(99)).toBeCloseTo(1);
    expect(topPercentOf(96.2)).toBeCloseTo(3.8);
  });

  it("clamps a percentile of exactly 100 to the log floor so it stays plottable", () => {
    expect(topPercentOf(100)).toBe(PERCENTILE_LOG_TOP_PCT_FLOOR);
    expect(topPercentOf(100.5)).toBe(PERCENTILE_LOG_TOP_PCT_FLOOR);
  });

  it("caps the bottom at 100 (a zero/negative percentile)", () => {
    expect(topPercentOf(0)).toBe(100);
    expect(topPercentOf(-5)).toBe(100);
  });
});

describe("percentileLogAxisFor", () => {
  it("snaps the domain floor down to the nearest tick candidate below the best point", () => {
    // Best percentile ~96.2 → top-% 3.8 → floor 2 (shows up to p98 at the top).
    const { domain, ticks } = percentileLogAxisFor(3.8);
    expect(domain).toEqual([2, 100]);
    expect(ticks).toContain(2);
    expect(ticks).toContain(100);
    // Ticks below the floor are dropped, and they read back as clean percentiles.
    expect(ticks).not.toContain(1);
    expect(ticks.map((t) => 100 - t)).toEqual(expect.arrayContaining([0, 50, 90, 95, 98]));
  });

  it("keeps ascending ticks within the domain for a deep top point", () => {
    const { domain, ticks } = percentileLogAxisFor(0.4);
    expect(domain).toEqual([0.2, 100]);
    expect(ticks[0]).toBe(0.2);
    expect(ticks[ticks.length - 1]).toBe(100);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it("never floors below the log floor and tolerates non-finite input", () => {
    expect(percentileLogAxisFor(0.01).domain[0]).toBe(PERCENTILE_LOG_TOP_PCT_FLOOR);
    expect(percentileLogAxisFor(Number.NaN).domain).toEqual([100, 100]);
  });
});
