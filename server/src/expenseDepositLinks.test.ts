import { describe, expect, it } from "vitest";
import {
  aggregateGastosFromLines,
  type FlowCcExpenseLineRow,
} from "./flowsCreditCardExpenses.js";
import {
  BILLS_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseCategories.js";
import {
  carryingClpForExpenseDepositLink,
  expenseDepositLinkDto,
  findUniqueCcLineForMortgageSheetRow,
  isMortgageCcExpenseMerchant,
  type ExpenseDepositLinkRow,
} from "./expenseDepositLinks.js";

describe("isMortgageCcExpenseMerchant", () => {
  it("matches MetLife, Mutuaria, and Toku hipoteca merchants", () => {
    expect(isMortgageCcExpenseMerchant("METLIFE CHILE SEGUROS")).toBe(true);
    expect(isMortgageCcExpenseMerchant("TOKU *METLIFE HIPOTE")).toBe(true);
    expect(isMortgageCcExpenseMerchant("MUTUARIA")).toBe(true);
    expect(isMortgageCcExpenseMerchant("JUMBO LA REINA")).toBe(false);
  });
});

describe("findUniqueCcLineForMortgageSheetRow", () => {
  it("matches CC line within purchase day gap when amount equals sheet pago", () => {
    const sheet = {
      cuota: "19",
      occurred_on: "2025-09-30",
      pago_clp: 1_385_591,
    } as import("./deptoDividendosLedger.js").DeptoMortgageSheetRow;
    const lines: import("./expenseDepositLinks.js").GastosLineForExpenseDepositLink[] = [
      {
        source: "cc",
        account_id: 32,
        purchase_key: "line-pr:test",
        category_slug: "bills",
        amount_clp: 1_385_591,
        purchase_notes: "",
        merchant: "METLIFE CHILE SEGUROS",
        purchase_on: "2025-09-24",
        occurred_on: "2025-09-25",
      },
    ];
    const match = findUniqueCcLineForMortgageSheetRow(lines, sheet, new Set());
    expect(match?.purchase_key).toBe("line-pr:test");
  });
});

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
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "Cargo Mercado Capitales",
    merchant_key: "CARGO MERCADO CAPITALES",
    category_slug: DEPOSITS_CC_EXPENSE_SLUG,
    category_unique: true,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: "checking-cartola:10:2024-03:2024-03-11:1000000:1",
    purchase_notes: "auto:deposit-match|acct:41|date:2024-03-11|amt:1000000",
    big_group_slug: null,
    origin_label: "Cuenta corriente",
    origin_card_last4: null,
    primary_card_last4: null,
    ...overrides,
  };
}

describe("expense deposit link aggregate split", () => {
  it("splits linked mortgage deposit into bills carrying cost and amortization chart stack", () => {
    const linkRow: ExpenseDepositLinkRow = {
      account_id: 10,
      purchase_key: "checking-cartola:10:2024-03:2024-03-11:1000000:1",
      deposit_movement_id: 99,
      payment_clp: 1_000_000,
      amortization_clp: 600_000,
      depto_cuota: "2024-03",
      depto_occurred_on: "2024-03-11",
      link_source: "auto",
    };
    const line = baseLine({
      expense_deposit_links: [expenseDepositLinkDto(linkRow)],
    });
    expect(carryingClpForExpenseDepositLink(linkRow)).toBe(400_000);

    const chartSlugs = [
      BILLS_CC_EXPENSE_SLUG,
      "supermarket",
      REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
    ];
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      chartSlugs
    );

    expect(by_month[0]?.gastos_mes_clp).toBe(400_000);
    expect(by_month[0]?.gastos_real_mes_clp).toBe(1_000_000);
    const pt = chart_monthly_by_category[0]!;
    expect(pt[BILLS_CC_EXPENSE_SLUG]).toBe(400_000);
    expect(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-600_000);
    expect(pt.supermarket).toBe(0);
  });

  it("leaves unlinked deposits category lines out of gastos and chart", () => {
    const line = baseLine();
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(0);
    expect(chart_monthly_by_category[0]?.[BILLS_CC_EXPENSE_SLUG]).toBe(0);
  });

  it("splits linked CC MetLife mortgage into bills carrying and negative amortization", () => {
    const linkRow: ExpenseDepositLinkRow = {
      account_id: 32,
      purchase_key: "line-pr:metlife-cuota-27",
      deposit_movement_id: 99,
      payment_clp: 3_212_395,
      amortization_clp: 2_855_638,
      depto_cuota: "27",
      depto_occurred_on: "2026-05-11",
      link_source: "auto",
    };
    const line: FlowCcExpenseLineRow = {
      ...baseLine({
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
      }),
      expense_deposit_links: [expenseDepositLinkDto(linkRow)],
    };
    expect(carryingClpForExpenseDepositLink(linkRow)).toBe(356_757);

    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(356_757);
    expect(by_month[0]?.gastos_real_mes_clp).toBe(3_212_395);
    const pt = chart_monthly_by_category[0]!;
    expect(pt[BILLS_CC_EXPENSE_SLUG]).toBe(356_757);
    expect(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-2_855_638);
  });
});

describe("cuota 4 Jun 2024 MUTUARIA on card 4141", () => {
  const MUTUARIA_4141_KEY = "line-pr:14155140355ba3fc";

  it("enriches expense_deposit_links by purchase_key regardless of account_id on link row", () => {
    const linkRow: ExpenseDepositLinkRow = {
      account_id: 99,
      purchase_key: MUTUARIA_4141_KEY,
      deposit_movement_id: 10462,
      payment_clp: 1_200_000,
      amortization_clp: 926_381,
      depto_cuota: "4",
      depto_occurred_on: "2024-06-14",
      link_source: "auto",
    };
    const line = baseLine({
      source: "cc",
      account_id: 35,
      expense_month: "2024-06",
      purchase_on: "2024-06-14",
      amount_clp: 1_200_000,
      merchant: "MUTUARIA",
      merchant_key: "MUTUARIA",
      category_slug: BILLS_CC_EXPENSE_SLUG,
      purchase_key: MUTUARIA_4141_KEY,
      expense_deposit_links: [expenseDepositLinkDto(linkRow)],
    });
    expect(line.expense_deposit_links?.[0]?.depto_cuota).toBe("4");
    expect(carryingClpForExpenseDepositLink(linkRow)).toBe(273_619);

    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(273_619);
    const pt = chart_monthly_by_category[0]!;
    expect(pt[BILLS_CC_EXPENSE_SLUG]).toBe(273_619);
    expect(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-926_381);
  });
});
