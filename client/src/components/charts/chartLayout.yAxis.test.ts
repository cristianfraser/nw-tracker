import { describe, expect, it } from "vitest";
import { buildNiceYAxis } from "./chartLayout";

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
