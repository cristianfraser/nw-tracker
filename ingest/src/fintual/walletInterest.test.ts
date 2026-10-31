import { describe, expect, it } from "vitest";
import { decodeFintualCashInterests } from "./walletInterest.js";

describe("decodeFintualCashInterests", () => {
  it("reads each credit as a usd interest movement on Fintual's day", () => {
    const rows = decodeFintualCashInterests({
      stocksWalletCashInterests: [
        { id: "289019", createdAt: "2030-10-30T20:37:32-03:00", date: "2030-10-30", amount: 0.4, __typename: "StocksCashInterest" },
        { id: "196652", createdAt: "2030-06-30T18:44:01-04:00", date: "2030-06-30", amount: 0.02, __typename: "StocksCashInterest" },
      ],
    });
    expect(rows.map((r) => [r.movement_id, r.kind, r.occurred_on, r.occurred_at, r.amount, r.currency])).toEqual([
      ["fintual-cash-interest:289019", "interest", "2030-10-30", "2030-10-30T20:37:32-03:00", 0.4, "usd"],
      ["fintual-cash-interest:196652", "interest", "2030-06-30", "2030-06-30T18:44:01-04:00", 0.02, "usd"],
    ]);
  });

  it("throws on a changed shape instead of reading no interest", () => {
    expect(() => decodeFintualCashInterests({})).toThrow(/missing/);
    expect(() => decodeFintualCashInterests({ stocksWalletCashInterests: [{ id: "1", date: "2030-10-30", createdAt: "2030-10-30T20:00:00Z", amount: "0.4" }] })).toThrow(/amount/);
    expect(() => decodeFintualCashInterests({ stocksWalletCashInterests: [{ id: "1", date: "30/10/30", createdAt: "2030-10-30T20:00:00Z", amount: 0.4 }] })).toThrow(/date/);
  });
});
