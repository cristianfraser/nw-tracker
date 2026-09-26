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
import {
  closeEvidenceForBillingMonth,
  ddMmYyyyFromIso,
  type CcCloseSource,
  latestFeedBillingClose,
  nextPeriodStartIsoForBillingMonth,
} from "./ccBillingCloses.js";
import { db } from "./db.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

export function isPdfStatementSource(sourcePdf: string): boolean {
  return !String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

/**
 * True when this account's imported PDF history carries a USD statement stream — closing a
 * facturación then requires the USD twin too. The requirement follows the imported stream,
 * not the card's nominal facilities: a card with a dormant, never-billed USD side keeps
 * closing on CLP alone until its first USD statement lands.
 */
export function accountRequiresUsdStatementClose(accountId: number): boolean {
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.currency === "usd" && isPdfStatementSource(st.source_pdf)) return true;
  }
  return false;
}

/**
 * Latest fully-imported facturación month (YYYY-MM) on this master account. A month only
 * counts as closed once every statement currency the card's PDF history carries is
 * imported for it — CLP always, plus USD when {@link accountRequiresUsdStatementClose}
 * (one twin arriving alone must not advance the open month).
 */
export function lastPdfBillingMonthForAccount(accountId: number): string | null {
  let max: string | null = null;
  for (const bm of pdfClosedBillingMonthsForAccount(accountId)) {
    if (!max || ymCompare(bm, max) > 0) max = bm;
  }
  return max;
}

/** Every facturación month an imported statement closed (same currency rule as above). */
export function pdfClosedBillingMonthsForAccount(accountId: number): Set<string> {
  const requiresUsd = accountRequiresUsdStatementClose(accountId);
  const currenciesByMonth = new Map<string, Set<string>>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!isPdfStatementSource(st.source_pdf)) continue;
    const bm = st.billing_month;
    if (!bm) continue;
    let currencies = currenciesByMonth.get(bm);
    if (!currencies) currenciesByMonth.set(bm, (currencies = new Set()));
    currencies.add(st.currency);
  }
  const closed = new Set<string>();
  for (const [bm, currencies] of currenciesByMonth) {
    if (!currencies.has("clp")) continue;
    if (requiresUsd && !currencies.has("usd")) continue;
    closed.add(bm);
  }
  return closed;
}

/**
 * Latest facturación the BANK has closed: the latest statement-closed month, a later month whose
 * close the card feed observed (SALDO INICIAL — see `ccBillingCloses.ts`), or a later month whose
 * statement-announced next cycle has already started (today on/after its first day). This is what
 * moves the open month forward. It is deliberately not what the installment schedule treats as
 * negative evidence (`lastPdfBillingMonthForAccount`): a close without its statement says nothing
 * about which cuotas it billed.
 */
export function lastClosedBillingMonthForAccount(
  accountId: number,
  todayIso: string = chileCalendarTodayYmd()
): string | null {
  const lastPdf = lastPdfBillingMonthForAccount(accountId);
  const observed = latestFeedBillingClose(accountId)?.billing_month ?? null;
  let last =
    observed && (!lastPdf || ymCompare(observed, lastPdf) > 0) ? observed : lastPdf;
  if (!last) return null;
  // Walk forward through closes the bank announced and whose next cycle is already running.
  // Bounded: an announcement only ever reaches the month after the latest statement.
  const statements = listCcStatementsForAccount(accountId);
  for (let i = 0; i < 3; i++) {
    const candidate = addCalendarMonths(last, 1);
    const next = nextPeriodStartIsoForBillingMonth(accountId, candidate, statements);
    if (next.source === "estimated" || todayIso < next.iso) break;
    last = candidate;
  }
  return last;
}

/**
 * A facturación the bank has closed but whose statement is not imported yet — closed by the
 * feed's SALDO INICIAL (billed total known) or by its announced close passing (total still the
 * app's estimate). Line detail is pending either way; the statement supersedes it.
 */
export function isProvisionallyClosedBillingMonth(accountId: number, billingMonth: string): boolean {
  return provisionallyClosedBillingMonthsForAccount(accountId).has(billingMonth);
}

/** Every provisionally closed month: after the latest statement close, up to the bank's latest. */
export function provisionallyClosedBillingMonthsForAccount(accountId: number): Set<string> {
  const out = new Set<string>();
  const lastClosed = lastClosedBillingMonthForAccount(accountId);
  if (!lastClosed) return out;
  const lastPdf = lastPdfBillingMonthForAccount(accountId);
  let bm = lastPdf ? addCalendarMonths(lastPdf, 1) : lastClosed;
  while (ymCompare(bm, lastClosed) <= 0) {
    out.add(bm);
    bm = addCalendarMonths(bm, 1);
  }
  return out;
}

/**
 * Facturación month whose cycle contains a purchase dated `purchaseIso`. A cycle runs from the
 * first day after the previous facturación's close up to (not including) the first day after its
 * own — `nextPeriodStartIsoForBillingMonth`, so statement, feed and announced closes and the
 * issuer's close-day rule all apply (a Santander purchase ON the close day belongs to the next
 * cycle). Months whose close is only the config estimate fall back to the config cycle.
 */
export function billingMonthContainingPurchase(accountId: number, purchaseIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseIso)) {
    throw new Error(`billingMonthContainingPurchase: bad date "${purchaseIso}"`);
  }
  const statements = listCcStatementsForAccount(accountId);
  let bm = purchaseIso.slice(0, 7);
  for (let i = 0; i < 4; i++) {
    const cycleStart = nextPeriodStartIsoForBillingMonth(accountId, addCalendarMonths(bm, -1), statements).iso;
    if (purchaseIso < cycleStart) {
      bm = addCalendarMonths(bm, -1);
      continue;
    }
    const nextCycleStart = nextPeriodStartIsoForBillingMonth(accountId, bm, statements).iso;
    if (purchaseIso >= nextCycleStart) {
      bm = addCalendarMonths(bm, 1);
      continue;
    }
    return bm;
  }
  throw new Error(`Account ${accountId}: no billing cycle contains ${purchaseIso} (close evidence overlaps)`);
}

/**
 * Close date (ISO) of a billing month from the best evidence: its statement's period end, the
 * feed-observed close, the close the previous statement announced, or the config estimate.
 */
export function periodToIsoForBillingMonth(
  accountId: number,
  billingMonth: string
): string | null {
  return closeEvidenceForBillingMonth(accountId, billingMonth).close_iso;
}

/**
 * Billing month for manual imports (web paste): current open period = month after the last
 * facturación the bank closed (statement or feed-observed), or the current calendar billing
 * month when already past that.
 */
export function targetBillingMonthForManualImports(
  accountId: number,
  cardLast4: string
): string {
  const todayIso = chileCalendarTodayYmd();
  const currentBm =
    billingMonthForStatementDate(todayIso) ??
    todayIso.slice(0, 7);
  const lastClosed = lastClosedBillingMonthForAccount(accountId);
  if (!lastClosed) return currentBm;
  const nextAfterClosed = addCalendarMonths(lastClosed, 1);
  return ymCompare(currentBm, nextAfterClosed) >= 0 ? currentBm : nextAfterClosed;
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

/**
 * The `statement_date` an open web-paste bucket is keyed by: the config cycle's close for the
 * month. It is an IDENTITY, not the displayed close — `cc_statements` is unique on
 * (source, statement_date) and several sums group lines by statement date, so a bucket must not
 * move onto the real close (it would share its date with the incoming statement). What the app
 * shows as the close comes from {@link closeDateForBillingMonth}.
 */
export function statementCloseDdMmYyyyForBillingMonth(
  accountId: number,
  billingMonth: string
): string {
  const config = loadCreditCardBillingConfig(accountId);
  const range = billingPeriodIsoRange(billingMonth, config);
  const iso = range?.period_to ?? `${billingMonth}-20`;
  return ddMmYyyyFromIso(iso);
}

/**
 * Displayed close of a billing month, with where it came from — the statement, the feed's
 * SALDO INICIAL, the previous statement's announced next period, or (`estimated`) the config
 * cycle when the bank has published nothing yet.
 */
export function closeDateForBillingMonth(
  accountId: number,
  billingMonth: string
): { close_iso: string; close_ddmmyyyy: string; source: CcCloseSource } {
  const ev = closeEvidenceForBillingMonth(accountId, billingMonth);
  return { close_iso: ev.close_iso, close_ddmmyyyy: ddMmYyyyFromIso(ev.close_iso), source: ev.source };
}

