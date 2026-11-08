/**
 * The one statement → facturación-month rule (docs/untangle-plan.md F10): a statement belongs to
 * the month its printed period ends in, else the month of its statement date. The three copies
 * (statements, parsed CSV rows, a plan's payment rows) read it here. A leaf (no statement or line
 * reads), so the statement loader can stamp its rows with it.
 */
import { monthKeyFromYmd } from "../calendarMonth.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

function isoFromStatementField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** Billing month (YYYY-MM) from statement close date (~20th → month of statement). */
export function billingMonthForStatementDate(statementDateIso: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(statementDateIso ?? "").trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

/**
 * Facturación month (YYYY-MM) for an imported statement.
 * Prefer `period_to` (cycle end: Mar 21–Apr 20 → April); else statement close/print date.
 */
export function billingMonthForCcStatement(fields: {
  statement_date?: string | null;
  period_to?: string | null;
}): string | null {
  const periodToIso = isoFromStatementField(fields.period_to);
  if (periodToIso) return monthKeyFromYmd(periodToIso);
  const closeIso = isoFromStatementField(fields.statement_date);
  if (closeIso) return billingMonthForStatementDate(closeIso);
  return null;
}

/** YYYY-MM from period_to (preferred) or statement_date on a parsed CSV row: {@link billingMonthForCcStatement}. */
export function statementPeriodMonthFromParsedRow(row: {
  period_to?: string | null;
  statement_date?: string | null;
}): string | null {
  return billingMonthForCcStatement(row);
}

/**
 * Billing month of a ledger payment (its statement's month, not the pay-by): the stored month,
 * else its statement's ({@link billingMonthForCcStatement}), else the pay-by month.
 */
export function paymentStatementMonthYm(p: {
  statement_period_month?: string | null;
  statement_date?: string | null;
  pay_by_date: string;
  period_to_join?: string | null;
}): string | null {
  const stored = String(p.statement_period_month ?? "").trim();
  if (/^\d{4}-\d{2}$/.test(stored)) return stored;
  const fromStatement = billingMonthForCcStatement({ statement_date: p.statement_date, period_to: p.period_to_join });
  if (fromStatement) return fromStatement;
  const pay = String(p.pay_by_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pay)) return monthKeyFromYmd(pay);
  return null;
}
