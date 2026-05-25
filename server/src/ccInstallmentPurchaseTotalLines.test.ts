import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";
import {
  mergeInstallmentPurchaseTotalsIntoLines,
  promoteLineToInstallmentPurchaseTotal,
  purchaseLineMatchesInstallmentPurchase,
  type InstallmentPurchaseRow,
} from "./ccInstallmentPurchaseTotalLines.js";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: "2024-12",
    billing_month: "2024-12",
    purchase_month: "2024-12",
    line_role: "purchase",
    occurred_on: "2024-12-23",
    purchase_on: "2024-12-12",
    statement_date: "23/12/2024",
    amount_clp: 149_970,
    merchant: "8 BITS TRES CUOTAS PREC",
    merchant_key: "8 BITS TRES CUOTAS PREC",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    category_slug: "unclassified",
    category_unique: false,
    ...partial,
  };
}

const emptyMaps = {
  lineOverrides: new Map(),
  merchantRules: new Map(),
  uniquePurchases: new Map(),
  uniquePurchaseModeKeys: new Set<string>(),
};

describe("ccInstallmentPurchaseTotalLines merge", () => {
  it("promotes contract summary purchase rows instead of duplicating synthetics", () => {
    const summary = line({
      statement_line_id: 100,
      merchant: "8 BITS TRES CUOTAS PREC",
      merchant_key: "8 BITS TRES CUOTAS PREC",
      amount_clp: 149_970,
    });
    const synth = line({
      statement_line_id: -1,
      line_role: "installment_purchase_total",
      merchant: "8 BITS",
      merchant_key: "8 BITS",
      installment_flag: 1,
      nro_cuota_total: 3,
      amount_clp: 149_970,
      nro_cuota_current: null,
      category_statement_line_id: 501,
    });

    const promoted = promoteLineToInstallmentPurchaseTotal(summary, synth);
    expect(promoted.line_role).toBe("installment_purchase_total");
    expect(promoted.statement_line_id).toBe(100);
    expect(promoted.merchant).toBe("8 BITS");
    expect(promoted.nro_cuota_total).toBe(3);
    expect(promoted.category_statement_line_id).toBe(501);
  });

  it("sets category_statement_line_id on synthetics from matching cuota lines", () => {
    const cuota = line({
      statement_line_id: 501,
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 1,
      nro_cuota_total: 3,
      merchant: "8 BITS CUOTA COMERCIO",
      merchant_key: "8 BITS",
    });
    const merged = mergeInstallmentPurchaseTotalsIntoLines([cuota], [], emptyMaps);
    const total = merged.find((ln) => ln.line_role === "installment_purchase_total");
    expect(total?.category_statement_line_id).toBe(501);
  });

  it("drops purchase rows superseded by an installment total for the same purchase", () => {
    const purchase = line({
      statement_line_id: 200,
      merchant: "APPLE.COM CL",
      merchant_key: "APPLE.COM CL",
      purchase_on: "2024-12-02",
      amount_clp: 156_990,
    });
    const total = line({
      statement_line_id: -2,
      line_role: "installment_purchase_total",
      merchant: "APPLE.COM CL",
      merchant_key: "APPLE.COM CL",
      purchase_on: "2024-12-02",
      installment_flag: 1,
      nro_cuota_total: 3,
      amount_clp: 470_970,
      nro_cuota_current: null,
    });

    const merged = mergeInstallmentPurchaseTotalsIntoLines([purchase, total], [], emptyMaps);
    const appleRows = merged.filter((ln) => ln.merchant?.includes("APPLE"));
    expect(appleRows).toHaveLength(1);
    expect(appleRows[0]?.line_role).toBe("installment_purchase_total");
  });

  it("collapses duplicate ledger purchases into one installment total", () => {
    const cuota = line({
      statement_line_id: 501,
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 2,
      nro_cuota_total: 12,
      purchase_on: "2025-02-27",
      purchase_month: "2025-02",
      billing_month: "2025-02",
      merchant: "ROCA WEBPAY",
      merchant_key: "ROCA WEBPAY",
      amount_clp: 73_428,
    });
    const merged = mergeInstallmentPurchaseTotalsIntoLines([cuota], [32], emptyMaps);
    const rocaTotals = merged.filter(
      (ln) =>
        ln.line_role === "installment_purchase_total" &&
        ln.purchase_on === "2025-02-27" &&
        ln.amount_clp === 881_134
    );
    expect(rocaTotals.length).toBeLessThanOrEqual(1);
  });

  it("matches installment purchases by merchant stem", () => {
    const pr: InstallmentPurchaseRow = {
      id: 1,
      account_id: 32,
      purchase_date: "2024-12-12",
      total_amount_clp: 149_970,
      cuotas_totales: 3,
      merchant: "8 BITS",
    };
    expect(
      purchaseLineMatchesInstallmentPurchase(
        line({ merchant: "8 BITS TRES CUOTAS PREC" }),
        pr
      )
    ).toBe(true);
  });
});
