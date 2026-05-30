import { describe, expect, it } from "vitest";
import {
  formatAutoDepositMatchNote,
  isAutoDepositMatchedPurchaseNote,
  mergeAutoDepositMatchNote,
  parseAutoDepositMatchNote,
} from "./ccExpenseDepositMatchNotes.js";

describe("ccExpenseDepositMatchNotes", () => {
  const sampleDeposit = {
    occurred_on: "2017-11-27",
    amount_clp: 30_000,
    account_id: 41,
    category_slug: "cuenta_vista",
    group_slug: "cash_eqs",
  };

  it("formats and parses auto deposit match notes", () => {
    const note = formatAutoDepositMatchNote([{ deposit: sampleDeposit, amount_clp: 30_000 }]);
    expect(note).toBe("auto:deposit-match|acct:41|date:2017-11-27|amt:30000");
    expect(isAutoDepositMatchedPurchaseNote(note)).toBe(true);
    expect(parseAutoDepositMatchNote(note)).toEqual([
      { account_id: 41, occurred_on: "2017-11-27", amount_clp: 30_000 },
    ]);
  });

  it("merges multiple deposit segments", () => {
    const note = formatAutoDepositMatchNote([
      { deposit: sampleDeposit, amount_clp: 36_000 },
      {
        deposit: { ...sampleDeposit, account_id: 42, occurred_on: "2017-11-15" },
        amount_clp: 30_000,
      },
    ]);
    expect(parseAutoDepositMatchNote(note)).toHaveLength(2);
  });

  it("replaces stale auto line and keeps user suffix", () => {
    const old =
      "auto:deposit-match|acct:1|date:2017-01-01|amt:1000\n\nrevisar falso positivo";
    const next = formatAutoDepositMatchNote([{ deposit: sampleDeposit, amount_clp: 30_000 }]);
    expect(mergeAutoDepositMatchNote(old, next)).toBe(
      `${next}\n\nrevisar falso positivo`
    );
  });

  it("prepends auto line to plain user note", () => {
    const next = formatAutoDepositMatchNote([{ deposit: sampleDeposit, amount_clp: 30_000 }]);
    expect(mergeAutoDepositMatchNote("nota manual", next)).toBe(`${next}\n\nnota manual`);
  });
});
