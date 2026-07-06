import { describe, expect, it } from "vitest";
import { DEPOSITS_CC_EXPENSE_SLUG } from "./ccExpenseLineBuckets";
import {
  aggregateFlowsOverview,
  flowsOverviewTotals,
  rollupFlowsOverviewRowsByYear,
} from "./flowsOverviewAggregate";
import type { FlowCcExpenseLineRow, FlowsIncomeResponse } from "./types";

function mortgageLine(overrides: Partial<FlowCcExpenseLineRow> = {}): FlowCcExpenseLineRow {
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
    merchant: "TOKU METLIFE",
    merchant_key: "TOKU METLIFE",
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
        depto_cuota: "7",
        depto_occurred_on: "2024-03-11",
        link_source: "auto",
      },
    ],
    ...overrides,
  };
}

function incomePayload(): FlowsIncomeResponse {
  return {
    lines: [
      {
        movement_id: 1,
        account_id: 20,
        account_label: "Cuenta corriente",
        received_on: "2024-03-05",
        amount_clp: 2_000_000,
        amount_usd: null,
        description: "TRANSFERENCIA",
        source: "checking",
      },
    ],
    manual: [],
    monthly_totals: {},
    work_earnings: [],
    income_kind_by_movement_id: {},
    payroll_period_by_movement_id: {},
    excluded_lines: [],
    filtered_lines: [],
  };
}

function depositRow(overrides: Partial<import("./types").FlowDepositRow> = {}) {
  return {
    occurred_on: "2024-03-11",
    category: "real_estate" as const,
    category_label: "Real estate",
    account_id: 83,
    account_name: "suecia",
    kind_slug: "property",
    amount_clp: 1_000_000,
    amount_usd: null,
    ...overrides,
  };
}

const marchDeposits = {
  rows: [
    depositRow(),
    depositRow({
      category: "brokerage",
      category_label: "Brokerage",
      account_id: 40,
      account_name: "SPY",
      kind_slug: "spy",
      amount_clp: 500_000,
    }),
  ],
};

describe("aggregateFlowsOverview", () => {
  it("splits a linked mortgage payment: carrying → expenses, amortización → deposits", () => {
    const rows = aggregateFlowsOverview(incomePayload(), { lines: [mortgageLine()] }, marchDeposits);
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march).toBeDefined();
    expect(march!.income).toBe(2_000_000);
    // Interest + insurance only; amortización must not count as a gasto.
    expect(march!.expenses).toBe(400_000);
    // Property deposit records the full dividendo; the carrying portion moves to expenses.
    expect(march!.deposits).toBe(1_500_000 - 400_000);
    // The single checking outflow lands exactly once across expenses + deposits.
    expect(march!.expenses + march!.deposits).toBe(1_000_000 + 500_000);
    expect(march!.net).toBe(march!.income - march!.expenses - march!.deposits);
  });

  it("subtracts carrying once when two lines share the same link", () => {
    const rows = aggregateFlowsOverview(
      incomePayload(),
      { lines: [mortgageLine(), mortgageLine({ statement_line_id: 2 })] },
      marchDeposits
    );
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march!.deposits).toBe(1_500_000 - 400_000);
  });

  it("throws in USD display when deposits carry an FX conversion error", () => {
    const income = incomePayload();
    income.lines[0]!.amount_usd = 2_000;
    expect(() =>
      aggregateFlowsOverview(
        income,
        { lines: [] },
        { ...marchDeposits, fx_conversion_error: true },
        "split",
        "usd"
      )
    ).toThrow(/FX/);
  });

  it("splits pre-tax AFP/AFC cotizaciones out of post-tax deposits and net", () => {
    const rows = aggregateFlowsOverview(
      incomePayload(),
      { lines: [] },
      {
        rows: [
          ...marchDeposits.rows,
          depositRow({
            category: "inversiones",
            category_label: "Retirement",
            account_id: 50,
            account_name: "AFP",
            kind_slug: "afp",
            amount_clp: 300_000,
          }),
          // Retiro: negative afp event reached checking → stays in post-tax deposits.
          depositRow({
            category: "inversiones",
            category_label: "Retirement",
            account_id: 50,
            account_name: "AFP",
            kind_slug: "afp",
            amount_clp: -200_000,
          }),
        ],
      }
    );
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march!.deposits_pre_tax).toBe(300_000);
    expect(march!.deposits).toBe(1_500_000 - 200_000);
    expect(march!.net).toBe(2_000_000 - march!.deposits);
  });

  it("rolls up months into calendar years with matching totals", () => {
    const rows = aggregateFlowsOverview(incomePayload(), { lines: [mortgageLine()] }, marchDeposits);
    const years = rollupFlowsOverviewRowsByYear(rows);
    const y2024 = years.find((r) => r.period_month === "2024-12");
    expect(y2024!.income).toBe(2_000_000);
    expect(y2024!.expenses).toBe(400_000);
    expect(y2024!.deposits).toBe(1_100_000);
    const totals = flowsOverviewTotals(rows);
    expect(totals.income).toBe(years.reduce((s, r) => s + r.income, 0));
    expect(totals.net).toBe(totals.income - totals.expenses - totals.deposits);
  });
});
