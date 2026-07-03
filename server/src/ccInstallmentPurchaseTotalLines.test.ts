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
    amount_usd: null,
    amount_usd_at_expense: null,
    purchase_key: "",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "",
    origin_card_last4: null,
    primary_card_last4: null,
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

  it("does not let an installment total hijack a same-merchant/same-day purchase with a different amount", () => {
    // Two distinct EXPRESS PLAZA L charges on 30/06: one stays a one-shot purchase (1.267.034),
    // the other was turned into a 3-cuota installment (1.200.000). The installment total must
    // not promote/overwrite or drop the unrelated one-shot sibling.
    const oneShot = line({
      statement_line_id: 241231,
      line_role: "purchase",
      installment_flag: 0,
      merchant: "EXPRESS PLAZA L",
      merchant_key: "EXPRESS PLAZA L",
      amount_clp: 1_267_034,
      purchase_on: "2026-06-30",
      purchase_month: "2026-06",
      billing_month: "2026-07",
      nro_cuota_total: null,
      nro_cuota_current: null,
    });
    const cuotas = [1, 2, 3].map((c) =>
      line({
        statement_line_id: 5000 + c,
        line_role: "installment_cuota",
        installment_flag: 1,
        merchant: "EXPRESS PLAZA L",
        merchant_key: "EXPRESS PLAZA L",
        amount_clp: 400_000,
        purchase_on: "2026-06-30",
        purchase_month: "2026-06",
        nro_cuota_current: c,
        nro_cuota_total: 3,
      })
    );

    const merged = mergeInstallmentPurchaseTotalsIntoLines([oneShot, ...cuotas], [], emptyMaps);

    const survivor = merged.find((l) => l.statement_line_id === 241231);
    expect(survivor).toBeDefined();
    expect(survivor!.line_role).toBe("purchase");
    expect(survivor!.amount_clp).toBe(1_267_034);

    const total = merged.find((l) => l.line_role === "installment_purchase_total");
    expect(total).toBeDefined();
    expect(total!.amount_clp).toBe(1_200_000);
    expect(total!.statement_line_id).not.toBe(241231);
  });

  it("still promotes a same-day purchase line whose amount matches the installment total", () => {
    // Guard against over-restriction: when the one-shot purchase amount equals the installment
    // principal, it is the purchase and should be promoted in place (id preserved), not duplicated.
    const purchase = line({
      statement_line_id: 777,
      line_role: "purchase",
      installment_flag: 0,
      merchant: "EXPRESS PLAZA L",
      merchant_key: "EXPRESS PLAZA L",
      amount_clp: 1_200_000,
      purchase_on: "2026-06-30",
      purchase_month: "2026-06",
      billing_month: "2026-07",
      nro_cuota_total: null,
      nro_cuota_current: null,
    });
    const cuotas = [1, 2, 3].map((c) =>
      line({
        statement_line_id: 6000 + c,
        line_role: "installment_cuota",
        installment_flag: 1,
        merchant: "EXPRESS PLAZA L",
        merchant_key: "EXPRESS PLAZA L",
        amount_clp: 400_000,
        purchase_on: "2026-06-30",
        purchase_month: "2026-06",
        nro_cuota_current: c,
        nro_cuota_total: 3,
      })
    );

    const merged = mergeInstallmentPurchaseTotalsIntoLines([purchase, ...cuotas], [], emptyMaps);

    const promoted = merged.find((l) => l.statement_line_id === 777);
    expect(promoted).toBeDefined();
    expect(promoted!.line_role).toBe("installment_purchase_total");
    expect(promoted!.amount_clp).toBe(1_200_000);
    const totals = merged.filter((l) => l.line_role === "installment_purchase_total");
    expect(totals).toHaveLength(1);
  });

  it("throws on an ambiguous cuota group (no purchase row) that conflates two purchases", () => {
    // Two installments share account+date+cuotas+merchant with no cc_installment_purchases row and
    // different cuota amounts, so their cuota lines merge into one amount-free group. Summing them
    // would produce a wrong total — fail fast instead.
    const mk = (idBase: number, per: number) =>
      [1, 2, 3].map((c) =>
        line({
          statement_line_id: idBase + c,
          line_role: "installment_cuota",
          installment_flag: 1,
          merchant: "EXPRESS PLAZA L",
          merchant_key: "EXPRESS PLAZA L",
          amount_clp: per,
          purchase_on: "2026-06-30",
          purchase_month: "2026-06",
          nro_cuota_current: c,
          nro_cuota_total: 3,
        })
      );
    const cuotas = [...mk(7000, 400_000), ...mk(8000, 422_345)];

    expect(() => mergeInstallmentPurchaseTotalsIntoLines(cuotas, [], emptyMaps)).toThrow(
      /Ambiguous installment cuota group/
    );
  });
});
