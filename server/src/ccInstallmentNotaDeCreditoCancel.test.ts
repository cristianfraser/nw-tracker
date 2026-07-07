import { describe, expect, it } from "vitest";
import { cancelledInstallmentPurchaseIdsByNotaCredit } from "./ccInstallmentLedgerDb.js";

describe("cancelledInstallmentPurchaseIdsByNotaCredit", () => {
  it("does not cancel when nota transaction date equals purchase date (4242 MERCADO LIBRE regression)", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 111, purchase_date: "2025-02-07", total_amount_clp: 54_990 }],
      notaCredits: [{ amountAbs: 54_990, occurredIso: "2025-02-07" }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("cancels when nota is within two calendar months after purchase", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 1, purchase_date: "2025-01-15", total_amount_clp: 100_000 }],
      notaCredits: [{ amountAbs: 100_000, occurredIso: "2025-03-10" }],
    });
    expect([...cancelled]).toEqual([1]);
  });

  it("does not cancel when nota is more than two calendar months after purchase", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 2, purchase_date: "2025-01-15", total_amount_clp: 100_000 }],
      notaCredits: [{ amountAbs: 100_000, occurredIso: "2025-05-01" }],
    });
    expect([...cancelled]).toEqual([]);
  });

  it("does not cancel when amounts differ", () => {
    const cancelled = cancelledInstallmentPurchaseIdsByNotaCredit({
      purchases: [{ id: 3, purchase_date: "2025-02-07", total_amount_clp: 54_990 }],
      notaCredits: [{ amountAbs: 54_991, occurredIso: "2025-03-01" }],
    });
    expect([...cancelled]).toEqual([]);
  });
});
