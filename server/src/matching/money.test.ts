import { describe, expect, it } from "vitest";
import { sameCoin } from "./money.js";

describe("sameCoin", () => {
  it("pesos agree to the peso, dollars to the cent", () => {
    expect(sameCoin(1000.4, 1000, "clp")).toBe(true);
    expect(sameCoin(1001, 1000, "clp")).toBe(false);
    expect(sameCoin(100.004, 100, "usd")).toBe(true);
    expect(sameCoin(100.01, 100, "usd")).toBe(false);
  });

  it("throws for a code that is not a currency", () => {
    expect(() => sameCoin(1, 1, "zzz")).toThrow();
  });
});
