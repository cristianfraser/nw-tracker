import { DEFAULT_BILLING_CYCLE_END_DAY, type CreditCardBillingConfig } from "./cards/config.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
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

/**
 * Inclusive billing period [from, to] ISO dates for a billing month YYYY-MM, by the config cycle —
 * tentative. It keys the open web-paste buckets (`statementCloseDdMmYyyyForBillingMonth`) and
 * estimates the close of a card with no close on record (`closeEvidenceForBillingMonth`); which
 * facturación a purchase belongs to is `billingMonthContainingPurchase`, from the bank's closes.
 */
export function billingPeriodIsoRange(
  billingMonth: string,
  config: CreditCardBillingConfig
): { period_from: string; period_to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  const startDay = config.billing_cycle_start_day;
  const endDay = config.billing_cycle_end_day ?? DEFAULT_BILLING_CYCLE_END_DAY;
  const prevMo = mo === 1 ? 12 : mo - 1;
  const prevY = mo === 1 ? y - 1 : y;
  const pad = (n: number) => String(n).padStart(2, "0");
  const period_from = `${prevY}-${pad(prevMo)}-${pad(Math.min(startDay, 28))}`;
  const period_to = `${y}-${pad(mo)}-${pad(Math.min(endDay, 28))}`;
  return { period_from, period_to };
}
