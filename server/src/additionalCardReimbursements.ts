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
  /** Signed: charges +, notas de crédito −. */
  charges_clp: number;
  /** Null when a line of the period has no USD equivalent. */
  charges_usd: number | null;
  charge_count: number;
  reimbursements_clp: number;
  reimbursements_usd: number | null;
  reimbursement_count: number;
  /** charges − reimbursements. */
  net_clp: number;
  net_usd: number | null;
  /** Running Σ net through the period: what the cardholder still owes (negative = paid ahead). */
  balance_clp: number;
  balance_usd: number | null;
};

export type AdditionalCardsSummary = {
  /** Oldest first. */
  by_month: AdditionalCardsPeriodRow[];
  by_year: AdditionalCardsPeriodRow[];
  totals: {
    charges_clp: number;
    charges_usd: number | null;
    reimbursements_clp: number;
    reimbursements_usd: number | null;
    balance_clp: number;
    balance_usd: number | null;
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
  charges_clp: number;
  charges_usd: number | null;
  charge_count: number;
  reimbursements_clp: number;
  reimbursements_usd: number | null;
  reimbursement_count: number;
};

function emptyBucket(): Bucket {
  return {
    charges_clp: 0,
    charges_usd: 0,
    charge_count: 0,
    reimbursements_clp: 0,
    reimbursements_usd: 0,
    reimbursement_count: 0,
  };
}

/** A line's pesos: every finished line has them (`values.clp`). */
function clpValue(line: AdditionalCardChargeLineInput): number {
  const v = lineValueIn(line, "clp");
  if (v == null) throw new Error(`additional-card line ${line.expense_month} without its pesos`);
  return v;
}

function addUsd(total: number | null, usd: number | null): number | null {
  return total == null || usd == null ? null : total + usd;
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
  let balanceClp = 0;
  let balanceUsd: number | null = 0;
  return [...buckets.keys()].sort().map((period) => {
    const b = buckets.get(period)!;
    const net_clp = b.charges_clp - b.reimbursements_clp;
    const net_usd =
      b.charges_usd == null || b.reimbursements_usd == null
        ? null
        : b.charges_usd - b.reimbursements_usd;
    balanceClp += net_clp;
    balanceUsd = addUsd(balanceUsd, net_usd);
    return {
      period_month: period,
      as_of_date: asOfDate(period),
      charges_clp: b.charges_clp,
      charges_usd: b.charges_usd,
      charge_count: b.charge_count,
      reimbursements_clp: b.reimbursements_clp,
      reimbursements_usd: b.reimbursements_usd,
      reimbursement_count: b.reimbursement_count,
      net_clp,
      net_usd,
      balance_clp: balanceClp,
      balance_usd: balanceUsd,
    };
  });
}

/** Charges and reimbursements, each by its gastos month (a reimbursement's is the day it arrived). */
export function buildAdditionalCardsSummary(lines: readonly AdditionalCardChargeLineInput[]): AdditionalCardsSummary {
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
  for (const line of lines) {
    if (isAdditionalCardChargeLine(line)) {
      const b = touch(line.expense_month);
      b.charges_clp += clpValue(line);
      b.charges_usd = addUsd(b.charges_usd, lineValueIn(line, "usd"));
      b.charge_count += 1;
    } else if (isAdditionalCardReimbursementLine(line)) {
      const b = touch(line.expense_month);
      b.reimbursements_clp -= clpValue(line);
      const usd = lineValueIn(line, "usd");
      b.reimbursements_usd = addUsd(b.reimbursements_usd, usd == null ? null : -usd);
      b.reimbursement_count += 1;
    }
  }

  const byYear = new Map<string, Bucket>();
  for (const [ym, b] of byMonth) {
    const year = `${ym.slice(0, 4)}-12`;
    const y = byYear.get(year) ?? emptyBucket();
    y.charges_clp += b.charges_clp;
    y.charges_usd = addUsd(y.charges_usd, b.charges_usd);
    y.charge_count += b.charge_count;
    y.reimbursements_clp += b.reimbursements_clp;
    y.reimbursements_usd = addUsd(y.reimbursements_usd, b.reimbursements_usd);
    y.reimbursement_count += b.reimbursement_count;
    byYear.set(year, y);
  }

  const by_month = periodRows(byMonth, monthEndIso);
  const by_year = periodRows(byYear, (p) => `${p.slice(0, 4)}-12-31`);
  let charges_clp = 0;
  let charges_usd: number | null = 0;
  let reimbursements_clp = 0;
  let reimbursements_usd: number | null = 0;
  for (const row of by_year) {
    charges_clp += row.charges_clp;
    charges_usd = addUsd(charges_usd, row.charges_usd);
    reimbursements_clp += row.reimbursements_clp;
    reimbursements_usd = addUsd(reimbursements_usd, row.reimbursements_usd);
  }
  return {
    by_month,
    by_year,
    totals: {
      charges_clp,
      charges_usd,
      reimbursements_clp,
      reimbursements_usd,
      balance_clp: charges_clp - reimbursements_clp,
      balance_usd:
        charges_usd == null || reimbursements_usd == null ? null : charges_usd - reimbursements_usd,
    },
  };
}
