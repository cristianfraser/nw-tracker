import { describe, expect, it } from "vitest";
import { brokerAdapter, brokerPlanRow } from "./brokerAdapter.js";

describe("broker adapters", () => {
  it("look for a bank-listed deposit debit up to the window each broker's mail lags", () => {
    expect(brokerAdapter("fintual").depositFromMail.debitWindowEnd("2026-03-10")).toBe("2026-03-15");
    // Tuesday → the business day after Wednesday.
    expect(brokerAdapter("racional").depositFromMail.debitWindowEnd("2026-03-10")).toBe("2026-03-12");
  });

  it("reports one plan row shape for every broker", () => {
    const base = {
      source: { kind: "deposit" },
      occurred_on: "2026-03-10",
      amount: 1000,
      currency: "clp",
      from_account_id: 1,
      to_account_id: 2,
      units_delta: null,
      counter_amount: null,
      duplicate_of: null,
      requires_manual: null,
      create_account: null,
    };
    expect(brokerPlanRow(base)).toMatchObject({ state: "new", legs: "1 → 2", detail: null });
    expect(brokerPlanRow({ ...base, duplicate_of: 7 })).toMatchObject({ state: "duplicate", detail: "already in the ledger as movement 7" });
    expect(brokerPlanRow({ ...base, synthesized: true }).state).toBe("synthesized");
    expect(brokerPlanRow({ ...base, create_account: { ticker: "SPY", bucket_slug: "b" } }).detail).toBe("creates the SPY position in b");
  });
});
