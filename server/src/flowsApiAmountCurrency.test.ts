import { describe, expect, it } from "vitest";
import { applyFlowFilters, parseExtraFlowsFilterParams, type FlowsApiRow } from "./flowsApi.js";

function row(over: Partial<FlowsApiRow>): FlowsApiRow {
  return {
    occurred_on: "2026-01-10",
    amount: 100,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    ...over,
  } as FlowsApiRow;
}

describe("flows amount_currency filter", () => {
  it("accepts any loaded currency code and refuses others", () => {
    const eur = parseExtraFlowsFilterParams({ amount_currency: "eur" });
    expect(eur).toEqual({ ok: true, filters: { amount_currency: "eur" } });
    expect(parseExtraFlowsFilterParams({ amount_currency: "usd" }).ok).toBe(true);
    expect(parseExtraFlowsFilterParams({ amount_currency: "xyz" }).ok).toBe(false);
    expect(parseExtraFlowsFilterParams({ amount_currency: "uf" }).ok).toBe(false);
  });

  it("compares the leg in the filter currency, either side of a conversion", () => {
    const rows = [
      row({ amount: 50, currency: "eur" }),
      row({ amount: 52_000, currency: "clp", counter_amount: 50, counter_currency: "eur" }),
      row({ amount: 50, currency: "usd" }),
      row({ amount: 50, currency: "clp" }),
    ];
    const out = applyFlowFilters(rows, { amount_exact: 50, amount_currency: "eur" });
    expect(out).toEqual([rows[0], rows[1]]);
  });
});
