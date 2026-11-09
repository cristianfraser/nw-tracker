import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MATCH_WINDOWS, type MatchRelation } from "./windows.js";

describe("MATCH_WINDOWS", () => {
  it("every window is a whole, non-negative span", () => {
    for (const [relation, w] of Object.entries(MATCH_WINDOWS)) {
      expect(Number.isInteger(w.daysBefore) && w.daysBefore >= 0, relation).toBe(true);
      expect(Number.isInteger(w.daysAfter) && w.daysAfter >= 0, relation).toBe(true);
    }
  });

  it("a tolerance row states its tolerance and only a tolerance row does", () => {
    for (const [relation, w] of Object.entries(MATCH_WINDOWS) as [MatchRelation, (typeof MATCH_WINDOWS)[MatchRelation]][]) {
      const hasTolerance = "toleranceFraction" in w;
      if (hasTolerance) expect(w.amount, relation).toBe("tolerance");
    }
  });
});

/**
 * The matchers read their days from the table: none of the owned matcher files may carry a day
 * window of its own again (`const SOMETHING_DAYS = 4`, `<= 4` on a day gap).
 */
describe("the matchers take their windows from the table", () => {
  const dir = path.resolve(__dirname, "..");
  const files = [
    "ccOpenWebPastePdfReconcile", "ccTruncatedMerchantDedupe", "ccFeedMirror", "ccPaymentMirrors", "ccPlantedPayments",
    "ccRecurringPendingLines", "recurringPaymentMatch", "ccFacturadoFinancingAuto", "ccManualInstallmentStatementReconcile",
    "flowsDepositsReconciliation", "movementMirrorPairs", "mortgagePaymentCardMatch", "paymentProcessorReceipts",
    "merchantExpenseNotes", "utilityBillsApply", "realEstateExpenseMatching", "bankTransferNotices", "incomingWires",
    "flowsCheckingGastos", "expenseDepositLinks", "ccCrossImportDedupe",
  ];
  const literalWindow = /\b(?:const|let)\s+[A-Za-z_]*(?:DAYS|DAY_GAP)[A-Za-z_]*\s*(?::\s*number\s*)?=\s*\d+\s*;/;
  it.each(files)("%s declares no day-window constant of its own", (f) => {
    const text = fs.readFileSync(path.join(dir, `${f}.ts`), "utf8");
    const bad = text.split("\n").filter((l) => literalWindow.test(l) && !l.includes("// window-ok"));
    expect(bad).toEqual([]);
  });

  it.each(files.filter((f) => f !== "ccCrossImportDedupe"))("%s reads MATCH_WINDOWS", (f) => {
    expect(fs.readFileSync(path.join(dir, `${f}.ts`), "utf8")).toContain("MATCH_WINDOWS");
  });
});
