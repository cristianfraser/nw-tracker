/**
 * Which facturación a card statement's lines belong to (moved out of `ccOpenWebPastePdfReconcile.ts`
 * so the billing readers and the expense lines reach it without the statement reconcile, which
 * writes annulled purchases and so reaches the expense categories).
 */
import { billingMonthForManualLedgerPurchase, pdfClosedBillingMonthsForAccount } from "./facturacion.js";
import { parseOpenWebPasteBillingMonth } from "../ccOpenWebPasteRepair.js";
import { listCcStatementsForAccount } from "../ccStatementsDb.js";

/**
 * Stale `open|{bm}` web-paste statements: a bucket before the current open month whose month a
 * STATEMENT closed — leftovers the reconcile could not place, attributed to the open month by the
 * read paths. A provisionally closed month's bucket is not stale: until its statement arrives its
 * lines are that month's only evidence (its facturado, the modal lines), so carrying them into
 * the open month would count them twice.
 */
export function listStaleOpenWebPasteStatementDates(
  accountId: number,
  openBillingMonth: string
): string[] {
  const dates: string[] = [];
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  for (const st of listCcStatementsForAccount(accountId)) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm) continue;
    if (bucketBm.localeCompare(openBillingMonth) >= 0) continue;
    if (!pdfClosed.has(bucketBm)) continue;
    dates.push(st.statement_date);
  }
  return dates;
}

/**
 * The facturación each statement's lines belong to, keyed by statement date — the unit every line
 * sum groups by (a facturación's CLP and USD twins share it): the statement's own billing month,
 * except a stale bucket ({@link listStaleOpenWebPasteStatementDates}), whose leftovers belong to the
 * open month. The one rule for «the lines of facturación M»: the open-month facturado and payment
 * sums, the expense lines' `billing_month` and through it the facturación modal all read it. The
 * client used to re-derive it with an older rule (every earlier bucket in every later month, a month
 * «closed» by any one statement), which listed September 2026's bucket under October's modal.
 */
export function facturacionMonthByStatementDate(accountId: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!st.billing_month) continue;
    const prev = out.get(st.statement_date);
    if (prev != null && prev !== st.billing_month) {
      throw new Error(
        `Account ${accountId}: statements dated ${st.statement_date} belong to ${prev} and ${st.billing_month}`
      );
    }
    out.set(st.statement_date, st.billing_month);
  }
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm) {
    for (const date of listStaleOpenWebPasteStatementDates(accountId, openBm)) out.set(date, openBm);
  }
  return out;
}

/** Statement dates whose lines belong to facturación `billingMonth` ({@link facturacionMonthByStatementDate}). */
export function statementDatesForFacturacion(accountId: number, billingMonth: string): string[] {
  const dates: string[] = [];
  for (const [date, bm] of facturacionMonthByStatementDate(accountId)) {
    if (bm === billingMonth) dates.push(date);
  }
  return dates;
}
