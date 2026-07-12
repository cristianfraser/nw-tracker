import { describe, expect, it } from "vitest";
import { phi, phiInv } from "./normalDist.js";

describe("phi (standard normal CDF)", () => {
  it("matches known values", () => {
    expect(phi(0)).toBeCloseTo(0.5, 7);
    expect(phi(1.959963985)).toBeCloseTo(0.975, 6);
    expect(phi(-1.959963985)).toBeCloseTo(0.025, 6);
    expect(phi(1)).toBeCloseTo(0.8413447461, 6);
    expect(phi(-2.326347874)).toBeCloseTo(0.01, 6);
    expect(phi(3.090232306)).toBeCloseTo(0.999, 6);
  });

  it("throws on non-finite input", () => {
    expect(() => phi(Number.NaN)).toThrow();
    expect(() => phi(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("phiInv (inverse standard normal CDF)", () => {
  it("matches known quantiles", () => {
    expect(phiInv(0.5)).toBeCloseTo(0, 9);
    expect(phiInv(0.975)).toBeCloseTo(1.959963985, 6);
    expect(phiInv(0.025)).toBeCloseTo(-1.959963985, 6);
    expect(phiInv(0.99)).toBeCloseTo(2.326347874, 6);
    expect(phiInv(0.9)).toBeCloseTo(1.281551566, 6);
    expect(phiInv(0.855)).toBeCloseTo(1.058122, 5);
  });

  it("round-trips through phi across the domain", () => {
    for (const p of [0.0001, 0.001, 0.01, 0.02425, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97575, 0.99, 0.999, 0.9999]) {
      expect(phi(phiInv(p))).toBeCloseTo(p, 6);
    }
  });

  it("throws outside (0, 1)", () => {
    expect(() => phiInv(0)).toThrow();
    expect(() => phiInv(1)).toThrow();
    expect(() => phiInv(-0.1)).toThrow();
    expect(() => phiInv(1.1)).toThrow();
    expect(() => phiInv(Number.NaN)).toThrow();
  });
});
