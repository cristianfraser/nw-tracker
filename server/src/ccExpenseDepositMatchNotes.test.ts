import { describe, expect, it } from "vitest";
import {
  depositMatchSegments,
  formatAutoDepositMatchNote,
  isAutoDepositMatchedPurchaseNote,
  mergeAutoDepositMatchNote,
} from "./ccExpenseDepositMatchNotes.js";

describe("ccExpenseDepositMatchNotes", () => {
  const sampleDeposit = {
    occurred_on: "2017-11-27",
    amount_clp: 30_000,
    account_id: 41,
    category_slug: "cuenta_vista",
    group_slug: "cash_eqs",
    movement_id: null,
  };

  it("keeps the match as data and words it for the note", () => {
    const segments = depositMatchSegments([{ deposit: sampleDeposit, amount_clp: 30_000 }]);
    expect(segments).toEqual([{ account_id: 41, occurred_on: "2017-11-27", amount_clp: 30_000, movement_id: null }]);
    const note = formatAutoDepositMatchNote(segments);
    expect(note).toBe("auto:deposit-match|acct:41|date:2017-11-27|amt:30000");
    expect(isAutoDepositMatchedPurchaseNote(note)).toBe(true);
  });

  it("one segment per deposit that took pesos", () => {
    const segments = depositMatchSegments([
      { deposit: sampleDeposit, amount_clp: 36_000 },
      { deposit: { ...sampleDeposit, account_id: 42, occurred_on: "2017-11-15", movement_id: 9 }, amount_clp: 30_000 },
      { deposit: sampleDeposit, amount_clp: 0 },
    ]);
    expect(segments).toHaveLength(2);
    expect(formatAutoDepositMatchNote(segments)).toBe(
      "auto:deposit-match|acct:41|date:2017-11-27|amt:36000|acct:42|date:2017-11-15|amt:30000|mov:9"
    );
  });

  it("replaces stale auto line and keeps user suffix", () => {
    const old =
      "auto:deposit-match|acct:1|date:2017-01-01|amt:1000\n\nrevisar falso positivo";
    const next = formatAutoDepositMatchNote(depositMatchSegments([{ deposit: sampleDeposit, amount_clp: 30_000 }]));
    expect(mergeAutoDepositMatchNote(old, next)).toBe(
      `${next}\n\nrevisar falso positivo`
    );
  });

  it("prepends auto line to plain user note", () => {
    const next = formatAutoDepositMatchNote(depositMatchSegments([{ deposit: sampleDeposit, amount_clp: 30_000 }]));
    expect(mergeAutoDepositMatchNote("nota manual", next)).toBe(`${next}\n\nnota manual`);
  });
});
