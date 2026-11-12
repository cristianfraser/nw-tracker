import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { lineConvertedIn, lineMoneyFromBuilderFields } from "./lineMoney.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";
import { buildFlowsDepositsResponse, flowDepositRowsInUnit } from "./flowsDeposits.js";
import { cachedMortgageCarryingEvents } from "./flowsMortgageCarrying.js";
import { buildAdditionalCardsSummary } from "./additionalCardReimbursements.js";
import {
  buildDepositsReconciliationPayload,
  classifyDepositsReconciliation,
  depositsReconciliationInUnit,
} from "./flowsDepositsReconciliation.js";
import { buildFlowsCheckingIncomePayload, flowsCheckingIncomeListsInUnit } from "./flowsCheckingInflows.js";
import { buildFlowsOverviewPayload, flowsOverviewTotals } from "./flowsOverview.js";
import { buildPayrollBreakdown } from "./payrollBreakdown.js";
import { buildFlowsExpensesGastosPayload } from "./flowsExpensesGastos.js";
import { buildFlowsIncomeAggregates } from "./flowsOverview.js";
import { upcomingMonthsInUnit, type UpcomingPaymentsMonth } from "./upcomingPayments.js";

/** True when `v` carries at most `digits` decimals (float noise aside). */
const roundedTo = (v: number, digits: number) => Math.abs(v * 10 ** digits - Math.round(v * 10 ** digits)) < 1e-6;

/**
 * EUR as a display unit on the expense, deposit and reconciliation surfaces. The synthetic
 * Vitest database has no EUR rates: one `eur_daily` row before every fixture day makes the
 * EUR/CLP mid 1.000 pesos on every day (each reader takes the row on or before its day).
 */
const CLP_PER_EUR = 1_000;
const RATE_DAY = "1990-01-01";

const USD_PER_EUR = 1.1;

// The synthetic market writes EUR rates; this test states its own, so it empties both EUR
// tables first and puts them back after.
const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(RATE_DAY, CLP_PER_EUR);
  db.prepare(`INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`).run(RATE_DAY, USD_PER_EUR);
  clearAggregationCache();
});

afterAll(() => {
  restoreEurTables();
  clearAggregationCache();
});

describe("an expense line in EUR", () => {
  it("a peso line: its pesos at the day's EUR/CLP mid", () => {
    const line = {
      purchase_on: "2099-03-15",
      occurred_on: "2099-03-15",
      ...lineMoneyFromBuilderFields({ amount_clp: 12_345, amount_usd_at_expense: 13 }),
    };
    expect(lineConvertedIn(line, "eur")).toEqual({ value: 12.345, rate_source: "day" });
    // CLP and USD read what the builders reached, untouched.
    expect(lineConvertedIn(line, "clp")).toEqual({ value: 12_345, rate_source: "native" });
    expect(lineConvertedIn(line, "usd")).toEqual({ value: 13, rate_source: "day" });
  });

  it("a card's dollar line paid at its facturación's rate: those pesos, the rate source kept", () => {
    const line = {
      purchase_on: "2099-03-15",
      occurred_on: "2099-03-15",
      ...lineMoneyFromBuilderFields({ amount_clp: 95_000, amount_usd: 100, amount_usd_at_expense: 100, clp_rate_source: "paid" }),
    };
    expect(line.amount).toEqual({ value: 100, currency: "usd" });
    expect(lineConvertedIn(line, "eur")).toEqual({ value: 95, rate_source: "paid" });
    expect(lineConvertedIn(line, "clp")).toEqual({ value: 95_000, rate_source: "paid" });
  });

  it("goes over the wire with `converted` in the requested unit and its pesos", () => {
    const line = {
      purchase_on: "2099-03-15",
      occurred_on: "2099-03-15",
      amount_clp: 95_000,
      ...lineMoneyFromBuilderFields({ amount_clp: 95_000, amount_usd: 100, amount_usd_at_expense: 100, clp_rate_source: "live" }),
    };
    const wire = toWireExpenseLine(line, "eur");
    expect(wire.converted).toEqual({ value: 95, currency: "eur", rate_source: "live" });
    expect(wire.value_clp).toBe(95_000);
    expect("values" in wire).toBe(false);
    expect(toWireExpenseLine(line, "usd").converted).toEqual({ value: 100, currency: "usd", rate_source: "native" });
  });

  it("the additional cards' summary sums the lines' EUR values", () => {
    const base = {
      source: "cc" as const,
      origin_card_last4: "4999",
      primary_card_last4: "4141",
      category_slug: "additional_card",
      line_role: "purchase" as const,
      installment_flag: 0,
      nro_cuota_current: null,
      expense_month: "2099-03",
      purchase_on: "2099-03-15",
      occurred_on: "2099-03-15",
    };
    const summary = buildAdditionalCardsSummary(
      [
        { ...base, ...lineMoneyFromBuilderFields({ amount_clp: 10_000 }) },
        { ...base, ...lineMoneyFromBuilderFields({ amount_clp: 5_000 }) },
      ],
      "eur"
    );
    expect(summary.unit).toBe("eur");
    expect(summary.totals.charges).toBeCloseTo(15, 9);
  });
});

describe("the deposits page in EUR", () => {
  it("each row is its pesos at the day's mid; totals add the rows", () => {
    const opts = { excludeCheckingAccounts: true } as const;
    const clp = buildFlowsDepositsResponse("clp", {
      ...opts,
      withMortgageCarrying: { clp: cachedMortgageCarryingEvents("clp"), unit: cachedMortgageCarryingEvents("clp") },
    });
    const eur = buildFlowsDepositsResponse("eur", {
      ...opts,
      withMortgageCarrying: { clp: cachedMortgageCarryingEvents("clp"), unit: cachedMortgageCarryingEvents("eur") },
    });
    expect(eur.unit).toBe("eur");
    expect(eur.rows.length).toBe(clp.rows.length);
    expect(eur.rows.length).toBeGreaterThan(0);
    for (let i = 0; i < eur.rows.length; i++) {
      const r = eur.rows[i]!;
      if (r.mortgage_carrying) continue;
      expect(r.amount).toBeCloseTo(clp.rows[i]!.amount / CLP_PER_EUR, 9);
    }
    expect(eur.net_total).toBeCloseTo(eur.rows.reduce((s, r) => s + r.amount, 0), 6);
    expect(eur.pre_tax_total + eur.post_tax_total).toBeCloseTo(eur.net_total, 6);
  });

  it("in every unit the rows are the same events, each at its own day's rate", () => {
    const opts = { excludeCheckingAccounts: true } as const;
    const pesos = flowDepositRowsInUnit("clp", opts);
    for (const unit of ["clp", "usd", "eur"] as const) {
      const rows = flowDepositRowsInUnit(unit, opts);
      expect(rows.map((r) => [r.occurred_on, r.account_id, r.amount_clp])).toEqual(
        pesos.map((r) => [r.occurred_on, r.account_id, r.amount_clp])
      );
      expect(rows.map((r) => Math.sign(r.amount))).toEqual(pesos.map((r) => Math.sign(r.amount)));
    }
  });
});

describe("the deposits reconciliation in EUR", () => {
  it("each amount is its pesos at the day's mid; status totals add them", () => {
    const base = classifyDepositsReconciliation();
    const clp = depositsReconciliationInUnit(base, "clp");
    const eur = buildDepositsReconciliationPayload("eur");
    expect(eur.unit).toBe("eur");
    // A dollar deposit converts its own dollars (EUR/USD), every other row its pesos.
    eur.rows.forEach((r, i) => {
      if (base.rows[i]!.native === "usd") return;
      expect(r.amount).toBeCloseTo(clp.rows[i]!.amount! / CLP_PER_EUR, 9);
    });
    for (const [status, t] of Object.entries(eur.by_status)) {
      const sum = eur.rows.filter((r) => r.status === status).reduce((s, r) => s + r.amount!, 0);
      expect(t.total).toBeCloseTo(sum, 6);
    }
    // Pesos are the payload's own pesos.
    expect(clp.rows.map((r) => r.amount)).toEqual(base.rows.map((r) => r.amount_clp));
  });
});

describe("income, payroll and the flows overview in EUR", () => {
  it("an income line is its rounded pesos at the day's mid", () => {
    const base = buildFlowsCheckingIncomePayload();
    const eur = flowsCheckingIncomeListsInUnit(base, "eur");
    expect(eur.lines.length).toBe(base.lines.length);
    eur.lines.forEach((l, i) => expect(l.amount).toBeCloseTo(Math.round(base.lines[i]!.amount_clp) / CLP_PER_EUR, 9));
    const clp = flowsCheckingIncomeListsInUnit(base, "clp");
    expect(clp.lines.map((l) => l.amount)).toEqual(base.lines.map((l) => Math.round(l.amount_clp)));
  });

  it("a payslip's breakdown is its own currency at the pay day's mid", () => {
    const clp = buildPayrollBreakdown("clp");
    const usd = buildPayrollBreakdown("usd");
    const eur = buildPayrollBreakdown("eur");
    expect(eur.unit).toBe("eur");
    expect(eur.payslips.length).toBeGreaterThan(0);
    for (const p of eur.payslips) {
      const inClp = clp.payslips.find((x) => x.payslip_id === p.payslip_id)!.values.net;
      const inUsd = usd.payslips.find((x) => x.payslip_id === p.payslip_id)!.values.net;
      // A peso payslip: its pesos ÷ 1.000; a dollar one: its dollars ÷ 1,1.
      const fromPesos = Math.abs(p.values.net - inClp / CLP_PER_EUR) < 1e-6;
      const fromDollars = Math.abs(p.values.net - inUsd / USD_PER_EUR) < 1e-6;
      expect(fromPesos || fromDollars).toBe(true);
    }
  });

  it("the income month rows are euros rounded to the cent, the same months as in pesos", () => {
    const base = buildFlowsCheckingIncomePayload();
    const clp = buildFlowsIncomeAggregates(base, "clp");
    const eur = buildFlowsIncomeAggregates(base, "eur");
    expect(eur.unit).toBe("eur");
    expect(eur.months.length).toBe(clp.months.length);
    for (const [i, m] of eur.months.entries()) {
      for (const v of [m.salary, m.severance, m.parent_gift, m.rent, m.other, m.total, m.cumulative]) expect(roundedTo(v, 2)).toBe(true);
      expect(m.period_month).toBe(clp.months[i]!.period_month);
      expect(m.line_count).toBe(clp.months[i]!.line_count);
    }
    expect(roundedTo(eur.total, 2)).toBe(true);
  });

  it("the gastos month rows and big groups are euros rounded to the cent", () => {
    const clp = buildFlowsExpensesGastosPayload("clp", new Set(), true);
    const eur = buildFlowsExpensesGastosPayload("eur", new Set(), true);
    const view = eur.views["split|category"]!;
    expect(view.by_month.length).toBeGreaterThan(0);
    for (const r of [...view.by_month, ...view.by_year]) {
      for (const v of [r.gastos_mes, r.gastos_real_mes, r.abonos_mes, r.gastos_acumulado, r.gastos_real_acumulado]) {
        expect(roundedTo(v, 2)).toBe(true);
      }
    }
    expect(roundedTo(view.total, 2)).toBe(true);
    const clpView = clp.views["split|category"]!;
    expect(view.by_month.map((r) => r.period_month)).toEqual(clpView.by_month.map((r) => r.period_month));
    for (const mode of ["split", "total"] as const) {
      expect(eur.big_group_usage[mode].map((g) => g.slug)).toEqual(clp.big_group_usage[mode].map((g) => g.slug));
      for (const g of eur.big_group_usage[mode]) expect(roundedTo(g.total, 2)).toBe(true);
    }
  });

  it("a card's upcoming facturación converts what it owes per currency, never its dollars through pesos", () => {
    const card = {
      billing_month: "2099-10",
      close_date_iso: "2099-10-24",
      close_observed: true,
      close_date_source: "statement" as const,
      pay_by_iso: "2099-11-10",
      pay_by_source: "statement" as const,
      // 100.000 pesos + US$110 at 950 pesos.
      amount_clp: 100_000 + 104_500,
      owed: { clp: 100_000, usd: 110 },
      billed_clp: 204_500,
      overdue: false,
      is_open_month: false,
      is_provisional_close: false,
    };
    const months: UpcomingPaymentsMonth[] = [
      {
        pay_month: "2099-11",
        total_clp: card.amount_clp,
        items: [
          {
            key: "card|1|2099-10",
            kind: "card",
            name: "Card",
            due_iso: "2099-11-10",
            due_kind: "by",
            amount_clp: card.amount_clp,
            amount_max_clp: null,
            estimated: false,
            overdue: false,
            cuota: null,
            cuota_count: null,
            bill_month: null,
            card,
            detail: null,
            wip: false,
            route_path: null,
            due_soon: null,
          },
        ],
      },
    ];
    const [eur] = upcomingMonthsInUnit(months, "eur", "2099-11-01");
    // 100.000 pesos at 1.000 = 100 €; US$110 at 1,1 = 100 €.
    expect(eur!.items[0]!.amount_in_unit).toBeCloseTo(200, 9);
    expect(eur!.total_in_unit).toBeCloseTo(200, 9);
  });

  it("the overview builds in EUR with its identities holding", () => {
    const p = buildFlowsOverviewPayload("eur", "split", null);
    expect(p.unit).toBe("eur");
    expect(p.months.length).toBeGreaterThan(0);
    expect(p.totals).toEqual(flowsOverviewTotals(p.months));
    for (const r of p.months) {
      expect(r.investments_change).toBeCloseTo(r.deposits + r.deposits_pre_tax + r.pl, 6);
      expect(r.savings).toBeCloseTo(r.income - r.expenses, 6);
    }
  });
});
