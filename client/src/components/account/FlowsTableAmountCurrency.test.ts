import { describe, expect, it } from "vitest";
import { amountFilterCurrencyCodes } from "./FlowsTable";

describe("amountFilterCurrencyCodes", () => {
  it("lists every loaded currency in the server's order", () => {
    expect(amountFilterCurrencyCodes(["clp", "eur", "usd", "gbp"], "clp")).toEqual(["clp", "eur", "usd", "gbp"]);
  });

  it("keeps the current choice listed, also before the currencies load", () => {
    expect(amountFilterCurrencyCodes(undefined, "clp")).toEqual(["clp"]);
    expect(amountFilterCurrencyCodes(["clp", "usd"], "eur")).toEqual(["clp", "usd", "eur"]);
  });
});
