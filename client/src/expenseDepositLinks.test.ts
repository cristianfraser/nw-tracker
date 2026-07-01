import { describe, expect, it } from "vitest";
import { aggregateGastosFromLines } from "./ccExpenseGastosAggregate";
import {
  BILLS_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseLineBuckets";
import { expenseCategoryChartPointTotal } from "./expenseDepositLinks";
import type { FlowCcExpenseLineRow } from "./types";

function baseLine(
  overrides: Partial<FlowCcExpenseLineRow> = {}
): FlowCcExpenseLineRow {
  return {
    source: "checking",
    statement_line_id: 1,
    account_id: 10,
    expense_month: "2024-03",
    billing_month: "2024-03",
    purchase_month: "2024-03",
    line_role: "purchase",
    occurred_on: "2024-03-11",
    purchase_on: "2024-03-11",
    statement_date: "",
    amount_clp: 1_000_000,
    amount_usd_at_expense: null,
    merchant: "Cargo Mercado Capitales",
    merchant_key: "CARGO MERCADO CAPITALES",
    category_slug: DEPOSITS_CC_EXPENSE_SLUG,
    category_unique: true,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: "checking-cartola:10:2024-03:2024-03-11:1000000:1",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "Cuenta corriente",
    expense_deposit_links: [
      {
        deposit_movement_id: 99,
        payment_clp: 1_000_000,
        amortization_clp: 600_000,
        carrying_clp: 400_000,
        depto_cuota: "2024-03",
        depto_occurred_on: "2024-03-11",
        link_source: "auto",
      },
    ],
    ...overrides,
  };
}

describe("client expense deposit link aggregate", () => {
  it("matches server split for linked mortgage deposits", () => {
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [baseLine()],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(400_000);
    expect(chart_monthly_by_category[0]?.[BILLS_CC_EXPENSE_SLUG]).toBe(400_000);
    expect(chart_monthly_by_category[0]?.[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(
      -600_000
    );
  });

  it("splits linked CC MetLife mortgage into bills carrying and negative amortization", () => {
    const line = baseLine({
      source: "cc",
      account_id: 32,
      expense_month: "2026-05",
      billing_month: "2026-05",
      purchase_month: "2026-05",
      occurred_on: "2026-05-25",
      purchase_on: "2026-05-11",
      amount_clp: 3_212_395,
      merchant: "METLIFE CHILE SEGUROS",
      merchant_key: "METLIFE CHILE SEGUROS",
      category_slug: BILLS_CC_EXPENSE_SLUG,
      purchase_key: "line-pr:metlife-cuota-27",
      expense_deposit_links: [
        {
          deposit_movement_id: 99,
          payment_clp: 3_212_395,
          amortization_clp: 2_855_638,
          carrying_clp: 356_757,
          depto_cuota: "27",
          depto_occurred_on: "2026-05-11",
          link_source: "auto",
        },
      ],
    });

    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(356_757);
    expect(by_month[0]?.gastos_real_mes_clp).toBe(3_212_395);
    const pt = chart_monthly_by_category[0]!;
    expect(pt[BILLS_CC_EXPENSE_SLUG]).toBe(356_757);
    expect(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-2_855_638);
    expect(
      expenseCategoryChartPointTotal(pt, [
        BILLS_CC_EXPENSE_SLUG,
        REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
      ])
    ).toBe(3_212_395);
  });

  it("expenseCategoryChartPointTotal treats amortization as positive spend", () => {
    const pt = {
      as_of_date: "2024-03-31",
      [BILLS_CC_EXPENSE_SLUG]: 400_000,
      [REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]: -600_000,
    };
    expect(
      expenseCategoryChartPointTotal(pt, [
        BILLS_CC_EXPENSE_SLUG,
        REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
      ])
    ).toBe(1_000_000);
  });
});
