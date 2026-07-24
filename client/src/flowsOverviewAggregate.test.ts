import { describe, expect, it } from "vitest";
import { DEPOSITS_CC_EXPENSE_SLUG } from "./ccExpenseLineBuckets";
import {
  aggregateFlowsOverview,
  aggregateFlowsOverviewByDay,
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

const noPl = { chart_monthly: [], chart_monthly_usd: [] };

function plPoint(overrides: Partial<import("./types").FlowsPlChartPoint> = {}) {
  return {
    as_of_date: "2024-03-31",
    brokerage: 0,
    retirement: 0,
    cash: 0,
    total: 0,
    ytd_total: 0,
    cumulative_total: 0,
    ...overrides,
  };
}

describe("aggregateFlowsOverview", () => {
  it("splits a linked mortgage payment: carrying → expenses, amortización → deposits", () => {
    const rows = aggregateFlowsOverview(
      incomePayload(),
      { lines: [mortgageLine()] },
      marchDeposits,
      noPl
    );
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
      marchDeposits,
      noPl
    );
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march!.deposits).toBe(1_500_000 - 400_000);
  });

  it("counts a card-financed dividendo's carrying once per installment mode", () => {
    // A financed dividendo exists twice in `lines`: the original (`total_only`) plus
    // prorated `split_only` financing projections sharing the SAME deposit link under
    // distinct purchase_keys. Carrying must land once in either mode.
    const original = mortgageLine({ gastos_scope: "total_only" });
    const projection = (i: number) =>
      mortgageLine({
        statement_line_id: 100 + i,
        purchase_key: `financing-proj:1:${original.purchase_key}:2024-0${3 + i}`,
        gastos_scope: "split_only",
        expense_month: `2024-0${3 + i}`,
        amount_clp: 500_000,
        expense_deposit_links: [
          {
            deposit_movement_id: 99,
            payment_clp: 500_000,
            amortization_clp: 300_000,
            carrying_clp: 200_000,
            depto_cuota: "7",
            depto_occurred_on: "2024-03-11",
            link_source: "auto",
          },
        ],
      });
    const lines = [original, projection(1), projection(2)];
    for (const mode of ["split", "total"] as const) {
      const rows = aggregateFlowsOverview(incomePayload(), { lines }, marchDeposits, noPl, mode);
      const march = rows.find((r) => r.period_month === "2024-03")!;
      expect(march.deposits).toBe(1_500_000 - 400_000);
    }
  });

  it("throws in USD display when deposits carry an FX conversion error", () => {
    const income = incomePayload();
    income.lines[0]!.amount_usd = 2_000;
    expect(() =>
      aggregateFlowsOverview(
        income,
        { lines: [] },
        { ...marchDeposits, fx_conversion_error: true },
        noPl,
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
      },
      noPl
    );
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march!.deposits_pre_tax).toBe(300_000);
    expect(march!.deposits).toBe(1_500_000 - 200_000);
    expect(march!.net).toBe(2_000_000 - march!.deposits);
  });

  it("rolls up months into calendar years with matching totals", () => {
    const rows = aggregateFlowsOverview(
      incomePayload(),
      { lines: [mortgageLine()] },
      marchDeposits,
      noPl
    );
    const years = rollupFlowsOverviewRowsByYear(rows);
    const y2024 = years.find((r) => r.period_month === "2024-12");
    expect(y2024!.income).toBe(2_000_000);
    expect(y2024!.expenses).toBe(400_000);
    expect(y2024!.deposits).toBe(1_100_000);
    const totals = flowsOverviewTotals(rows);
    expect(totals.income).toBe(years.reduce((s, r) => s + r.income, 0));
    expect(totals.net).toBe(totals.income - totals.expenses - totals.deposits);
  });

  it("buckets monthly PL totals by unit and keeps them out of net", () => {
    const pl = {
      chart_monthly: [
        plPoint({ brokerage: 250_000, cash: 50_000, total: 300_000 }),
        plPoint({ as_of_date: "2024-04-30", retirement: -100_000, total: -100_000 }),
      ],
      chart_monthly_usd: [plPoint({ brokerage: 300, total: 300 })],
    };
    const rows = aggregateFlowsOverview(incomePayload(), { lines: [] }, marchDeposits, pl);
    const march = rows.find((r) => r.period_month === "2024-03");
    expect(march!.pl).toBe(300_000);
    expect(march!.net).toBe(march!.income - march!.expenses - march!.deposits);
    const april = rows.find((r) => r.period_month === "2024-04");
    expect(april!.pl).toBe(-100_000);

    const usdIncome = incomePayload();
    usdIncome.lines[0]!.amount_usd = 2_000;
    const usdRows = aggregateFlowsOverview(
      usdIncome,
      { lines: [] },
      {
        rows: marchDeposits.rows.map((r) => ({ ...r, amount_usd: r.amount_clp / 1000 })),
      },
      pl,
      "split",
      "usd"
    );
    const usdMarch = usdRows.find((r) => r.period_month === "2024-03");
    expect(usdMarch!.pl).toBe(300);
  });

  it("sums PL in yearly rollup and totals", () => {
    const pl = {
      chart_monthly: [
        plPoint({ brokerage: 100_000, total: 100_000 }),
        plPoint({ as_of_date: "2024-04-30", cash: 25_000, total: 25_000 }),
      ],
      chart_monthly_usd: [],
    };
    const rows = aggregateFlowsOverview(incomePayload(), { lines: [] }, marchDeposits, pl);
    const years = rollupFlowsOverviewRowsByYear(rows);
    const y2024 = years.find((r) => r.period_month === "2024-12");
    expect(y2024!.pl).toBe(125_000);
    const totals = flowsOverviewTotals(rows);
    expect(totals.pl).toBe(125_000);
    expect(totals.net).toBe(totals.income - totals.expenses - totals.deposits);
  });
});

describe("aggregateFlowsOverviewByDay", () => {
  it("buckets each leg on its own day and keeps the monthly accounting rules", () => {
    const rows = aggregateFlowsOverviewByDay(
      incomePayload(),
      { lines: [mortgageLine()] },
      marchDeposits,
      [{ as_of_date: "2024-03-20", total: 75_000 }]
    );

    // income on the day it was received (2024-03-05), not a month bucket
    const incomeDay = rows.find((r) => r.as_of_date === "2024-03-05");
    expect(incomeDay!.income).toBe(2_000_000);

    // the mortgage payment day carries carrying as expense and amortización only as deposit
    const payDay = rows.find((r) => r.as_of_date === "2024-03-11");
    expect(payDay!.expenses).toBe(400_000);
    expect(payDay!.deposits).toBe(1_000_000 + 500_000 - 400_000);

    // P/L rides its own day and stays out of `net`
    const plDay = rows.find((r) => r.as_of_date === "2024-03-20");
    expect(plDay!.pl).toBe(75_000);
    expect(plDay!.net).toBe(0);

    for (const r of rows) expect(r.net).toBe(r.income - r.expenses - r.deposits);
  });

  it("day totals reconcile with the monthly composite over the same month", () => {
    const income = incomePayload();
    const lines = [mortgageLine()];
    const pl = [{ as_of_date: "2024-03-20", total: 75_000 }];

    const dayRows = aggregateFlowsOverviewByDay(income, { lines }, marchDeposits, pl);
    const monthRows = aggregateFlowsOverview(income, { lines }, marchDeposits, {
      chart_monthly: [plPoint({ total: 75_000 })],
      chart_monthly_usd: [],
    });

    const march = monthRows.find((r) => r.period_month === "2024-03")!;
    const dayTotals = flowsOverviewTotals(
      dayRows.filter((r) => r.as_of_date.slice(0, 7) === "2024-03")
    );
    expect(dayTotals.income).toBe(march.income);
    expect(dayTotals.expenses).toBe(march.expenses);
    expect(dayTotals.deposits).toBe(march.deposits);
    expect(dayTotals.pl).toBe(march.pl);
  });

  it("keeps pre-tax AFP/AFC contributions out of the post-tax net", () => {
    const deposits = {
      rows: [
        depositRow({
          category: "inversiones",
          category_label: "Investments",
          account_id: 60,
          account_name: "AFP",
          kind_slug: "afp",
          amount_clp: 300_000,
        }),
      ],
    };
    const rows = aggregateFlowsOverviewByDay(incomePayload(), { lines: [] }, deposits, []);
    const day = rows.find((r) => r.as_of_date === "2024-03-11")!;
    expect(day.deposits_pre_tax).toBe(300_000);
    expect(day.deposits).toBe(0);
    expect(day.net).toBe(0);
  });
});
