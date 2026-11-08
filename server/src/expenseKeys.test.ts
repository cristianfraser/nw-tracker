import { describe, expect, it } from "vitest";
import {
  buildExpenseKey,
  expensePieceKey,
  installmentHKeyWithoutTotal,
  isInstallmentContractKind,
  parseExpenseKey,
  type ExpenseKey,
} from "./expenseKeys.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { checkingCartolaStablePurchaseKey, movementNote } from "./checkingCartolaParse.js";

/** One case per family (and per optional segment): the text, and the key it parses to. */
const CASES: [string, ExpenseKey][] = [
  [
    "installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L",
    { kind: "installment_h", accountId: 32, purchaseIso: "2026-06-30", cuotasTotal: 3, totalClp: 1267034, merchantKey: "EXPRESS PLAZA L" },
  ],
  [
    "installment-h:32:2026-06-30:3:EXPRESS PLAZA L",
    { kind: "installment_h", accountId: 32, purchaseIso: "2026-06-30", cuotasTotal: 3, totalClp: null, merchantKey: "EXPRESS PLAZA L" },
  ],
  [
    "installment-h:7:2025-01-02:12:500:A:B",
    { kind: "installment_h", accountId: 7, purchaseIso: "2025-01-02", cuotasTotal: 12, totalClp: 500, merchantKey: "A:B" },
  ],
  ["installment-pr:pdf-row-abc#4", { kind: "installment_pr", parserRowId: "pdf-row-abc#4" }],
  ["installment:91", { kind: "installment", purchaseId: 91 }],
  ["line-pr:9011-2026-08|row:12#dup1", { kind: "line_pr", parserRowId: "9011-2026-08|row:12#dup1" }],
  ["line:4410", { kind: "line", lineId: 4410 }],
  [
    "line-fallback:32:SHOP X:2026-01-03",
    { kind: "line_fallback", accountId: 32, merchantKey: "SHOP X", purchaseIso: "2026-01-03" },
  ],
  ["line-fallback:32:SHOP X:", { kind: "line_fallback", accountId: 32, merchantKey: "SHOP X", purchaseIso: "" }],
  ["line-fallback:missing:77", { kind: "line_fallback_missing", lineId: 77 }],
  [
    "checking-cartola:22:2026-05:2026-05-04:-15000:3",
    { kind: "checking_cartola", accountId: 22, periodMonth: "2026-05", occurredOn: "2026-05-04", amountClp: "-15000", cartolaIndex: 3, portion: "gastos" },
  ],
  [
    "checking-cartola:22:2026-05:2026-05-04:-15000:3:deposit",
    { kind: "checking_cartola", accountId: 22, periodMonth: "2026-05", occurredOn: "2026-05-04", amountClp: "-15000", cartolaIndex: 3, portion: "deposit" },
  ],
  ["checking-mv:12001", { kind: "checking_mv", movementId: 12001, portion: "gastos" }],
  ["checking-mv:12001:deposit", { kind: "checking_mv", movementId: 12001, portion: "deposit" }],
  ["synthetic-checking-gap-mirror:5", { kind: "gap_mirror", mirrorId: 5 }],
  ["manual:14", { kind: "manual", entryId: 14 }],
  ["payslip:3001002", { kind: "payslip", lineId: 3001002 }],
  ["line-pr:row-1#split:0", { kind: "split", base: { kind: "line_pr", parserRowId: "row-1" }, seq: 0 }],
  [
    "checking-mv:8:deposit#split:2",
    { kind: "split", base: { kind: "checking_mv", movementId: 8, portion: "deposit" }, seq: 2 },
  ],
];

describe("expense keys", () => {
  it.each(CASES)("round-trips %s", (text, key) => {
    expect(parseExpenseKey(text)).toEqual(key);
    expect(buildExpenseKey(key)).toBe(text);
  });

  it("rejects text that is no key", () => {
    for (const text of ["", "line-pr:", "installment:abc", "checking-mv:x", "foo:1", "installment-h:1:2026-01-01", "manual:"]) {
      expect(parseExpenseKey(text)).toBeNull();
    }
  });

  it("names the plan families and drops a plan key's total", () => {
    expect(isInstallmentContractKind("installment_h")).toBe(true);
    expect(isInstallmentContractKind("installment_pr")).toBe(true);
    expect(isInstallmentContractKind("line_pr")).toBe(false);
    expect(installmentHKeyWithoutTotal("installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L")).toBe(
      "installment-h:32:2026-06-30:3:EXPRESS PLAZA L"
    );
    expect(installmentHKeyWithoutTotal("installment-h:32:2026-06-30:3:EXPRESS PLAZA L")).toBeNull();
    expect(installmentHKeyWithoutTotal("line-pr:abc")).toBeNull();
    expect(expensePieceKey("manual:3", 1)).toBe("manual:3#split:1");
  });

  it("the plan and cartola builders spell their keys through the module", () => {
    expect(
      stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId: 32,
        purchaseDateIso: "2026-06-30",
        cuotasTotales: 3,
        totalAmountClp: 1_267_034.4,
        merchant: "Express Plaza L",
      })
    ).toBe("installment-h:32:2026-06-30:3:1267034:EXPRESS PLAZA L");
    const note = movementNote("2026-05", "SUC", "Compra", "123", { occurredOn: "2026-05-04", amountClp: -15000, cartolaIndex: 3 });
    expect(checkingCartolaStablePurchaseKey(22, note, "deposit")).toBe("checking-cartola:22:2026-05:2026-05-04:-15000:3:deposit");
  });
});
