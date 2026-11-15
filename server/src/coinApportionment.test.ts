import { describe, expect, it } from "vitest";
import { apportionToCoin } from "./coinApportionment.js";

/** Synthetic amounts only. Coins: a peso has none smaller, a dollar and a euro have cents. */
const cents = (v: number | null) => (v == null ? null : Math.round(v * 100));

describe("apportionToCoin — a total beside its parts", () => {
  it("rounds the total once and hands the leftover cent to the largest remainder (dollars)", () => {
    // 60.013 → 60.01. Floored: 10.00 + 20.00 + 30.00 = 60.00; the cent left goes to .6 of a cent.
    const { total, parts } = apportionToCoin([10.006, 20.004, 30.003], "usd");
    expect(total).toBe(60.01);
    expect(parts).toEqual([10.01, 20, 30]);
    // Rounding each part alone would print 10.01 + 20.00 + 30.00 too, but here: 0.006 × 3.
    const drift = apportionToCoin([0.006, 0.006, 0.006], "eur");
    expect(drift.total).toBe(0.02);
    expect(drift.parts.map(cents).reduce((s: number, c) => s + c!, 0)).toBe(2);
    expect(drift.parts).toEqual([0.01, 0.01, 0]);
  });

  it("the parts always add up to the total at the coin, in pesos too", () => {
    const pesos = apportionToCoin([1_000.4, 2_000.3, 0.7], "clp");
    expect(pesos.total).toBe(3_001);
    expect(pesos.parts).toEqual([1_000, 2_000, 1]);
    // Equal remainders: the earlier part takes the coin.
    expect(apportionToCoin([0.5, 0.5], "clp")).toEqual({ total: 1, parts: [1, 0] });
  });

  it("amounts that are whole cents already come out as they went in", () => {
    expect(apportionToCoin([10.29, 5.1, 0.07], "usd")).toEqual({ total: 15.46, parts: [10.29, 5.1, 0.07] });
  });

  it("a null part stays null and takes no share", () => {
    const { total, parts } = apportionToCoin([10.006, null, 30.007], "usd");
    expect(parts[1]).toBeNull();
    expect(total).toBe(40.01);
    expect(parts).toEqual([10, null, 30.01]);
    expect(apportionToCoin([null, null], "usd")).toEqual({ total: null, parts: [null, null] });
  });

  it("a negative part (a node that nets what the cards owe) is apportioned like any other", () => {
    // 100.006 − 40.003 = 60.003 → 60.00; the parts floor to 100.00 and −40.01, one cent to hand out.
    const { total, parts } = apportionToCoin([100.006, -40.003], "usd");
    expect(total).toBe(60);
    expect(parts).toEqual([100, -40]);
    expect(cents(parts[0]!)! + cents(parts[1]!)!).toBe(cents(total));
  });

  it("with a total fixed one level up, the parts add up to it", () => {
    // The sum is 3.008: a parent may have handed this frame 3.00 or 3.01.
    expect(apportionToCoin([1.004, 2.004], "usd", { total: 3.01 }).parts.map(cents)).toEqual([101, 200]);
    expect(apportionToCoin([1.004, 2.004], "usd", { total: 3 }).parts.map(cents)).toEqual([100, 200]);
    expect(apportionToCoin([1.004, 2.004], "usd", { total: 3.01 }).total).toBe(3.01);
  });

  it("refuses a total the parts do not round to, or one that is not whole coins", () => {
    expect(() => apportionToCoin([1.004, 2.004], "usd", { total: 3.05 })).toThrow(/does not round to the total/);
    expect(() => apportionToCoin([1.004, 2.004], "usd", { total: 2.99 })).toThrow(/does not round to the total/);
    expect(() => apportionToCoin([1.004, 2.004], "usd", { total: 3.005 })).toThrow(/not a whole number of usd coins/);
    expect(() => apportionToCoin([null], "usd", { total: 1 })).toThrow(/no part to carry it/);
    expect(() => apportionToCoin([Number.NaN], "usd")).toThrow(/not a finite number/);
  });
});
