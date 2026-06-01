import { monthKeyFromYmd } from "./calendarMonth.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

/** YYYY-MM from period_to (preferred) or statement_date on a parsed CSV row. */
export function statementPeriodMonthFromParsedRow(row: {
  period_to?: string | null;
  statement_date?: string | null;
}): string | null {
  const periodToIso = parseDdMmYyToIso(String(row.period_to ?? "").trim());
  if (periodToIso) return monthKeyFromYmd(periodToIso);
  const stmtIso = parseDdMmYyToIso(String(row.statement_date ?? "").trim());
  if (stmtIso) return monthKeyFromYmd(stmtIso);
  return null;
}

/** Resolve billing month for a ledger payment (statement month, not pay-by). */
export function paymentStatementMonthYm(p: {
  statement_period_month?: string | null;
  statement_date?: string | null;
  pay_by_date: string;
  period_to_join?: string | null;
}): string | null {
  const stored = String(p.statement_period_month ?? "").trim();
  if (/^\d{4}-\d{2}$/.test(stored)) return stored;
  const periodToIso = parseDdMmYyToIso(String(p.period_to_join ?? "").trim());
  if (periodToIso) return monthKeyFromYmd(periodToIso);
  const stmtIso = parseDdMmYyToIso(String(p.statement_date ?? "").trim());
  if (stmtIso) return monthKeyFromYmd(stmtIso);
  const pay = String(p.pay_by_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pay)) return monthKeyFromYmd(pay);
  return null;
}
