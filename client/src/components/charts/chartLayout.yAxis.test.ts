import { describe, expect, it } from "vitest";
import { buildNiceYAxis, moneyYAxisProps, yAxisWidthForTicks } from "./chartLayout";

describe("moneyYAxisProps", () => {
  it("pairs the compact formatter with a narrower gutter than the full one", () => {
    const ticks = [0, 100_000, 200_000, 300_000, 400_000];
    const desktop = moneyYAxisProps("usd", false, ticks);
    expect(desktop.tickFormatter(350_000)).toBe("US$350.000");

    const mobile = moneyYAxisProps("usd", true, ticks);
    expect(mobile.tickFormatter(350_000)).toBe("$350k");
    expect(mobile.width).toBeLessThan(desktop.width as number);
  });

  it("sizes the gutter from the chart's own labels", () => {
    // The widest label decides, so a larger range takes a wider gutter and a negative tick
    // (formatted in parentheses) widens it too.
    const small = yAxisWidthForTicks([0, 50_000_000, 100_000_000], "clp");
    const large = yAxisWidthForTicks([0, 500_000_000, 1_000_000_000], "clp");
    const signed = yAxisWidthForTicks([-50_000_000, 0, 100_000_000], "clp");
    expect(large).toBeGreaterThan(small);
    expect(signed).toBeGreaterThan(small);
  });

  it("leaves the gutter to Recharts when the chart does not pass its ticks", () => {
    expect(moneyYAxisProps("clp").width).toBe("auto");
  });
});

describe("buildNiceYAxis mixed-sign", () => {
  it("hugs a shallow negative dip instead of snapping to a full −step gap", () => {
    // Net-worth-style series: tiny dip below zero, large positive max.
    const { domain, ticks, showZeroReference } = buildNiceYAxis(-2_500_000, 248_000_000);
    const [lo, hi] = domain;
    // Bottom clears the min by only a small pad — never the −50M a full step-floor would produce.
    expect(lo).toBeLessThanOrEqual(-2_500_000);
    expect(lo).toBeGreaterThan(-3_500_000);
    // Top still snaps up to a nice multiple of the step.
    expect(hi).toBeGreaterThanOrEqual(248_000_000);
    // Ticks are nice multiples ≥ y0; no tick is placed below the shallow dip.
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0);
    expect(ticks).toContain(0);
    expect(showZeroReference).toBe(true);
  });

  it("keeps nice negative ticks when the dip is deep relative to the step", () => {
    const { domain, ticks } = buildNiceYAxis(-100_000_000, 100_000_000);
    const [lo] = domain;
    // A genuinely large negative extent still reaches its nice tick.
    expect(lo).toBeLessThanOrEqual(-100_000_000);
    expect(ticks).toContain(-100_000_000);
    expect(ticks).toContain(0);
  });

  it("keeps a tighter ·5 step instead of overshooting on a US$304k-style max", () => {
    // Mantissa lands at ~5.07 (305k / 6 divisions): the ·10 jump would push the top to 400k.
    const { domain, ticks } = buildNiceYAxis(-1_453, 304_000);
    const step = ticks[1]! - ticks[0]!;
    expect(step).toBe(50_000);
    expect(domain[1]).toBe(350_000);
    expect(ticks).toContain(0);
    expect(ticks).toContain(300_000);
    expect(ticks).not.toContain(400_000);
  });

  it("still anchors non-negative series at 0", () => {
    const { domain, ticks, showZeroReference } = buildNiceYAxis(1_000_000, 250_000_000);
    expect(domain[0]).toBe(0);
    expect(ticks[0]).toBe(0);
    expect(showZeroReference).toBe(true);
  });
});

describe("buildNiceYAxis fineUnit", () => {
  it("fills the 0–4M low band on an expenses-style monthly range, sparse elsewhere", () => {
    // −5.2M mortgage dip, ~10M peak → coarse step 5M; the band where spend clusters gets 1M ticks.
    const { ticks, showZeroReference } = buildNiceYAxis(-5_200_000, 9_950_000, {
      fineUnit: 1_000_000,
    });
    expect(ticks).toEqual([
      -5_000_000, 0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 10_000_000,
    ]);
    expect(showZeroReference).toBe(true);
  });

  it("completes the band to uniform 1M when the coarse step is 2M (daily-style range)", () => {
    const { ticks } = buildNiceYAxis(-2_500_000, 6_000_000, { fineUnit: 1_000_000 });
    for (const t of [1_000_000, 2_000_000, 3_000_000, 4_000_000]) {
      expect(ticks).toContain(t);
    }
    expect(ticks).not.toContain(5_000_000); // above the band; next coarse tick is 6M
    expect(ticks).toContain(6_000_000);
  });

  it("skips the band on yearly-scale axes (coarse step above 5× the unit)", () => {
    // ~55M span → coarse step 10M; fine 1M ticks would squeeze into the plot floor.
    const { ticks } = buildNiceYAxis(-15_000_000, 40_000_000, { fineUnit: 1_000_000 });
    expect(ticks).not.toContain(1_000_000);
    for (const t of ticks) {
      expect(Math.abs(t % 10_000_000)).toBe(0);
    }
  });

  it("skips the band when the axis is already finer than the unit", () => {
    const { ticks } = buildNiceYAxis(0, 600_000, { fineUnit: 1_000_000 });
    expect(ticks[ticks.length - 1]!).toBeLessThanOrEqual(600_000);
    expect(ticks).not.toContain(1_000_000);
  });
});
