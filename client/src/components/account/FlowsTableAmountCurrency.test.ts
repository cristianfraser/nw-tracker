import { describe, expect, it } from "vitest";
import { amountFilterCurrencyCodes } from "./FlowsTable";

describe("amountFilterCurrencyCodes", () => {
  it("lists every loaded currency, pesos and dollars first", () => {
    expect(amountFilterCurrencyCodes(["eur", "usd", "clp", "gbp"], "clp")).toEqual(["clp", "usd", "eur", "gbp"]);
  });

  it("falls back to pesos and dollars, keeping the current choice", () => {
    expect(amountFilterCurrencyCodes(undefined, "clp")).toEqual(["clp", "usd"]);
    expect(amountFilterCurrencyCodes(undefined, "eur")).toEqual(["clp", "usd", "eur"]);
  });
});
