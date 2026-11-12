/**
 * Additional-card spending vs the reimbursements paying it back («Tarjetas adicionales»).
 *
 * An additional cardholder's charges on the user's card (origin in the registry's
 * `additional_card_last4s`) are auto-tagged `additional_card`. The cardholder pays them back by wires
 * into checking, which are refunds in that category (`checkingExpenseRefunds.ts`): negative gastos
 * lines, so the category itself nets to what he still owes. This section shows the two sides per
 * month / year: charges, reimbursements, net and the running balance owed.
 */
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardExpenseMatch.js";
import { ADDITIONAL_CARD_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { countsTowardGastosMes, type GastosMesLine } from "./flowsExpensesGastos.js";
import type { LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";
import { lineAmount, lineValueIn } from "./lineMoney.js";

/** The fields of a finished gastos line (`FlowCcExpenseLineRow`, after «line money») the summary reads. */
export type AdditionalCardChargeLineInput = GastosMesLine & {
  source: "cc" | "checking" | "manual" | "payslip";
  origin_card_last4?: string | null;
  primary_card_last4?: string | null;
  expense_month: string;
  amount?: Money;
  values?: Record<string, LineUnitValue>;
};

export type AdditionalCardsPeriodRow = {
  /** YYYY-MM (a year row: YYYY-12). */
  period_month: string;
  as_of_date: string;
  /** Signed: charges +, notas de crédito −. Null when a line of the period has no value in the unit. */
  charges: number | null;
  charge_count: number;
  reimbursements: number | null;
  reimbursement_count: number;
  /** charges − reimbursements. */
  net: number | null;
  /** Running Σ net through the period: what the cardholder still owes (negative = paid ahead). */
  balance: number | null;
};

export type AdditionalCardsSummary = {
  /** The display unit every amount is in. */
  unit: string;
  /** Oldest first. */
  by_month: AdditionalCardsPeriodRow[];
  by_year: AdditionalCardsPeriodRow[];
  totals: {
    charges: number | null;
    reimbursements: number | null;
    balance: number | null;
  };
};

/**
 * A charge the additional cardholder owes: an additional-card CC line the user left in
 * `additional_card`, counted the way it bills — what counts toward gasto del mes in «Por cuota»
 * mode (`countsTowardGastosMes`: one-shots and cuotas, never an installment purchase total). A line
 * the user recategorized is his own spend.
 */
export function isAdditionalCardChargeLine(line: AdditionalCardChargeLineInput): boolean {
  if (line.source !== "cc") return false;
  if (!isAdditionalCardExpenseLine(line.origin_card_last4, line.primary_card_last4)) return false;
  if (line.category_slug !== ADDITIONAL_CARD_CC_EXPENSE_SLUG) return false;
  return countsTowardGastosMes(line, "split");
}

/** A reimbursement: a checking refund line (negative) in `additional_card`. */
export function isAdditionalCardReimbursementLine(line: AdditionalCardChargeLineInput): boolean {
  return line.source === "checking" && line.category_slug === ADDITIONAL_CARD_CC_EXPENSE_SLUG && lineAmount(line).value < 0;
}

type Bucket = {
  charges: number | null;
  charge_count: number;
  reimbursements: number | null;
  reimbursement_count: number;
};

function emptyBucket(): Bucket {
  return { charges: 0, charge_count: 0, reimbursements: 0, reimbursement_count: 0 };
}

function add(total: number | null, v: number | null): number | null {
  return total == null || v == null ? null : total + v;
}

function sub(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

function monthEndIso(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, "0")}`;
}

function periodRows(
  buckets: Map<string, Bucket>,
  asOfDate: (period: string) => string
): AdditionalCardsPeriodRow[] {
  let balance: number | null = 0;
  return [...buckets.keys()].sort().map((period) => {
    const b = buckets.get(period)!;
    const net = sub(b.charges, b.reimbursements);
    balance = add(balance, net);
    return {
      period_month: period,
      as_of_date: asOfDate(period),
      charges: b.charges,
      charge_count: b.charge_count,
      reimbursements: b.reimbursements,
      reimbursement_count: b.reimbursement_count,
      net,
      balance,
    };
  });
}

/**
 * Charges and reimbursements, each by its gastos month (a reimbursement's is the day it arrived),
 * in `unit` (each line's value in it, `lineValueIn`; pesos are every line's).
 */
export function buildAdditionalCardsSummary(
  lines: readonly AdditionalCardChargeLineInput[],
  unit: string = "clp"
): AdditionalCardsSummary {
  const byMonth = new Map<string, Bucket>();
  const touch = (ym: string): Bucket => {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`invalid additional-card period month: ${ym}`);
    let b = byMonth.get(ym);
    if (!b) {
      b = emptyBucket();
      byMonth.set(ym, b);
    }
    return b;
  };
  const valueOf = (line: AdditionalCardChargeLineInput): number | null => {
    const v = lineValueIn(line, unit);
    if (v == null && unit === "clp") throw new Error(`additional-card line ${line.expense_month} without its pesos`);
    return v;
  };
  for (const line of lines) {
    if (isAdditionalCardChargeLine(line)) {
      const b = touch(line.expense_month);
      b.charges = add(b.charges, valueOf(line));
      b.charge_count += 1;
    } else if (isAdditionalCardReimbursementLine(line)) {
      const b = touch(line.expense_month);
      const v = valueOf(line);
      b.reimbursements = add(b.reimbursements, v == null ? null : -v);
      b.reimbursement_count += 1;
    }
  }

  const byYear = new Map<string, Bucket>();
  for (const [ym, b] of byMonth) {
    const year = `${ym.slice(0, 4)}-12`;
    const y = byYear.get(year) ?? emptyBucket();
    y.charges = add(y.charges, b.charges);
    y.charge_count += b.charge_count;
    y.reimbursements = add(y.reimbursements, b.reimbursements);
    y.reimbursement_count += b.reimbursement_count;
    byYear.set(year, y);
  }

  const by_month = periodRows(byMonth, monthEndIso);
  const by_year = periodRows(byYear, (p) => `${p.slice(0, 4)}-12-31`);
  let charges: number | null = 0;
  let reimbursements: number | null = 0;
  for (const row of by_year) {
    charges = add(charges, row.charges);
    reimbursements = add(reimbursements, row.reimbursements);
  }
  return {
    unit,
    by_month,
    by_year,
    totals: { charges, reimbursements, balance: sub(charges, reimbursements) },
  };
}
