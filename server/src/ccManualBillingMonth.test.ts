import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ymCompare } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  billingMonthForLedgerPurchase,
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForCard,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";

describe("targetBillingMonthForManualImports", () => {
  it("returns month after last PDF close for 4242", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const lastPdf = lastPdfBillingMonthForCard(master.id, "4242");
    expect(lastPdf).toBeTruthy();
    const target = targetBillingMonthForManualImports(master.id, "4242");
    expect(ymCompare(target, addCalendarMonths(lastPdf!, 1))).toBeGreaterThanOrEqual(0);
  });

  it("maps manual ledger purchases to open month regardless of purchase date", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const open = billingMonthForManualLedgerPurchase(master.id);
    expect(open).toBe("2026-05");
    expect(
      billingMonthForLedgerPurchase(master.id, {
        purchase_date: "2026-03-15",
        source: "manual",
      })
    ).toBe("2026-05");
    expect(
      billingMonthForLedgerPurchase(master.id, {
        purchase_date: "2026-04-25",
        source: "manual",
      })
    ).toBe("2026-05");
  });
});
