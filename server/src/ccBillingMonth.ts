import { db } from "./db.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { addCalendarMonths } from "./ccYearMonth.js";

export type CreditCardBillingConfig = {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
};

const stmtConfig = db.prepare(
  `SELECT billing_cycle_start_day, billing_cycle_end_day
   FROM credit_card_account_config WHERE account_id = ?`
);

const DEFAULT_CONFIG: CreditCardBillingConfig = {
  billing_cycle_start_day: 21,
  billing_cycle_end_day: 20,
};

export function loadCreditCardBillingConfig(accountId: number): CreditCardBillingConfig {
  const row = stmtConfig.get(accountId) as
    | { billing_cycle_start_day: number; billing_cycle_end_day: number | null }
    | undefined;
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    billing_cycle_start_day: row.billing_cycle_start_day ?? 21,
    billing_cycle_end_day: row.billing_cycle_end_day ?? 20,
  };
}

/** Billing month (YYYY-MM) from statement close date (~20th → month of statement). */
export function billingMonthForStatementDate(statementDateIso: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(statementDateIso ?? "").trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

export function billingMonthForStatementDdMmYyyy(statementDate: string): string | null {
  const iso = parseDdMmYyToIso(statementDate);
  if (!iso) return null;
  return billingMonthForStatementDate(iso);
}

/** Inclusive billing period [from, to] ISO dates for a billing month YYYY-MM. */
export function billingPeriodIsoRange(
  billingMonth: string,
  config: CreditCardBillingConfig = DEFAULT_CONFIG
): { period_from: string; period_to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  const startDay = config.billing_cycle_start_day;
  const endDay = config.billing_cycle_end_day ?? 20;
  const prevMo = mo === 1 ? 12 : mo - 1;
  const prevY = mo === 1 ? y - 1 : y;
  const pad = (n: number) => String(n).padStart(2, "0");
  const period_from = `${prevY}-${pad(prevMo)}-${pad(Math.min(startDay, 28))}`;
  const period_to = `${y}-${pad(mo)}-${pad(Math.min(endDay, 28))}`;
  return { period_from, period_to };
}

/**
 * Billing month (YYYY-MM) for a purchase date using cycle boundaries (21→20).
 * Purchases after period_to bill on the next month; before period_from on the previous.
 */
export function billingMonthForPurchaseDate(
  purchaseDateIso: string,
  config?: CreditCardBillingConfig
): string | null {
  const iso = String(purchaseDateIso ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const cfg = config ?? DEFAULT_CONFIG;
  let bm = billingMonthForStatementDate(iso);
  if (!bm) return null;
  const range = billingPeriodIsoRange(bm, cfg);
  if (!range) return bm;
  if (iso > range.period_to) return addCalendarMonths(bm, 1);
  if (iso < range.period_from) return addCalendarMonths(bm, -1);
  return bm;
}
