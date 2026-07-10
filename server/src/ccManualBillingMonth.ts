import {
  billingMonthForPurchaseDate,
  billingMonthForStatementDate,
  billingPeriodIsoRange,
  loadCreditCardBillingConfig,
  type CreditCardBillingConfig,
} from "./ccBillingMonth.js";
import { ymCompare } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

export function isPdfStatementSource(sourcePdf: string): boolean {
  return !String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

function isoFromPeriodField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** Latest billing month (YYYY-MM) with an imported PDF statement on this master account. */
export function lastPdfBillingMonthForAccount(accountId: number): string | null {
  let max: string | null = null;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!isPdfStatementSource(st.source_pdf)) continue;
    const bm = st.billing_month;
    if (!bm) continue;
    if (!max || ymCompare(bm, max) > 0) max = bm;
  }
  return max;
}

/** Inclusive period end (ISO) for a billing month — PDF `period_to` when present, else config cycle. */
export function periodToIsoForBillingMonth(
  accountId: number,
  billingMonth: string
): string | null {
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (!isPdfStatementSource(st.source_pdf)) continue;
    const iso = isoFromPeriodField(st.period_to);
    if (iso) return iso;
  }
  const config = loadCreditCardBillingConfig(accountId);
  return billingPeriodIsoRange(billingMonth, config)?.period_to ?? null;
}

/**
 * Billing month for manual imports (web paste): current open period = month after the last
 * PDF facturación, or the current calendar billing month when already past that.
 */
export function targetBillingMonthForManualImports(
  accountId: number,
  cardLast4: string
): string {
  const todayIso = chileCalendarTodayYmd();
  const currentBm =
    billingMonthForStatementDate(todayIso) ??
    todayIso.slice(0, 7);
  const lastPdf = lastPdfBillingMonthForAccount(accountId);
  if (!lastPdf) return currentBm;
  const nextAfterPdf = addCalendarMonths(lastPdf, 1);
  return ymCompare(currentBm, nextAfterPdf) >= 0 ? currentBm : nextAfterPdf;
}

/** Card last4 for a credit-card master account (`credit_card_account_config.card_last4` —
 * the card identity; a master without a config row is a data problem). */
export function cardLast4ForCreditCardAccount(accountId: number): string | null {
  const row = db
    .prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { card_last4: string | null } | undefined;
  const fromConfig = String(row?.card_last4 ?? "").trim();
  return fromConfig || null;
}

/** Open facturación month for manually entered ledger purchases (ignores purchase date). */
export function billingMonthForManualLedgerPurchase(accountId: number): string | null {
  const cardLast4 = cardLast4ForCreditCardAccount(accountId);
  if (!cardLast4) return null;
  return targetBillingMonthForManualImports(accountId, cardLast4);
}

/**
 * Billing month for a ledger purchase when projecting facturado.
 * Manual entries → open facturación; PDF entries → purchase-date cycle (21→20).
 */
export function billingMonthForLedgerPurchase(
  accountId: number,
  purchase: { purchase_date: string; source: string },
  config?: CreditCardBillingConfig
): string | null {
  if (purchase.source === "manual") {
    return billingMonthForManualLedgerPurchase(accountId);
  }
  const cfg = config ?? loadCreditCardBillingConfig(accountId);
  return billingMonthForPurchaseDate(purchase.purchase_date, cfg);
}

/** Statement close date (DD/MM/YYYY) for a billing month — matches PDF estado de cuenta. */
export function statementCloseDdMmYyyyForBillingMonth(
  accountId: number,
  billingMonth: string
): string {
  const config = loadCreditCardBillingConfig(accountId);
  const range = billingPeriodIsoRange(billingMonth, config);
  const iso = range?.period_to ?? `${billingMonth}-20`;
  const [y, mo, d] = iso.split("-");
  const pad = (n: string) => n.padStart(2, "0");
  return `${pad(d!)}/${pad(mo!)}/${y}`;
}

export function statementCloseIsoForBillingMonth(
  accountId: number,
  billingMonth: string
): string {
  const ddMm = statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth);
  return parseDdMmYyToIso(ddMm) ?? `${billingMonth}-20`;
}
