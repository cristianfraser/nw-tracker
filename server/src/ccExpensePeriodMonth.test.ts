import { describe, expect, it } from "vitest";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import {
  gastosPeriodMonthForLine,
  gastosSumMonthForLine,
  installmentModalLines,
  lineMatchesGastosPeriodMonth,
  periodMonthsForGastosLine,
  purchaseModalLines,
} from "./ccExpensePeriodMonth.js";
import { aggregateGastosFromLines } from "./flowsCreditCardExpenses.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

function ccLine(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const expenseMonth = partial.expense_month ?? "2024-03";
  const billingMonth = partial.billing_month ?? "2024-04";
  const purchaseOn = partial.purchase_on ?? "2024-03-15";
  const lineRole =
    partial.line_role ??
    (partial.installment_flag ? "installment_cuota" : "purchase");
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: expenseMonth,
    billing_month: billingMonth,
    purchase_month: partial.purchase_month ?? purchaseOn.slice(0, 7),
    line_role: lineRole,
    occurred_on: "2024-04-24",
    purchase_on: purchaseOn,
    statement_date: "24/04/2024",
    amount_clp: 10_000,
    merchant: "TEST",
    merchant_key: "TEST",
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

describe("ccExpensePeriodMonth", () => {
  it("lists one-shot CC lines only in purchase month modal", () => {
    const line = ccLine({
      expense_month: "2024-03",
      billing_month: "2024-04",
      purchase_month: "2024-03",
      line_role: "purchase",
      installment_flag: 0,
    });
    expect(periodMonthsForGastosLine(line)).toEqual(["2024-03"]);
    expect(lineMatchesGastosPeriodMonth(line, "2024-04")).toBe(false);
    expect(lineMatchesGastosPeriodMonth(line, "2024-03")).toBe(true);
    expect(purchaseModalLines([line], "2024-03")).toHaveLength(1);
    expect(purchaseModalLines([line], "2024-04")).toHaveLength(0);
  });

  it("lists installment cuotas in billing month and purchase totals in purchase month", () => {
    const cuota = ccLine({
      expense_month: "2025-04",
      billing_month: "2025-04",
      purchase_month: "2025-02",
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 2,
      nro_cuota_total: 3,
      amount_clp: 50_000,
    });
    const total = ccLine({
      statement_line_id: -99,
      expense_month: "2025-02",
      billing_month: "2025-02",
      purchase_month: "2025-02",
      purchase_on: "2025-02-27",
      line_role: "installment_purchase_total",
      installment_flag: 1,
      nro_cuota_current: null,
      nro_cuota_total: 3,
      amount_clp: 150_000,
    });
    expect(periodMonthsForGastosLine(cuota)).toEqual(["2025-04"]);
    expect(installmentModalLines([cuota], "2025-04")).toHaveLength(1);
    expect(purchaseModalLines([total], "2025-02")).toHaveLength(1);
    expect(gastosSumMonthForLine(cuota, "split")).toBe("2025-04");
    expect(gastosSumMonthForLine(cuota, "total")).toBe("");
    expect(gastosSumMonthForLine(total, "total")).toBe("2025-02");
    expect(gastosSumMonthForLine(total, "split")).toBe("");
  });

  it("attributes split vs total installment gastos to the correct months", () => {
    const cuota1 = ccLine({
      statement_line_id: 10,
      expense_month: "2025-04",
      billing_month: "2025-04",
      purchase_month: "2025-03",
      purchase_on: "2025-03-03",
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 1,
      nro_cuota_total: 3,
      amount_clp: 40_000,
    });
    const cuota2 = ccLine({
      statement_line_id: 11,
      expense_month: "2025-05",
      billing_month: "2025-05",
      purchase_month: "2025-03",
      purchase_on: "2025-03-03",
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 2,
      nro_cuota_total: 3,
      amount_clp: 40_000,
    });
    const total = ccLine({
      statement_line_id: -1,
      expense_month: "2025-03",
      billing_month: "2025-03",
      purchase_month: "2025-03",
      purchase_on: "2025-03-03",
      line_role: "installment_purchase_total",
      installment_flag: 1,
      nro_cuota_current: null,
      nro_cuota_total: 3,
      amount_clp: 120_000,
    });
    const lines = [cuota1, cuota2, total];

    const split = aggregateGastosFromLines(lines, ["unclassified"], "split");
    expect(split.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(0);
    expect(split.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(40_000);
    expect(split.by_month.find((m) => m.period_month === "2025-05")?.gastos_mes_clp).toBe(40_000);

    const totalMode = aggregateGastosFromLines(lines, ["unclassified"], "total");
    expect(totalMode.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(
      120_000
    );
    expect(totalMode.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(0);
  });

  it("attributes one-shot and checking gastos to purchase month only", () => {
    const lines = [
      ccLine({
        expense_month: "2024-03",
        billing_month: "2024-04",
        purchase_month: "2024-03",
        line_role: "purchase",
        installment_flag: 0,
        amount_clp: 3_000,
      }),
      {
        ...ccLine({
          source: "checking",
          expense_month: "2024-04",
          billing_month: "2024-04",
          purchase_month: "2024-04",
          line_role: "purchase",
          amount_clp: 1_000,
        }),
      },
    ];
    const { by_month } = aggregateGastosFromLines(lines, ["unclassified"]);
    const apr = by_month.find((m) => m.period_month === "2024-04");
    const mar = by_month.find((m) => m.period_month === "2024-03");
    expect(apr?.line_count).toBe(1);
    expect(mar?.line_count).toBe(1);
    expect(apr?.gastos_mes_clp).toBe(1_000);
    expect(mar?.gastos_mes_clp).toBe(3_000);
  });

  it("one-shot purchases bucket by their real expense month", () => {
    const line = ccLine({
      expense_month: "2025-02",
      billing_month: "2025-02",
      purchase_month: "2025-02",
      purchase_on: "2025-02-10",
      line_role: "purchase",
      amount_clp: 3_071_622,
      category_slug: "bills",
    });
    expect(gastosPeriodMonthForLine(line)).toBe("2025-02");
    expect(gastosSumMonthForLine(line, "split")).toBe("2025-02");
    expect(periodMonthsForGastosLine(line)).toEqual(["2025-02"]);
    expect(purchaseModalLines([line], "2025-02")).toHaveLength(1);
    expect(purchaseModalLines([line], "2025-01")).toHaveLength(0);

    const { by_month } = aggregateGastosFromLines([line], ["bills"]);
    expect(by_month.find((m) => m.period_month === "2025-02")?.gastos_mes_clp).toBe(3_071_622);
    expect(by_month.find((m) => m.period_month === "2025-01")?.gastos_mes_clp ?? 0).toBe(0);
  });
});

describe("parseDdMmYyToIso jammed MCC dates", () => {
  it("unwraps pypdf merged YY + MCC prefix digits", () => {
    expect(parseDdMmYyToIso("13/05/2511")).toBe("2025-05-13");
    expect(parseDdMmYyToIso("08/01/2611")).toBe("2026-01-08");
    expect(parseDdMmYyToIso("22/10/2024")).toBe("2024-10-22");
  });
});
