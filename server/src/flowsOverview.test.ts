import { describe, expect, it } from "vitest";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { buildFlowsDepositsPayload } from "./flowsDeposits.js";
import { cachedMortgageCarryingEvents } from "./flowsMortgageCarrying.js";
import { buildFlowsPlPayload } from "./flowsPl.js";
import {
  aggregateFlowsOverviewDays,
  aggregateFlowsOverviewMonths,
  buildFlowsOverviewPayload,
  flowsOverviewClosed,
  flowsOverviewTotals,
  type FlowsOverviewDepositRow,
  type FlowsOverviewIncome,
  type FlowsOverviewMonthInputs,
} from "./flowsOverview.js";

const TODAY = "2024-04-15";
const CHECKING_ID = 20;
const CHECKING = new Set([CHECKING_ID]);

/** Checking value per day over `from..TODAY`: `steps` sets the value from that day on. */
function checkingValue(steps: Record<string, number> = {}, from = "2023-12-01"): Map<string, number> {
  const out = new Map<string, number>();
  let value = 0;
  for (let d = from; d <= TODAY; d = chileCalendarAddDays(d, 1)) {
    if (steps[d] != null) value = steps[d]!;
    out.set(d, value);
  }
  return out;
}

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
    category_slug: "deposits",
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
  } as FlowCcExpenseLineRow;
}

function incomePayload(): FlowsOverviewIncome {
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
    work_earnings: [],
    income_kind_by_movement_id: {},
    payroll_period_by_movement_id: {},
  };
}

function depositRow(overrides: Partial<FlowsOverviewDepositRow> = {}): FlowsOverviewDepositRow {
  return {
    occurred_on: "2024-03-11",
    account_id: 30,
    kind_slug: "property",
    amount_clp: 1_000_000,
    amount_usd: null,
    ...overrides,
  };
}

const DAY_EXTRA = { checkingAccountIds: CHECKING, cardPayments: [], checkingValueByDay: checkingValue() };

const marchDeposits = [depositRow(), depositRow({ kind_slug: "spy", amount_clp: 500_000 })];

function gastosMonth(period_month: string, gastos_mes_clp: number, gastos_real_mes_clp = gastos_mes_clp) {
  return { period_month, gastos_mes_clp, gastos_real_mes_clp };
}
/** One mortgageLine(): 1.000.000 paid, 400.000 of it carrying (the gasto). */
const MORTGAGE_MARCH = [gastosMonth("2024-03", 400_000, 1_000_000)];

function months(
  overrides: Partial<FlowsOverviewMonthInputs> = {},
  mode: "split" | "total" = "split",
  unit: "clp" | "usd" = "clp"
) {
  return aggregateFlowsOverviewMonths(
    {
      income: incomePayload(),
      lines: [],
      gastosByMonth: [],
      deposits: marchDeposits,
      plMonthly: [],
      checkingAccountIds: CHECKING,
      cardPayments: [],
      checkingValueByDay: checkingValue(),
      ...overrides,
    },
    mode,
    unit,
    TODAY
  );
}

const march = (rows: ReturnType<typeof months>) => rows.find((r) => r.period_month === "2024-03")!;

describe("aggregateFlowsOverviewMonths", () => {
  it("a payslip deduction counted as a gasto is added back to income: net does not move", () => {
    const deduction = mortgageLine({
      source: "payslip",
      statement_line_id: 7_001,
      account_id: 0,
      category_slug: "healthcare",
      amount_clp: 80_000,
      amount_usd_at_expense: 90,
      occurred_on: "2024-03-29",
      purchase_on: "2024-03-29",
      purchase_key: "payslip:7001",
      expense_deposit_links: [],
    });
    const before = march(months());
    const after = march(months({ lines: [deduction], gastosByMonth: [gastosMonth("2024-03", 80_000)] }));
    expect(after.expenses - before.expenses).toBe(80_000);
    expect(after.income - before.income).toBe(80_000);
    expect(after.savings).toBe(before.savings);
    expect(after.net_worth_change).toBe(before.net_worth_change);
    const daily = aggregateFlowsOverviewDays(
      { income: incomePayload(), lines: [deduction], cuotaPayByIso: {}, deposits: marchDeposits, plDaily: [], ...DAY_EXTRA },
      "split",
      "clp"
    );
    const day = daily.find((r) => r.as_of_date === "2024-03-29")!;
    expect(day.income).toBe(80_000);
    expect(day.expenses).toBe(80_000);
  });

  it("splits a linked mortgage payment: carrying → expenses, amortización → deposits", () => {
    // The P/L input is the market P/L (`buildFlowsPlChartMonthly`: the property's carrying already
    // added back), so the property's UF revaluation alone; here none.
    const m = march(
      months({
        lines: [mortgageLine()],
        gastosByMonth: MORTGAGE_MARCH,
        plMonthly: [],
      })
    );
    expect(m.income).toBe(2_000_000);
    expect(m.expenses).toBe(400_000);
    expect(m.deposits).toBe(1_500_000 - 400_000);
    expect(m.pl).toBe(0);
    // The property gained its amortización, SPY the 500.000: deposits + P/L.
    expect(m.investments_change).toBe(600_000 + 500_000);
    expect(m.net_worth_change).toBe(m.savings);
  });

  it("subtracts carrying once when two lines share the same link", () => {
    const m = march(
      months({
        lines: [mortgageLine(), mortgageLine({ statement_line_id: 2 })],
        gastosByMonth: [gastosMonth("2024-03", 800_000, 2_000_000)],
      })
    );
    expect(m.deposits).toBe(1_500_000 - 400_000);
  });

  it("counts a card-financed dividendo's carrying once per installment mode", () => {
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
      expect(march(months({ lines, gastosByMonth: MORTGAGE_MARCH }, mode)).deposits).toBe(1_500_000 - 400_000);
    }
  });

  it("throws in USD when a deposit has no dollar amount", () => {
    const income = incomePayload();
    income.lines[0]!.amount_usd = 2_000;
    expect(() => months({ income }, "split", "usd")).toThrow(/amount_usd/);
  });

  it("splits pre-tax AFP/AFC cotizaciones out of post-tax deposits", () => {
    const m = march(
      months({
        deposits: [
          ...marchDeposits,
          depositRow({ kind_slug: "afp", amount_clp: 300_000 }),
          // Retiro: a negative afp event reached checking → stays in post-tax deposits.
          depositRow({ kind_slug: "afp", amount_clp: -200_000 }),
        ],
      })
    );
    expect(m.deposits_pre_tax).toBe(300_000);
    expect(m.deposits).toBe(1_500_000 - 200_000);
    expect(m.net_worth_change).toBe(m.savings + 300_000);
  });

  it("buckets monthly P/L into the investments and net-worth changes", () => {
    const rows = months({
      plMonthly: [
        { as_of_date: "2024-03-31", total: 300_000 },
        { as_of_date: "2024-04-30", total: -100_000 },
      ],
    });
    expect(march(rows).pl).toBe(300_000);
    expect(march(rows).investments_change).toBe(march(rows).deposits + 300_000);
    expect(march(rows).net_worth_change).toBe(march(rows).savings + 300_000);
    expect(rows.find((r) => r.period_month === "2024-04")!.pl).toBe(-100_000);
  });

  it("puts salary on its payroll month and runs the months through today", () => {
    const income = incomePayload();
    income.income_kind_by_movement_id = { 1: "salary" };
    income.payroll_period_by_movement_id = { 1: "2024-02" };
    const rows = months({ income });
    expect(rows.map((r) => r.period_month)).toEqual(["2024-02", "2024-03", "2024-04"]);
    expect(rows[0]!.income).toBe(2_000_000);
    expect(march(rows).income).toBe(0);
    // Day grain: the day it arrived.
    const days = aggregateFlowsOverviewDays(
      { income, lines: [], cuotaPayByIso: {}, deposits: [], plDaily: [], ...DAY_EXTRA },
      "split",
      "clp"
    );
    expect(days).toEqual([expect.objectContaining({ as_of_date: "2024-03-05", income: 2_000_000 })]);
  });

  it("totals and the closed month / last twelve months come from the month rows", () => {
    const rows = months({
      lines: [mortgageLine()],
      gastosByMonth: MORTGAGE_MARCH,
      plMonthly: [{ as_of_date: "2024-04-30", total: 25_000 }],
    });
    const totals = flowsOverviewTotals(rows);
    expect(totals.income).toBe(2_000_000);
    expect(totals.pl).toBe(25_000);
    expect(totals.savings).toBe(totals.income - totals.expenses);
    expect(totals.net_worth_change).toBe(totals.savings + totals.deposits_pre_tax + totals.pl);
    // April (today's month) is in progress: only March and the months before it count.
    const closed = flowsOverviewClosed(rows, TODAY);
    expect(closed.last_month).toMatchObject({ period_month: "2024-03", income: 2_000_000 });
    expect(closed.last_12_months).toEqual({
      period_month: "2024-03",
      as_of_date: "2024-03-31",
      ...flowsOverviewTotals(rows.filter((r) => r.period_month <= "2024-03")),
    });
    expect(closed.last_12_months.pl).toBe(0);
    const empty = flowsOverviewClosed([], TODAY);
    expect(empty.last_month).toMatchObject({ period_month: "2024-03", as_of_date: "2024-03-31", savings: 0, cash_unexplained: 0 });
  });
});

describe("aggregateFlowsOverviewDays", () => {
  it("buckets each leg on its own day and keeps the monthly accounting rules", () => {
    const rows = aggregateFlowsOverviewDays(
      {
        income: incomePayload(),
        lines: [mortgageLine()],
        cuotaPayByIso: {},
        deposits: marchDeposits,
        plDaily: [{ as_of_date: "2024-03-20", total: 75_000 }],
        ...DAY_EXTRA,
      },
      "split",
      "clp"
    );
    expect(rows.find((r) => r.as_of_date === "2024-03-05")!.income).toBe(2_000_000);
    const payDay = rows.find((r) => r.as_of_date === "2024-03-11")!;
    expect(payDay.expenses).toBe(400_000);
    expect(payDay.deposits).toBe(1_000_000 + 500_000 - 400_000);
    const plDay = rows.find((r) => r.as_of_date === "2024-03-20")!;
    expect(plDay.pl).toBe(75_000);
    expect(plDay.savings).toBe(0);
    for (const r of rows) expect(r.investments_change).toBe(r.deposits + r.deposits_pre_tax + r.pl);
  });

  it("day totals reconcile with the month row over the same month", () => {
    const lines = [mortgageLine()];
    const dayRows = aggregateFlowsOverviewDays(
      {
        income: incomePayload(),
        lines,
        cuotaPayByIso: {},
        deposits: marchDeposits,
        plDaily: [{ as_of_date: "2024-03-20", total: 75_000 }],
        ...DAY_EXTRA,
      },
      "split",
      "clp"
    );
    const m = march(
      months({ lines, gastosByMonth: MORTGAGE_MARCH, plMonthly: [{ as_of_date: "2024-03-31", total: 75_000 }] })
    );
    const dayTotals = flowsOverviewTotals(dayRows.filter((r) => r.as_of_date.startsWith("2024-03")));
    expect(dayTotals.income).toBe(m.income);
    expect(dayTotals.expenses).toBe(m.expenses);
    expect(dayTotals.deposits).toBe(m.deposits);
    expect(dayTotals.pl).toBe(m.pl);
    expect(dayTotals.card_spent).toBe(m.card_spent);
  });

  it("puts a cuota on its facturación's pay-by", () => {
    const cuota = mortgageLine({
      source: "cc",
      line_role: "installment_cuota",
      category_slug: "shopping",
      amount_clp: 30_000,
      billing_month: "2024-03",
      purchase_key: "installment-h:1",
      expense_deposit_links: [],
    });
    const rows = aggregateFlowsOverviewDays(
      {
        income: incomePayload(),
        lines: [cuota],
        cuotaPayByIso: { "10|2024-03": "2024-04-10" },
        deposits: [],
        plDaily: [],
        ...DAY_EXTRA,
      },
      "split",
      "clp"
    );
    expect(rows.find((r) => r.as_of_date === "2024-04-10")!.expenses).toBe(30_000);
  });
});

/** A one-shot card purchase line. */
function cardLine(overrides: Partial<FlowCcExpenseLineRow> = {}): FlowCcExpenseLineRow {
  return mortgageLine({
    source: "cc",
    statement_line_id: 500,
    account_id: 10,
    expense_month: "2024-02",
    billing_month: "2024-02",
    purchase_month: "2024-02",
    occurred_on: "2024-02-10",
    purchase_on: "2024-02-10",
    amount_clp: 200_000,
    amount_usd_at_expense: 210,
    merchant: "TIENDA",
    merchant_key: "TIENDA",
    category_slug: "clothes",
    purchase_key: "line-pr:500",
    expense_deposit_links: [],
    ...overrides,
  });
}

const NO_INCOME = { ...incomePayload(), lines: [] };

describe("cash model", () => {
  it("savings moved into checking from a savings account: negative deposit, cash grows by it", () => {
    // 300.000 out of a savings account (id 31) into checking: the checking leg is cash, not a deposit.
    const deposits = [
      depositRow({ account_id: 31, kind_slug: "cuenta_ahorro", amount_clp: -300_000 }),
      depositRow({ account_id: CHECKING_ID, kind_slug: "cuenta_corriente", amount_clp: 300_000 }),
    ];
    const m = march(
      months({
        deposits,
        gastosByMonth: [gastosMonth("2024-03", 500_000)],
        checkingValueByDay: checkingValue({ "2024-03-05": 2_000_000, "2024-03-11": 1_800_000 }),
      })
    );
    expect(m.deposits).toBe(-300_000);
    expect(m.savings).toBe(2_000_000 - 500_000);
    expect(m.cash_change).toBe(1_800_000);
    expect(m.cash_unexplained).toBe(0);
    expect(m.investments_change).toBe(-300_000);
    expect(m.net_worth_change).toBe(1_500_000);
  });

  it("a card purchase in one month paid the next: cash moves only when the card is paid", () => {
    const rows = months({
      income: NO_INCOME,
      deposits: [],
      lines: [cardLine()],
      gastosByMonth: [gastosMonth("2024-02", 200_000)],
      cardPayments: [{ occurred_on: "2024-03-05", amount: 200_000 }],
      checkingValueByDay: checkingValue({ "2024-01-01": 500_000, "2024-03-05": 300_000 }),
    });
    const feb = rows.find((r) => r.period_month === "2024-02")!;
    expect(feb).toMatchObject({ savings: -200_000, card_spent: 200_000, card_paid: 0, cash_change: 0, cash_unexplained: 0 });
    expect(feb.net_worth_change).toBe(-200_000);
    expect(march(rows)).toMatchObject({ card_spent: 0, card_paid: 200_000, cash_change: -200_000, cash_unexplained: 0 });
    expect(march(rows).net_worth_change).toBe(0);
  });

  it("a purchase in cuotas: «Total» spends it at purchase, «Por cuota» as each cuota bills", () => {
    const total = cardLine({
      line_role: "installment_purchase_total",
      statement_line_id: -9,
      amount_clp: 300_000,
      purchase_key: "installment-h:10:2024-02-10:3:300000:TIENDA",
    });
    const cuota = (n: number, ym: string) =>
      cardLine({
        line_role: "installment_cuota",
        statement_line_id: 600 + n,
        amount_clp: 100_000,
        billing_month: ym,
        expense_month: ym,
        nro_cuota_current: n,
        nro_cuota_total: 3,
        purchase_key: "installment-h:10:2024-02-10:3:300000:TIENDA",
      });
    const lines = [total, cuota(1, "2024-02"), cuota(2, "2024-03"), cuota(3, "2024-04")];
    const cardPayments = [
      { occurred_on: "2024-03-05", amount: 100_000 },
      { occurred_on: "2024-04-05", amount: 100_000 },
    ];
    const value = checkingValue({ "2024-01-01": 500_000, "2024-03-05": 400_000, "2024-04-05": 300_000 });
    const split = months(
      {
        income: NO_INCOME,
        deposits: [],
        lines,
        cardPayments,
        checkingValueByDay: value,
        gastosByMonth: [gastosMonth("2024-02", 100_000), gastosMonth("2024-03", 100_000), gastosMonth("2024-04", 100_000)],
      },
      "split"
    );
    expect(split.map((r) => [r.period_month, r.card_spent, r.card_paid, r.cash_unexplained])).toEqual([
      ["2024-02", 100_000, 0, 0],
      ["2024-03", 100_000, 100_000, 0],
      ["2024-04", 100_000, 100_000, 0],
    ]);
    const tot = months(
      {
        income: NO_INCOME,
        deposits: [],
        lines,
        cardPayments,
        checkingValueByDay: value,
        gastosByMonth: [gastosMonth("2024-02", 300_000)],
      },
      "total"
    );
    expect(tot.map((r) => [r.period_month, r.savings, r.card_spent, r.card_paid, r.cash_change, r.cash_unexplained])).toEqual([
      ["2024-02", -300_000, 300_000, 0, 0, 0],
      ["2024-03", 0, 0, 100_000, -100_000, 0],
      ["2024-04", 0, 0, 100_000, -100_000, 0],
    ]);
  });

  it("a card refund lowers the card's spend; a card payment line is not spend", () => {
    const refund = cardLine({ statement_line_id: 501, amount_clp: -30_000, card_refund: true, purchase_key: "line-pr:501" });
    const payment = cardLine({ statement_line_id: 502, amount_clp: -170_000, merchant: "PAGO", category_slug: "unclassified", purchase_key: "line-pr:502" });
    const feb = months({
      income: NO_INCOME,
      deposits: [],
      lines: [cardLine(), refund, payment],
      gastosByMonth: [gastosMonth("2024-02", 170_000)],
    }).find((r) => r.period_month === "2024-02")!;
    expect(feb.card_spent).toBe(170_000);
    expect(feb.expenses).toBe(170_000);
  });

  it("a mortgage dividendo paid by card: the card spends it whole, carrying in expenses, amortización in deposits", () => {
    const line = mortgageLine({ source: "cc", line_role: "purchase" });
    const m = march(
      months({
        income: NO_INCOME,
        lines: [line],
        gastosByMonth: MORTGAGE_MARCH,
        deposits: [depositRow()],
        cardPayments: [{ occurred_on: "2024-03-20", amount: 1_000_000 }],
        checkingValueByDay: checkingValue({ "2024-01-01": 3_000_000, "2024-03-20": 2_000_000 }),
      })
    );
    expect(m).toMatchObject({ expenses: 400_000, deposits: 600_000, card_spent: 1_000_000, card_paid: 1_000_000 });
    expect(m.cash_change).toBe(-1_000_000);
    expect(m.cash_unexplained).toBe(0);
  });

  it("a transfer between two investments nets to zero", () => {
    const deposits = [
      depositRow({ account_id: 40, kind_slug: "spy", amount_clp: -1_000_000 }),
      depositRow({ account_id: 41, kind_slug: "fintual", amount_clp: 1_000_000 }),
    ];
    const m = march(months({ deposits, plMonthly: [{ as_of_date: "2024-03-31", total: 50_000 }] }));
    expect(m.deposits).toBe(0);
    expect(m.investments_change).toBe(50_000);
  });

  it("what no leg explains stays visible", () => {
    // The checking ledger fell 12.000 more than the legs say (a dollar payment's spread, say).
    const m = march(
      months({
        income: NO_INCOME,
        deposits: [],
        cardPayments: [{ occurred_on: "2024-03-08", amount: 100_000 }],
        checkingValueByDay: checkingValue({ "2024-01-01": 500_000, "2024-03-08": 388_000 }),
      })
    );
    expect(m.cash_change).toBe(-112_000);
    expect(m.cash_unexplained).toBe(-12_000);
  });

  it("the month in progress reads the ledger on today, day rows carry each day's change", () => {
    const value = checkingValue({ "2024-04-03": 80_000, "2024-04-12": 50_000 });
    const april = months({ checkingValueByDay: value }).find((r) => r.period_month === "2024-04")!;
    expect(april.cash_change).toBe(50_000);
    const dayRows = aggregateFlowsOverviewDays(
      { income: incomePayload(), lines: [], cuotaPayByIso: {}, deposits: [], plDaily: [], ...DAY_EXTRA, checkingValueByDay: value },
      "split",
      "clp"
    );
    expect(dayRows.find((r) => r.as_of_date === "2024-04-03")!.cash_change).toBe(80_000);
    expect(dayRows.find((r) => r.as_of_date === "2024-04-12")!.cash_change).toBe(-30_000);
  });

  it("throws when the checking value map misses a month boundary", () => {
    expect(() => months({ checkingValueByDay: checkingValue({}, "2024-03-01") })).toThrow(/checking value not computed/);
  });
});

describe("buildFlowsOverviewPayload", () => {
  it("reads its P/L from the /flows P/L page's builder: the same total every month", () => {
    const today = chileCalendarTodayYmd();
    for (const unit of ["clp", "usd"] as const) {
      const overview = buildFlowsOverviewPayload(unit, "split", null);
      const page = buildFlowsPlPayload();
      const pageByMonth = new Map(
        (unit === "usd" ? page.chart_monthly_usd : page.chart_monthly).map((p) => [p.as_of_date.slice(0, 7), p.total])
      );
      for (const r of overview.months) {
        if (r.period_month > today.slice(0, 7)) continue;
        const pageTotal = pageByMonth.get(r.period_month) ?? 0;
        expect(r.pl).toBeCloseTo(unit === "clp" ? Math.round(pageTotal) : pageTotal, 6);
      }
    }
  });

  it("deposits + pre-tax equal the /flows/deposits page, month by month", () => {
    const overview = buildFlowsOverviewPayload("clp", "split", null);
    const page = buildFlowsDepositsPayload({
      excludeCheckingAccounts: true,
      withMortgageCarrying: { clp: cachedMortgageCarryingEvents("clp"), usd: cachedMortgageCarryingEvents("usd") },
    });
    const byMonth = new Map<string, number>();
    for (const r of page.rows) byMonth.set(r.occurred_on.slice(0, 7), (byMonth.get(r.occurred_on.slice(0, 7)) ?? 0) + r.amount_clp);
    for (const r of overview.months) {
      expect(r.deposits + r.deposits_pre_tax).toBe(Math.round(byMonth.get(r.period_month) ?? 0));
    }
    expect(Math.round(page.pre_tax_total_clp)).toBe(overview.totals.deposits_pre_tax);
  });

  it("serves month rows with consistent totals and the closed periods, day rows on request", () => {
    const today = chileCalendarTodayYmd();
    const p = buildFlowsOverviewPayload("clp", "split", 30);
    expect(p.totals).toEqual(flowsOverviewTotals(p.months));
    const lastYm = addCalendarMonths(today.slice(0, 7), -1);
    expect(p.closed.last_month.period_month).toBe(lastYm);
    expect(p.closed.last_12_months.period_month).toBe(lastYm);
    for (const r of [...p.months, ...p.days!]) {
      expect(r.savings).toBe(r.income - r.expenses);
      expect(r.cash_unexplained).toBe(r.cash_change - (r.savings - r.deposits + r.card_spent - r.card_paid));
      expect(r.investments_change).toBe(r.deposits + r.deposits_pre_tax + r.pl);
      expect(r.net_worth_change).toBe(r.savings + r.deposits_pre_tax + r.pl);
    }
    const windowStart = chileCalendarAddDays(today, -29);
    for (const r of p.days!) expect(r.as_of_date >= windowStart).toBe(true);
    expect(buildFlowsOverviewPayload("clp", "split", null).days).toBeNull();
  });
});
