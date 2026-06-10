import { describe, expect, it } from "vitest";
import { aggregateGastosFromLines } from "./ccExpenseGastosAggregate";
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

describe("ccExpenseGastosAggregate", () => {
  it("split mode sums cuotas in billing months; total mode sums purchase in purchase month", () => {
    const lines = [
      ccLine({
        statement_line_id: 10,
        billing_month: "2025-04",
        expense_month: "2025-04",
        nro_cuota_current: 1,
      }),
      ccLine({
        statement_line_id: 11,
        billing_month: "2025-05",
        expense_month: "2025-05",
        nro_cuota_current: 2,
      }),
      ccLine({
        statement_line_id: 12,
        billing_month: "2025-06",
        expense_month: "2025-06",
        nro_cuota_current: 3,
      }),
      ccLine({
        statement_line_id: -1,
        line_role: "installment_purchase_total",
        expense_month: "2025-03",
        billing_month: "2025-03",
        purchase_month: "2025-03",
        nro_cuota_current: null,
        amount_clp: 120_000,
      }),
    ];

    const split = aggregateGastosFromLines(lines, ["unclassified"], "split");
    expect(split.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(0);
    expect(split.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(40_000);
    expect(split.by_month.find((m) => m.period_month === "2025-06")?.gastos_mes_clp).toBe(40_000);

    const total = aggregateGastosFromLines(lines, ["unclassified"], "total");
    expect(total.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(120_000);
    expect(total.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(0);
  });

  it("chart category stacks sum to gasto del mes for each month", () => {
    const lines = [
      ccLine({ statement_line_id: 1, billing_month: "2025-04", amount_clp: 10_000, category_slug: "food" }),
      ccLine({
        statement_line_id: 2,
        billing_month: "2025-04",
        amount_clp: 20_000,
        category_slug: "supermarket",
        merchant: "JUMBO",
        merchant_key: "JUMBO",
      }),
      ccLine({
        source: "checking",
        statement_line_id: 3,
        account_id: 1,
        line_role: "purchase",
        billing_month: "2025-04",
        expense_month: "2025-04",
        amount_clp: 5_000,
        category_slug: "transport",
        installment_flag: 0,
        nro_cuota_current: null,
        nro_cuota_total: null,
      }),
    ];
    const slugs = ["food", "supermarket", "transport"];
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(lines, slugs, "split");
    const row = by_month.find((m) => m.period_month === "2025-04");
    expect(row?.gastos_mes_clp).toBe(35_000);
    const point = chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"));
    const stackSum = slugs.reduce((s, slug) => s + Number(point?.[slug] ?? 0), 0);
    expect(stackSum).toBe(35_000);
  });

  it("excludes big-group lines from chart stacks but not from by_month gastos", () => {
    const lines = [
      ccLine({
        statement_line_id: 1,
        billing_month: "2025-04",
        amount_clp: 10_000,
        category_slug: "food",
        big_group_slug: "vacation",
      }),
      ccLine({
        statement_line_id: 2,
        billing_month: "2025-04",
        amount_clp: 20_000,
        category_slug: "fun",
      }),
    ];
    const slugs = ["food", "fun"];
    const excluded = new Set(["vacation"]);
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      lines,
      slugs,
      "split",
      excluded
    );
    const row = by_month.find((m) => m.period_month === "2025-04");
    expect(row?.gastos_mes_clp).toBe(30_000);
    const point = chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"));
    expect(point?.food).toBe(0);
    expect(point?.fun).toBe(20_000);
  });
});
