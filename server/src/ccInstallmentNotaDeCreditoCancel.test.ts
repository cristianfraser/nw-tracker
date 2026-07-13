import { describe, expect, it } from "vitest";
import { cancelledInstallmentPurchaseIdsByNotaCredit } from "./ccInstallmentLedgerDb.js";

describe("cancelledInstallmentPurchaseIdsByNotaCredit", () => {
  it("cancels a backdated full-principal nota posting on a later statement (MERCADO LIBRE refund)", () => {
    // Santander backdates the nota's transaction date to the purchase date; the posting
    // statement (one cycle later) is the evidence the refund is real, not an instant reversal.
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [
        { id: 111, purchase_date: "2025-02-07", total_amount_clp: 54_990, firstBilledYm: "2025-02" },
      ],
      notaCredits: [{ amountAbs: 54_990, occurredIso: "2025-02-07", statementYm: "2025-03" }],
    });
    expect([...cancelled]).toEqual([111]);
  });

  it("does not cancel a same-date nota on the plan's own first statement (instant-reversal twin)", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [
        { id: 112, purchase_date: "2025-02-07", total_amount_clp: 54_990, firstBilledYm: "2025-02" },
      ],
      notaCredits: [{ amountAbs: 54_990, occurredIso: "2025-02-07", statementYm: "2025-02" }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("does not cancel a same-date nota when the statement month is unknown", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [
        { id: 113, purchase_date: "2025-02-07", total_amount_clp: 54_990, firstBilledYm: "2025-02" },
      ],
      notaCredits: [{ amountAbs: 54_990, occurredIso: "2025-02-07", statementYm: null }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("does not cancel via statement path when the nota statement is too many months out", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [
        { id: 114, purchase_date: "2025-02-07", total_amount_clp: 54_990, firstBilledYm: "2025-02" },
      ],
      notaCredits: [{ amountAbs: 54_990, occurredIso: "2025-02-07", statementYm: "2025-06" }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("cancels when nota transaction date is within two calendar months after purchase", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 1, purchase_date: "2025-01-15", total_amount_clp: 100_000 }],
      notaCredits: [{ amountAbs: 100_000, occurredIso: "2025-03-10", statementYm: null }],
    });
    expect([...cancelled]).toEqual([1]);
  });

  it("does not cancel when nota is more than two calendar months after purchase", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 2, purchase_date: "2025-01-15", total_amount_clp: 100_000 }],
      notaCredits: [{ amountAbs: 100_000, occurredIso: "2025-05-01", statementYm: null }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("does not cancel when amounts differ", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 3, purchase_date: "2025-02-07", total_amount_clp: 54_990, firstBilledYm: "2025-02" }],
      notaCredits: [{ amountAbs: 54_991, occurredIso: "2025-03-01", statementYm: "2025-03" }],
    });
    expect([...cancelled]).toEqual([]);
  });
});
