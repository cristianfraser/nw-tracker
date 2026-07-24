import { addCalendarMonths, chileTodayYmd, monthEndUtcYmd, ymCompare } from "./calendarMonth";
import {
  aggregateGastosFromLines,
  expenseLineGastosAmount,
  hasSplittableMortgageExpenseDepositLink,
  mortgageLinkCarryingAmount,
} from "./ccExpenseGastosAggregate";
import { gastosDayForLine } from "./ccExpenseGastosDaily";
import { countsTowardGastosMes } from "./ccExpenseLineBuckets";
import {
  gastosScopeAllowsMode,
  gastosSumMonthForLine,
  type CcInstallmentGastosMode,
} from "./ccExpensePeriodMonth";
import { aggregateIncomeChartPointsByDay, aggregateIncomeFromPayload } from "./incomeAggregates";
import type { DisplayUnit } from "./queries/keys";
import type {
  FlowCcExpenseLineRow,
  FlowsCreditCardExpensesResponse,
  FlowsDepositsResponse,
  FlowsIncomeResponse,
  FlowsPlResponse,
} from "./types";

export type FlowsOverviewMonthRow = {
  period_month: string;
  /** Month-end date (chart x key). */
  as_of_date: string;
  /** Cartola abonos + manual income (payroll-month attribution). */
  income: number;
  /** Gastos del mes — linked mortgage payments count only interest + insurance (carrying). */
  expenses: number;
  /**
   * Post-tax net deposits — linked mortgage deposits count only amortización (carrying lives
   * in expenses) and pre-tax AFP/AFC cotizaciones live in `deposits_pre_tax`.
   */
  deposits: number;
  /**
   * AFP/AFC cotizaciones (positive events only): payroll-deducted pre-tax, they never pass
   * through checking, so they must not count against post-tax income in `net`. Retiros
   * (negative afp/afc events) DO reach checking and stay in `deposits` — that keeps a retiro
   * neutral (AFP outflow offsets the checking Δ it funds).
   */
  deposits_pre_tax: number;
  /** Market P/L of the money buckets (brokerage/retiro/efectivo) — informational, excluded from `net`. */
  pl: number;
  /** income − expenses − deposits (post-tax). */
  net: number;
};

/** Payroll-deducted pre-tax deposit kinds — money that never passes through checking. */
const PRE_TAX_DEPOSIT_KIND_SLUGS = new Set(["afp", "afc"]);

/**
 * Carrying (interest + insurance) per month of the property deposit movement, for every
 * splittable mortgage expense_deposit_link. The property-account deposit records the FULL
 * dividendo (pago), while gastos already counts the carrying portion as an expense — so the
 * deposits series must keep only the amortización or the carrying is double counted.
 */
function mortgageCarryingByDepositMonth(
  lines: readonly FlowCcExpenseLineRow[],
  installmentMode: CcInstallmentGastosMode,
  unit: DisplayUnit
): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const ln of lines) {
    // A card-financed dividendo exists twice in `lines` (original `total_only` line +
    // prorated `split_only` financing projections, all sharing one deposit link under
    // distinct purchase_keys), so the carrying must be scoped to one mode like gastos —
    // otherwise it is subtracted once per representation.
    if (!gastosScopeAllowsMode(ln, installmentMode)) continue;
    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (!hasSplittableMortgageExpenseDepositLink(link)) continue;
    const key = `${ln.purchase_key}|${link.deposit_movement_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!link.depto_occurred_on) {
      throw new Error(
        `mortgage expense deposit link without depto_occurred_on: ${ln.purchase_key}`
      );
    }
    const month = link.depto_occurred_on.slice(0, 7);
    const carrying = mortgageLinkCarryingAmount(ln, link, unit);
    out.set(month, (out.get(month) ?? 0) + carrying);
  }
  return out;
}

/** Keep in sync with the tail-clip in ExpensesPage: installment cuotas create future $0 buckets. */
function latestNonEmptyGastosMonth(
  byMonth: readonly { period_month: string; gastos_real_mes_clp: number }[]
): string | null {
  let latest: string | null = null;
  for (const row of byMonth) {
    if (row.gastos_real_mes_clp !== 0 && (latest == null || row.period_month > latest)) {
      latest = row.period_month;
    }
  }
  return latest;
}

export function aggregateFlowsOverview(
  income: FlowsIncomeResponse,
  ccExpenses: Pick<FlowsCreditCardExpensesResponse, "lines">,
  deposits: Pick<FlowsDepositsResponse, "rows" | "fx_conversion_error">,
  pl: Pick<FlowsPlResponse, "chart_monthly" | "chart_monthly_usd">,
  installmentMode: CcInstallmentGastosMode = "split",
  unit: DisplayUnit = "clp"
): FlowsOverviewMonthRow[] {
  type Bucket = {
    income: number;
    expenses: number;
    deposits: number;
    depositsPreTax: number;
    pl: number;
  };
  const byMonth = new Map<string, Bucket>();
  const touch = (ym: string): Bucket => {
    const existing = byMonth.get(ym);
    if (existing) return existing;
    const fresh: Bucket = { income: 0, expenses: 0, deposits: 0, depositsPreTax: 0, pl: 0 };
    byMonth.set(ym, fresh);
    return fresh;
  };

  const incomeAgg = aggregateIncomeFromPayload(income, unit);
  for (const row of incomeAgg.by_month) {
    touch(row.period_month).income += row.total_clp;
  }

  const gastos = aggregateGastosFromLines(ccExpenses.lines, [], installmentMode, undefined, unit);
  const latestGastosMonth = latestNonEmptyGastosMonth(gastos.by_month);
  for (const row of gastos.by_month) {
    if (latestGastosMonth != null && row.period_month > latestGastosMonth) continue;
    touch(row.period_month).expenses += row.gastos_mes_clp;
  }

  if (unit === "usd" && deposits.fx_conversion_error) {
    throw new Error("missing FX conversion for deposits in USD display");
  }
  for (const row of deposits.rows) {
    let amount: number = row.amount_clp;
    if (unit === "usd") {
      if (row.amount_usd == null) {
        throw new Error(`missing amount_usd for deposit on account ${row.account_id}`);
      }
      amount = row.amount_usd;
    }
    const bucket = touch(row.occurred_on.slice(0, 7));
    if (PRE_TAX_DEPOSIT_KIND_SLUGS.has(row.kind_slug) && row.amount_clp > 0) {
      bucket.depositsPreTax += amount;
    } else {
      bucket.deposits += amount;
    }
  }
  for (const [month, carrying] of mortgageCarryingByDepositMonth(
    ccExpenses.lines,
    installmentMode,
    unit
  )) {
    touch(month).deposits -= carrying;
  }

  const plSeries = unit === "usd" ? pl.chart_monthly_usd : pl.chart_monthly;
  for (const point of plSeries) {
    touch(point.as_of_date.slice(0, 7)).pl += point.total;
  }

  const months = [...byMonth.keys()].sort(ymCompare);
  if (months.length === 0) return [];
  const rows: FlowsOverviewMonthRow[] = [];
  // Actuals only: future installment-cuota months (split mode) stay on the expenses page.
  const todayYm = chileTodayYmd().slice(0, 7);
  const lastDataYm = months[months.length - 1]!;
  const last = ymCompare(lastDataYm, todayYm) > 0 ? todayYm : lastDataYm;
  for (let ym = months[0]!; ymCompare(ym, last) <= 0; ym = addCalendarMonths(ym, 1)) {
    const b = byMonth.get(ym) ?? {
      income: 0,
      expenses: 0,
      deposits: 0,
      depositsPreTax: 0,
      pl: 0,
    };
    const round = (v: number) => (unit === "clp" ? Math.round(v) : v);
    const incomeAmt = round(b.income);
    const expensesAmt = round(b.expenses);
    const depositsAmt = round(b.deposits);
    rows.push({
      period_month: ym,
      as_of_date: monthEndUtcYmd(ym),
      income: incomeAmt,
      expenses: expensesAmt,
      deposits: depositsAmt,
      deposits_pre_tax: round(b.depositsPreTax),
      pl: round(b.pl),
      net: incomeAmt - expensesAmt - depositsAmt,
    });
  }
  return rows;
}

/**
 * Per-calendar-day overview rows (Diario) — the day-grain mirror of
 * {@link aggregateFlowsOverview}. Same accounting rules (pre-tax deposit split, mortgage
 * carrying subtracted from deposits, P/L informational and outside `net`); only the bucket key
 * changes from calendar month to calendar day:
 *
 * - income: the day it was received (not payroll-month attribution — see
 *   `aggregateIncomeChartPointsByDay`);
 * - expenses: {@link gastosDayForLine} (purchase day, cuotas on their facturación's pay-by);
 * - deposits: the event day;
 * - P/L: the server's per-day bucket P/L (`chart_daily`), already windowed to the range.
 *
 * Rows are emitted only for days that carry something — the chart densifies the gaps.
 */
export function aggregateFlowsOverviewByDay(
  income: FlowsIncomeResponse,
  ccExpenses: Pick<FlowsCreditCardExpensesResponse, "lines" | "cuota_pay_by_iso">,
  deposits: Pick<FlowsDepositsResponse, "rows" | "fx_conversion_error">,
  plDaily: readonly { as_of_date: string; total: number }[],
  installmentMode: CcInstallmentGastosMode = "split",
  unit: DisplayUnit = "clp"
): FlowsOverviewMonthRow[] {
  type Bucket = {
    income: number;
    expenses: number;
    deposits: number;
    depositsPreTax: number;
    pl: number;
  };
  const byDay = new Map<string, Bucket>();
  const touch = (day: string): Bucket => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: Bucket = { income: 0, expenses: 0, deposits: 0, depositsPreTax: 0, pl: 0 };
    byDay.set(day, fresh);
    return fresh;
  };

  for (const point of aggregateIncomeChartPointsByDay(income, unit)) {
    touch(point.as_of_date).income += point.total;
  }

  for (const ln of ccExpenses.lines) {
    if (!gastosSumMonthForLine(ln, installmentMode)) continue;
    if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
      continue;
    }
    const day = gastosDayForLine(ln, ccExpenses.cuota_pay_by_iso);
    if (!day) continue;
    const amount = expenseLineGastosAmount(ln, unit);
    if (amount <= 0) continue;
    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (hasSplittableMortgageExpenseDepositLink(link)) {
      if (
        (ln.line_role !== "installment_purchase_total" || installmentMode === "total") &&
        (ln.line_role !== "installment_cuota" || installmentMode === "split")
      ) {
        touch(day).expenses += mortgageLinkCarryingAmount(ln, link, unit);
      }
      continue;
    }
    if (countsTowardGastosMes(ln, installmentMode)) touch(day).expenses += amount;
  }

  if (unit === "usd" && deposits.fx_conversion_error) {
    throw new Error("missing FX conversion for deposits in USD display");
  }
  for (const row of deposits.rows) {
    let amount: number = row.amount_clp;
    if (unit === "usd") {
      if (row.amount_usd == null) {
        throw new Error(`missing amount_usd for deposit on account ${row.account_id}`);
      }
      amount = row.amount_usd;
    }
    const bucket = touch(row.occurred_on.slice(0, 10));
    if (PRE_TAX_DEPOSIT_KIND_SLUGS.has(row.kind_slug) && row.amount_clp > 0) {
      bucket.depositsPreTax += amount;
    } else {
      bucket.deposits += amount;
    }
  }
  // Carrying already counts as an expense above, so the property deposit keeps amortización only.
  for (const [day, carrying] of mortgageCarryingByDepositDay(
    ccExpenses.lines,
    installmentMode,
    unit
  )) {
    touch(day).deposits -= carrying;
  }

  for (const point of plDaily) {
    touch(point.as_of_date).pl += point.total;
  }

  const round = (v: number) => (unit === "clp" ? Math.round(v) : v);
  return [...byDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => {
      const b = byDay.get(day)!;
      const incomeAmt = round(b.income);
      const expensesAmt = round(b.expenses);
      const depositsAmt = round(b.deposits);
      return {
        period_month: day,
        as_of_date: day,
        income: incomeAmt,
        expenses: expensesAmt,
        deposits: depositsAmt,
        deposits_pre_tax: round(b.depositsPreTax),
        pl: round(b.pl),
        net: incomeAmt - expensesAmt - depositsAmt,
      };
    });
}

/** Day-grain twin of {@link mortgageCarryingByDepositMonth}, keyed by the depto payment day. */
function mortgageCarryingByDepositDay(
  lines: readonly FlowCcExpenseLineRow[],
  installmentMode: CcInstallmentGastosMode,
  unit: DisplayUnit
): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const ln of lines) {
    if (!gastosScopeAllowsMode(ln, installmentMode)) continue;
    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (!hasSplittableMortgageExpenseDepositLink(link)) continue;
    const key = `${ln.purchase_key}|${link.deposit_movement_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!link.depto_occurred_on) {
      throw new Error(
        `mortgage expense deposit link without depto_occurred_on: ${ln.purchase_key}`
      );
    }
    const day = link.depto_occurred_on.slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + mortgageLinkCarryingAmount(ln, link, unit));
  }
  return out;
}

export function rollupFlowsOverviewRowsByYear(
  rows: readonly FlowsOverviewMonthRow[]
): FlowsOverviewMonthRow[] {
  const byYear = new Map<string, FlowsOverviewMonthRow>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        ...row,
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
      });
      continue;
    }
    cur.income += row.income;
    cur.expenses += row.expenses;
    cur.deposits += row.deposits;
    cur.deposits_pre_tax += row.deposits_pre_tax;
    cur.pl += row.pl;
    cur.net += row.net;
  }
  return [...byYear.keys()].sort().map((year) => byYear.get(year)!);
}

export function flowsOverviewTotals(rows: readonly FlowsOverviewMonthRow[]): {
  income: number;
  expenses: number;
  deposits: number;
  deposits_pre_tax: number;
  pl: number;
  net: number;
} {
  let income = 0;
  let expenses = 0;
  let deposits = 0;
  let deposits_pre_tax = 0;
  let pl = 0;
  for (const row of rows) {
    income += row.income;
    expenses += row.expenses;
    deposits += row.deposits;
    deposits_pre_tax += row.deposits_pre_tax;
    pl += row.pl;
  }
  return { income, expenses, deposits, deposits_pre_tax, pl, net: income - expenses - deposits };
}
