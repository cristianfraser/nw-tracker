import { describe, expect, it } from "vitest";
import {
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
});
