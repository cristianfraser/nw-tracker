import { describe, expect, it } from "vitest";
import {
  legacyInstallmentHPurchaseKey,
  parseInstallmentHPurchaseKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";

describe("installment-h key format", () => {
  const base = {
    accountId: 32,
    purchaseDateIso: "2026-06-30",
    cuotasTotales: 3,
    merchant: "EXPRESS PLAZA L",
  };

  it("includes the total; same identity + different amount → distinct keys", () => {
    const a = stableInstallmentHPurchaseKeyFromLedgerArgs({ ...base, totalAmountClp: 1_267_034 });
    const b = stableInstallmentHPurchaseKeyFromLedgerArgs({ ...base, totalAmountClp: 1_200_000 });
    expect(a).toBe("installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L");
    expect(b).toBe("installment-h:32:2026-06-30:3:1200000:EXPRESS PLAZA L");
    expect(a).not.toBe(b);
  });

  it("emits the legacy (no-total) key when the total is absent", () => {
    expect(stableInstallmentHPurchaseKeyFromLedgerArgs({ ...base, totalAmountClp: null })).toBe(
      "installment-h:32:2026-06-30:3:EXPRESS PLAZA L"
    );
  });

  it("legacyInstallmentHPurchaseKey drops the total segment (and is null for legacy input)", () => {
    expect(legacyInstallmentHPurchaseKey("installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L")).toBe(
      "installment-h:32:2026-06-30:3:EXPRESS PLAZA L"
    );
    expect(legacyInstallmentHPurchaseKey("installment-h:32:2026-06-30:3:EXPRESS PLAZA L")).toBeNull();
    expect(legacyInstallmentHPurchaseKey("line-pr:abc")).toBeNull();
  });

  it("parses both new and legacy formats", () => {
    const nw = parseInstallmentHPurchaseKey("installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L");
    expect(nw).toEqual({
      accountId: 32,
      purchaseIso: "2026-06-30",
      nroTotal: 3,
      totalClp: 1_267_034,
      merchantKey: "EXPRESS PLAZA L",
    });
    const legacy = parseInstallmentHPurchaseKey("installment-h:32:2026-06-30:3:EXPRESS PLAZA L");
    expect(legacy?.totalClp).toBeNull();
    expect(legacy?.merchantKey).toBe("EXPRESS PLAZA L");
  });
});
