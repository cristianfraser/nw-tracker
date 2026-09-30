import { describe, expect, it } from "vitest";
import { gastosDayForLine } from "./ccExpenseGastosDaily";
import type { FlowCcExpenseLineRow } from "./types";

function ccLine(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const purchaseOn = partial.purchase_on ?? "2025-03-03";
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: partial.expense_month ?? "2025-04",
    billing_month: partial.billing_month ?? "2025-04",
    purchase_month: partial.purchase_month ?? purchaseOn.slice(0, 7),
    line_role: partial.line_role ?? "installment_cuota",
    occurred_on: "2025-04-24",
    purchase_on: purchaseOn,
    statement_date: "24/04/2024",
    amount_clp: 40_000,
    amount_usd_at_expense: null,
    merchant: "TEST",
    merchant_key: "TEST",
    installment_flag: 1,
    nro_cuota_current: 1,
    nro_cuota_total: 3,
    category_slug: "unclassified",
    category_unique: false,
    purchase_key: "line-pr:test",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    ...partial,
  };
}

// Facturación 2025-04 is paid ~10 may; 2025-05 ~10 jun; 2025-06 ~10 jul.
const PAY_BY: Record<string, string> = {
  "32|2025-04": "2025-05-10",
  "32|2025-05": "2025-06-10",
  "32|2025-06": "2025-07-10",
};

describe("gastosDayForLine", () => {
  it("puts a cuota on its facturación's pay-by day", () => {
    const cuota = ccLine({ billing_month: "2025-05" });
    expect(gastosDayForLine(cuota, PAY_BY)).toBe("2025-06-10");
  });

  it("puts a one-shot card purchase on its purchase date", () => {
    const purchase = ccLine({ line_role: "purchase", purchase_on: "2025-03-17" });
    expect(gastosDayForLine(purchase, PAY_BY)).toBe("2025-03-17");
  });

  it("throws for a card line with no purchase date (data regression, not a display case)", () => {
    const broken = ccLine({ line_role: "purchase", purchase_on: null });
    expect(() => gastosDayForLine(broken, PAY_BY)).toThrow(/purchase_on/);
  });

  it("returns null for a cuota whose billing month has no pay-by yet", () => {
    const cuota = ccLine({ billing_month: "2099-01" });
    expect(gastosDayForLine(cuota, PAY_BY)).toBeNull();
  });
});
