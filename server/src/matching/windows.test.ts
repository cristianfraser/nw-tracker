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

  it("pins the relations the matchers read, at the numbers they carried before the table", () => {
    const span = (r: MatchRelation) => `${MATCH_WINDOWS[r].daysBefore}..${MATCH_WINDOWS[r].daysAfter}`;
    expect(span("statement_bucket_line")).toBe("1..1");
    expect(span("truncated_merchant")).toBe("4..4");
    expect(span("feed_mirror")).toBe("4..4");
    expect(span("payment_mirror")).toBe("4..4");
    expect(span("planted_payment")).toBe("0..5");
    expect(span("recurring_pending")).toBe("0..7");
    expect(span("financing_payment")).toBe("3..5");
    expect(span("financing_pay_by_grace")).toBe("0..10");
    expect(span("manual_statement_plan")).toBe("2..2");
    expect(span("internal_transfer_legs")).toBe("7..7");
    expect(span("mirror_pair")).toBe("5..5");
    expect(span("mortgage_cuota_card_line")).toBe("0..3");
    expect(span("mortgage_cuota_stored_link")).toBe("14..14");
    expect(span("receipt")).toBe("1..5");
    expect(span("utility_bill_charge")).toBe("0..20");
    expect(span("hoa_bill_charge")).toBe("0..35");
    expect(span("real_estate_bill_purchase")).toBe("0..2");
    expect(MATCH_WINDOWS.real_estate_bill_purchase.unit).toBe("months");
    expect(MATCH_WINDOWS.receipt.toleranceFraction).toBe(0.04);
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
  ];
  const literalWindow = /\b(?:const|let)\s+[A-Za-z_]*(?:DAYS|DAY_GAP)[A-Za-z_]*\s*=\s*\d+\b/;
  it.each(files)("%s declares no day-window constant of its own", (f) => {
    const text = fs.readFileSync(path.join(dir, `${f}.ts`), "utf8");
    const bad = text.split("\n").filter((l) => literalWindow.test(l) && !l.includes("// window-ok"));
    expect(bad).toEqual([]);
  });
});
