import { describe, expect, it } from "vitest";
import { aggregateGastosChartPointsByDay, gastosDayForLine } from "./ccExpenseGastosDaily";
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

const SLUGS = ["unclassified"];
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

describe("aggregateGastosChartPointsByDay", () => {
  const cuotas = [
    ccLine({ statement_line_id: 10, billing_month: "2025-04", nro_cuota_current: 1 }),
    ccLine({ statement_line_id: 11, billing_month: "2025-05", nro_cuota_current: 2 }),
    ccLine({ statement_line_id: 12, billing_month: "2025-06", nro_cuota_current: 3 }),
  ];

  it("buckets cuotas on pay-by days (split mode)", () => {
    const pts = aggregateGastosChartPointsByDay(cuotas, SLUGS, "split", undefined, "clp", PAY_BY);
    expect(pts.map((p) => p.as_of_date)).toEqual(["2025-05-10", "2025-06-10", "2025-07-10"]);
    expect(pts[0]!.unclassified).toBe(40_000);
  });

  it("month sums are frame-shifted M→M+1 vs the monthly split chart (pay vs bank frame)", () => {
    const monthly = aggregateGastosFromLines(cuotas, SLUGS, "split", undefined, "clp");
    const daily = aggregateGastosChartPointsByDay(cuotas, SLUGS, "split", undefined, "clp", PAY_BY);

    const dayMonthSum = (ym: string) =>
      daily
        .filter((p) => p.as_of_date.slice(0, 7) === ym)
        .reduce((s, p) => s + (p.unclassified as number), 0);
    const monthSum = (ym: string) =>
      monthly.chart_monthly_by_category
        .filter((p) => p.as_of_date.slice(0, 7) === ym)
        .reduce((s, p) => s + (p.unclassified as number), 0);

    // A cuota billed in M leaves the account ~10th of M+1.
    expect(dayMonthSum("2025-05")).toBe(monthSum("2025-04"));
    expect(dayMonthSum("2025-06")).toBe(monthSum("2025-05"));
    expect(dayMonthSum("2025-07")).toBe(monthSum("2025-06"));
  });

  it("total mode buckets the whole purchase on its purchase day and reconciles directly", () => {
    const lines = [
      ...cuotas,
      ccLine({
        statement_line_id: -1,
        line_role: "installment_purchase_total",
        purchase_on: "2025-03-03",
        expense_month: "2025-03",
        billing_month: "2025-03",
        amount_clp: 120_000,
      }),
    ];
    const daily = aggregateGastosChartPointsByDay(lines, SLUGS, "total", undefined, "clp", PAY_BY);
    expect(daily.map((p) => p.as_of_date)).toEqual(["2025-03-03"]);
    expect(daily[0]!.unclassified).toBe(120_000);

    const monthly = aggregateGastosFromLines(lines, SLUGS, "total", undefined, "clp");
    const marchMonthly = monthly.chart_monthly_by_category
      .filter((p) => p.as_of_date.slice(0, 7) === "2025-03")
      .reduce((s, p) => s + (p.unclassified as number), 0);
    expect(daily[0]!.unclassified).toBe(marchMonthly);
  });

  it("excludes big groups the user filtered out of the chart", () => {
    const lines = [ccLine({ statement_line_id: 20, billing_month: "2025-04", big_group_slug: "trips" })];
    const pts = aggregateGastosChartPointsByDay(
      lines,
      SLUGS,
      "split",
      new Set(["trips"]),
      "clp",
      PAY_BY
    );
    expect(pts).toEqual([]);
  });
});
