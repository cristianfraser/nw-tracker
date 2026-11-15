import { describe, expect, it } from "vitest";
import { sameCoin } from "./money.js";
import { seededRandom } from "./seededRandom.js";

describe("sameCoin", () => {
  it("pesos agree to the peso, dollars to the cent", () => {
    expect(sameCoin(1000.4, 1000, "clp")).toBe(true);
    expect(sameCoin(1001, 1000, "clp")).toBe(false);
    expect(sameCoin(100.004, 100, "usd")).toBe(true);
    expect(sameCoin(100.01, 100, "usd")).toBe(false);
  });

  it("is the former per-currency rounding for pesos and dollars", () => {
    const old = (currency: string, a: number, b: number) =>
      currency === "usd" ? Math.round(a * 100) === Math.round(b * 100) : Math.round(a) === Math.round(b);
    const r = seededRandom(7);
    for (let i = 0; i < 2000; i++) {
      const currency = r.next() < 0.5 ? "clp" : "usd";
      const a = Math.round(r.next() * 200000) / 100;
      const b = r.next() < 0.5 ? a + (Math.round(r.next() * 200) - 100) / 100 : a;
      expect(sameCoin(a, b, currency), `${currency} ${a} ${b}`).toBe(old(currency, a, b));
    }
  });

  it("throws for a code that is not a currency", () => {
    expect(() => sameCoin(1, 1, "zzz")).toThrow();
  });
});
